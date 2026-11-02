import { readFileSync } from 'fs'

/**
 * Enough of NetCDF classic (CDF-1 and CDF-2) to read a latitude/longitude elevation grid
 * such as the EMODnet DTM, held whole in memory (a sample's area is a few megabytes).
 */
const NC_DIMENSION = 10
const NC_VARIABLE = 11
const NC_ATTRIBUTE = 12
const NC_TYPE_SIZE: Record<number, number> = {
  1: 1,
  2: 1,
  3: 2,
  4: 4,
  5: 4,
  6: 8
}
const NC_SHORT = 3
const NC_INT = 4
const NC_FLOAT = 5
const NC_DOUBLE = 6

interface Variable {
  name: string
  dims: number[]
  type: number
  begin: number
  attributes: Record<string, number[] | string>
}

class Reader {
  p = 0
  constructor(
    readonly buf: Buffer,
    readonly offset64: boolean
  ) {}
  int(): number {
    const v = this.buf.readInt32BE(this.p)
    this.p += 4
    return v
  }
  offset(): number {
    if (!this.offset64) return this.int()
    const v = Number(this.buf.readBigInt64BE(this.p))
    this.p += 8
    return v
  }
  name(): string {
    const length = this.int()
    const s = this.buf.toString('utf8', this.p, this.p + length)
    this.p += Math.ceil(length / 4) * 4
    return s
  }
  values(type: number, count: number): number[] | string {
    const size = NC_TYPE_SIZE[type]
    const start = this.p
    this.p += Math.ceil((size * count) / 4) * 4
    if (type === 2) return this.buf.toString('utf8', start, start + count)
    return readTyped(this.buf, start, type, count)
  }
  attributes(): Record<string, number[] | string> {
    const tag = this.int()
    const count = this.int()
    if (tag !== 0 && tag !== NC_ATTRIBUTE)
      throw new Error('NetCDF: bad attribute list')
    const out: Record<string, number[] | string> = {}
    for (let i = 0; i < count; i++) {
      const name = this.name()
      const type = this.int()
      out[name] = this.values(type, this.int())
    }
    return out
  }
}

function readTyped(
  buf: Buffer,
  start: number,
  type: number,
  count: number
): number[] {
  const out: number[] = new Array(count)
  for (let i = 0; i < count; i++) {
    switch (type) {
      case NC_SHORT:
        out[i] = buf.readInt16BE(start + i * 2)
        break
      case NC_INT:
        out[i] = buf.readInt32BE(start + i * 4)
        break
      case NC_FLOAT:
        out[i] = buf.readFloatBE(start + i * 4)
        break
      case NC_DOUBLE:
        out[i] = buf.readDoubleBE(start + i * 8)
        break
      default:
        out[i] = buf.readInt8(start + i)
    }
  }
  return out
}

export class NetcdfGrid {
  readonly resolutionM: number
  private readonly lat: number[]
  private readonly lon: number[]
  private readonly values: Float32Array
  private readonly fill?: number

  constructor(
    readonly path: string,
    variable = 'elevation'
  ) {
    const buf = readFileSync(path)
    if (buf.toString('latin1', 0, 3) !== 'CDF')
      throw new Error(`${path}: not NetCDF classic`)
    const r = new Reader(buf, buf[3] === 2)
    r.p = 4
    r.int() // numrecs
    const dims: number[] = []
    const dimTag = r.int()
    const dimCount = r.int()
    if (dimTag !== 0 && dimTag !== NC_DIMENSION)
      throw new Error(`${path}: bad dimension list`)
    for (let i = 0; i < dimCount; i++) {
      r.name()
      dims.push(r.int())
    }
    r.attributes()
    const varTag = r.int()
    const varCount = r.int()
    if (varTag !== 0 && varTag !== NC_VARIABLE)
      throw new Error(`${path}: bad variable list`)
    const vars = new Map<string, Variable>()
    for (let i = 0; i < varCount; i++) {
      const name = r.name()
      const rank = r.int()
      const ids: number[] = []
      for (let k = 0; k < rank; k++) ids.push(r.int())
      const attributes = r.attributes()
      const type = r.int()
      r.int() // vsize
      vars.set(name, {
        name,
        dims: ids.map((d) => dims[d]),
        type,
        begin: r.offset(),
        attributes
      })
    }
    const read = (name: string) => {
      const v = vars.get(name)
      if (!v) throw new Error(`${path}: no variable ${name}`)
      return {
        v,
        data: readTyped(
          buf,
          v.begin,
          v.type,
          v.dims.reduce((a, b) => a * b, 1)
        )
      }
    }
    this.lat = read('latitude').data
    this.lon = read('longitude').data
    const grid = read(variable)
    this.values = Float32Array.from(grid.data)
    const fill = grid.v.attributes._FillValue
    if (Array.isArray(fill)) this.fill = fill[0]
    this.resolutionM = Math.abs(this.lat[1] - this.lat[0]) * 111320
  }

  private nearest(axis: number[], value: number): number {
    const step = axis[1] - axis[0]
    const i = Math.round((value - axis[0]) / step)
    return i >= 0 && i < axis.length ? i : -1
  }

  elevation(lat: number, lon: number): number | undefined {
    const i = this.nearest(this.lat, lat)
    const j = this.nearest(this.lon, lon)
    if (i < 0 || j < 0) return undefined
    const value = this.values[i * this.lon.length + j]
    if (Number.isNaN(value) || value === this.fill) return undefined
    return value
  }
}
