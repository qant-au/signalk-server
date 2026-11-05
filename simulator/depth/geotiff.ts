import { closeSync, openSync, readSync } from 'fs'
import { inflateSync } from 'zlib'
import { latLonToUtm } from './utm'

/**
 * Enough of GeoTIFF to read elevation from the depth grids the samples use: classic TIFF
 * or BigTIFF, tiled, DEFLATE-compressed 32-bit floats, in geographic coordinates
 * (Geoscience Australia) or UTM (NOAA BlueTopo, whose first band is elevation). Tiles are
 * read on demand and a few are kept, so a gigabyte grid costs only the tiles a route
 * touches.
 */
const TAG = {
  imageWidth: 256,
  imageLength: 257,
  bitsPerSample: 258,
  compression: 259,
  samplesPerPixel: 277,
  planarConfiguration: 284,
  predictor: 317,
  tileWidth: 322,
  tileLength: 323,
  tileOffsets: 324,
  tileByteCounts: 325,
  sampleFormat: 339,
  modelPixelScale: 33550,
  modelTiepoint: 33922,
  geoKeyDirectory: 34735,
  gdalNoData: 42113
}
const TYPE_SIZE: Record<number, number> = {
  1: 1,
  2: 1,
  3: 2,
  4: 4,
  5: 8,
  11: 4,
  12: 8,
  16: 8
}
const TIFF_CLASSIC = 42
const TIFF_BIG = 43
const COMPRESSION_DEFLATE = [8, 32946]
const SAMPLE_FORMAT_FLOAT = 3
const KEY_GEOGRAPHIC_TYPE = 2048
const KEY_PROJECTED_CS_TYPE = 3072
const USER_DEFINED = 32767
const GEOGRAPHIC_SYSTEMS = [4326, 4283, 4269]
const METRES_PER_DEGREE = 111320
const MAX_CACHED_TILES = 64

interface Entry {
  type: number
  count: number
  /** file offset of the entry's value field */
  valueOffset: number
}

interface Layout {
  little: boolean
  /** BigTIFF: 8-byte offsets and counts, 20-byte directory entries */
  big: boolean
}

function readUInt(
  buf: Buffer,
  at: number,
  bytes: number,
  little: boolean
): number {
  if (bytes === 2) return little ? buf.readUInt16LE(at) : buf.readUInt16BE(at)
  if (bytes === 4) return little ? buf.readUInt32LE(at) : buf.readUInt32BE(at)
  return Number(little ? buf.readBigUInt64LE(at) : buf.readBigUInt64BE(at))
}

function readEntries(
  fd: number,
  offset: number,
  l: Layout
): Map<number, Entry> {
  const countBytes = l.big ? 8 : 2
  const entryBytes = l.big ? 20 : 12
  const fieldBytes = l.big ? 8 : 4
  const countBuf = Buffer.alloc(countBytes)
  readSync(fd, countBuf, 0, countBytes, offset)
  const count = readUInt(countBuf, 0, countBytes, l.little)
  const buf = Buffer.alloc(count * entryBytes)
  readSync(fd, buf, 0, buf.length, offset + countBytes)
  const entries = new Map<number, Entry>()
  for (let i = 0; i < count; i++) {
    const p = i * entryBytes
    entries.set(readUInt(buf, p, 2, l.little), {
      type: readUInt(buf, p + 2, 2, l.little),
      count: readUInt(buf, p + 4, fieldBytes, l.little),
      valueOffset: offset + countBytes + p + 4 + fieldBytes
    })
  }
  return entries
}

/** where an entry's data is: inline in its value field, or at the offset stored there */
function dataOffset(fd: number, entry: Entry, l: Layout): number {
  const fieldBytes = l.big ? 8 : 4
  if ((TYPE_SIZE[entry.type] ?? 1) * entry.count <= fieldBytes) {
    return entry.valueOffset
  }
  const ptr = Buffer.alloc(fieldBytes)
  readSync(fd, ptr, 0, fieldBytes, entry.valueOffset)
  return readUInt(ptr, 0, fieldBytes, l.little)
}

function readValues(fd: number, entry: Entry, l: Layout): number[] {
  const width = TYPE_SIZE[entry.type] ?? 1
  const buf = Buffer.alloc(width * entry.count)
  readSync(fd, buf, 0, buf.length, dataOffset(fd, entry, l))
  const values: number[] = []
  for (let i = 0; i < entry.count; i++) {
    const at = i * width
    switch (entry.type) {
      case 3:
        values.push(readUInt(buf, at, 2, l.little))
        break
      case 4:
        values.push(readUInt(buf, at, 4, l.little))
        break
      case 16:
        values.push(readUInt(buf, at, 8, l.little))
        break
      case 12:
        values.push(l.little ? buf.readDoubleLE(at) : buf.readDoubleBE(at))
        break
      default:
        values.push(buf[at])
    }
  }
  return values
}

function readText(fd: number, entry: Entry, l: Layout): string {
  const buf = Buffer.alloc(entry.count)
  readSync(fd, buf, 0, buf.length, dataOffset(fd, entry, l))
  return buf.toString('latin1').split('\0').join('').trim()
}

export class GeoTiffGrid {
  readonly width: number
  readonly height: number
  /** grid spacing in metres, roughly, for choosing a routing cell size */
  readonly resolutionM: number
  private readonly fd: number
  private readonly layout: Layout
  private readonly tileWidth: number
  private readonly tileLength: number
  private readonly samples: number
  private readonly offsets: number[]
  private readonly byteCounts: number[]
  private readonly originX: number
  private readonly originY: number
  private readonly scaleX: number
  private readonly scaleY: number
  private readonly noData?: number
  private readonly utmZone?: number
  private readonly utmSouth: boolean = false
  private readonly tiles = new Map<number, Float32Array | null>()

  constructor(readonly path: string) {
    this.fd = openSync(path, 'r')
    const head = Buffer.alloc(16)
    readSync(this.fd, head, 0, 16, 0)
    const little = head.toString('latin1', 0, 2) === 'II'
    const version = readUInt(head, 2, 2, little)
    if (version !== TIFF_CLASSIC && version !== TIFF_BIG) {
      throw new Error(`${path}: not a TIFF`)
    }
    this.layout = { little, big: version === TIFF_BIG }
    const ifd = this.layout.big
      ? readUInt(head, 8, 8, little)
      : readUInt(head, 4, 4, little)
    const entries = readEntries(this.fd, ifd, this.layout)
    const all = (tag: number) => {
      const e = entries.get(tag)
      return e ? readValues(this.fd, e, this.layout) : []
    }
    const one = (tag: number): number | undefined => all(tag)[0]

    this.width = one(TAG.imageWidth)!
    this.height = one(TAG.imageLength)!
    this.tileWidth = one(TAG.tileWidth) ?? 0
    this.tileLength = one(TAG.tileLength) ?? 0
    this.samples = one(TAG.samplesPerPixel) ?? 1
    if (!this.tileWidth) {
      throw new Error(`${path}: only tiled GeoTIFFs are supported`)
    }
    if (!COMPRESSION_DEFLATE.includes(one(TAG.compression) ?? 0)) {
      throw new Error(`${path}: only DEFLATE compression is supported`)
    }
    if (
      (one(TAG.sampleFormat) ?? 1) !== SAMPLE_FORMAT_FLOAT ||
      one(TAG.bitsPerSample) !== 32
    ) {
      throw new Error(`${path}: only 32-bit float grids are supported`)
    }
    if (
      (one(TAG.predictor) ?? 1) !== 1 ||
      (one(TAG.planarConfiguration) ?? 1) !== 1
    ) {
      throw new Error(
        `${path}: predictors and separate planes are not supported`
      )
    }
    this.offsets = all(TAG.tileOffsets)
    this.byteCounts = all(TAG.tileByteCounts)
    const tie = all(TAG.modelTiepoint)
    const scale = all(TAG.modelPixelScale)
    this.originX = tie[3]
    this.originY = tie[4]
    this.scaleX = scale[0]
    this.scaleY = scale[1]

    const noDataEntry = entries.get(TAG.gdalNoData)
    if (noDataEntry) {
      const text = readText(this.fd, noDataEntry, this.layout)
      const value = Number(text)
      if (text && !Number.isNaN(value)) this.noData = value
    }

    const keys = all(TAG.geoKeyDirectory)
    let projected: number | undefined
    let geographic: number | undefined
    for (let k = 4; k + 3 < keys.length; k += 4) {
      if (keys[k] === KEY_PROJECTED_CS_TYPE) projected = keys[k + 3]
      if (keys[k] === KEY_GEOGRAPHIC_TYPE) geographic = keys[k + 3]
    }
    if (projected !== undefined && projected !== USER_DEFINED) {
      // EPSG 269zz (NAD83 UTM north), 326zz (WGS84 UTM north), 327zz (WGS84 UTM south)
      const nad83 = projected >= 26901 && projected <= 26923
      const wgs84 = projected >= 32601 && projected <= 32760
      if (!nad83 && !wgs84) {
        throw new Error(`${path}: unsupported projection EPSG ${projected}`)
      }
      this.utmZone = projected % 100
      this.utmSouth = projected >= 32701
      this.resolutionM = this.scaleX
    } else {
      if (
        geographic !== undefined &&
        !GEOGRAPHIC_SYSTEMS.includes(geographic)
      ) {
        throw new Error(
          `${path}: unsupported geographic system EPSG ${geographic}`
        )
      }
      this.resolutionM = this.scaleX * METRES_PER_DEGREE
    }
  }

  private tile(index: number): Float32Array | null {
    const cached = this.tiles.get(index)
    if (cached !== undefined) return cached
    let data: Float32Array | null = null
    const length = this.byteCounts[index]
    if (length) {
      const raw = Buffer.alloc(length)
      readSync(this.fd, raw, 0, length, this.offsets[index])
      const plain = inflateSync(raw)
      data = new Float32Array(plain.length / 4)
      for (let i = 0; i < data.length; i++) {
        data[i] = this.layout.little
          ? plain.readFloatLE(i * 4)
          : plain.readFloatBE(i * 4)
      }
    }
    if (this.tiles.size >= MAX_CACHED_TILES) {
      this.tiles.delete(this.tiles.keys().next().value!)
    }
    this.tiles.set(index, data)
    return data
  }

  /** metres, negative below the surface; undefined outside the grid or where it has no data */
  elevation(lat: number, lon: number): number | undefined {
    let x = lon
    let y = lat
    if (this.utmZone !== undefined) {
      const utm = latLonToUtm(lat, lon, this.utmZone, this.utmSouth)
      x = utm.easting
      y = utm.northing
    }
    const col = Math.floor((x - this.originX) / this.scaleX)
    const row = Math.floor((this.originY - y) / this.scaleY)
    if (col < 0 || row < 0 || col >= this.width || row >= this.height) {
      return undefined
    }
    const tilesAcross = Math.ceil(this.width / this.tileWidth)
    const data = this.tile(
      Math.floor(row / this.tileLength) * tilesAcross +
        Math.floor(col / this.tileWidth)
    )
    if (!data) return undefined
    const value =
      data[
        ((row % this.tileLength) * this.tileWidth + (col % this.tileWidth)) *
          this.samples
      ]
    if (Number.isNaN(value) || value === this.noData) return undefined
    return value
  }

  close(): void {
    closeSync(this.fd)
  }
}
