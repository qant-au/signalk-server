import { expect } from 'chai'
import { mkdtempSync, writeFileSync } from 'fs'
import { rm } from 'fs/promises'
import os from 'os'
import path from 'path'
import { deflateSync } from 'zlib'
import { AisReport } from '../simulator/ais/targets'
import { DepthModel } from '../simulator/depth/depth'
import { GeoTiffGrid } from '../simulator/depth/geotiff'
import { NetcdfGrid } from '../simulator/depth/netcdf'
import { latLonToUtm } from '../simulator/depth/utm'
import { Simulation } from '../simulator/engine/simulation'
import { Scenario } from '../simulator/engine/scenario'
import { Traffic } from '../simulator/engine/traffic'
import { DepthCheck, adjustRoute } from '../simulator/routes/adjust'
import { Route, routeLegs } from '../simulator/routes/route'

/** A one-tile, little-endian, DEFLATE float32 GeoTIFF in WGS84 degrees. */
function makeGeoTiff(
  values: number[][],
  x0: number,
  y0: number,
  step: number
): Buffer {
  const height = values.length
  const width = values[0].length
  const pixels = Buffer.alloc(width * height * 4)
  values.flat().forEach((v, i) => pixels.writeFloatLE(v, i * 4))
  const tile = deflateSync(pixels)
  const doubles = (xs: number[]) => {
    const b = Buffer.alloc(xs.length * 8)
    xs.forEach((x, i) => b.writeDoubleLE(x, i * 8))
    return b
  }
  const tiepoint = doubles([0, 0, 0, x0, y0, 0])
  const scale = doubles([step, step, 0])
  const geokeys = Buffer.alloc(4 * 4 * 2)
  ;[1, 1, 0, 1, 2048, 0, 1, 4326].forEach((v, i) =>
    geokeys.writeUInt16LE(v, i * 2)
  )
  const noData = Buffer.from('-9999\0')

  // layout: header, IFD, then the out-of-line values
  const entries: [number, number, number, number | Buffer][] = [
    [256, 3, 1, width],
    [257, 3, 1, height],
    [258, 3, 1, 32],
    [259, 3, 1, 8],
    [277, 3, 1, 1],
    [322, 3, 1, width],
    [323, 3, 1, height],
    [324, 4, 1, 0], // tile offset, patched below
    [325, 4, 1, tile.length],
    [339, 3, 1, 3],
    [33550, 12, 3, scale],
    [33922, 12, 6, tiepoint],
    [34735, 3, 8, geokeys.subarray(0, 16)],
    [42113, 2, noData.length, noData]
  ]
  const ifdOffset = 8
  const ifdSize = 2 + entries.length * 12 + 4
  let extra = ifdOffset + ifdSize
  const blobs: Buffer[] = []
  const ifd = Buffer.alloc(ifdSize)
  ifd.writeUInt16LE(entries.length, 0)
  entries.forEach(([tag, type, count, value], i) => {
    const p = 2 + i * 12
    ifd.writeUInt16LE(tag, p)
    ifd.writeUInt16LE(type, p + 2)
    ifd.writeUInt32LE(count, p + 4)
    if (Buffer.isBuffer(value) && value.length > 4) {
      ifd.writeUInt32LE(extra, p + 8)
      blobs.push(value)
      extra += value.length
    } else if (Buffer.isBuffer(value)) {
      value.copy(ifd, p + 8)
    } else if (type === 3) {
      ifd.writeUInt16LE(value, p + 8)
    } else {
      ifd.writeUInt32LE(value, p + 8)
    }
  })
  const tileOffset = extra
  ifd.writeUInt32LE(tileOffset, 2 + 7 * 12 + 8)
  const head = Buffer.from([0x49, 0x49, 42, 0, ifdOffset, 0, 0, 0])
  return Buffer.concat([head, ifd, ...blobs, tile])
}

/** A NetCDF classic file with latitude, longitude and a float elevation grid. */
function makeNetcdf(
  lat: number[],
  lon: number[],
  elevation: number[][]
): Buffer {
  const name = (s: string) => {
    const b = Buffer.alloc(4 + Math.ceil(s.length / 4) * 4)
    b.writeInt32BE(s.length, 0)
    b.write(s, 4)
    return b
  }
  const int = (n: number) => {
    const b = Buffer.alloc(4)
    b.writeInt32BE(n, 0)
    return b
  }
  const dims = Buffer.concat([
    int(10),
    int(2),
    name('latitude'),
    int(lat.length),
    name('longitude'),
    int(lon.length)
  ])
  const absent = Buffer.concat([int(0), int(0)])
  const vars = [
    { n: 'latitude', ids: [0], type: 6, data: lat, size: 8 },
    { n: 'longitude', ids: [1], type: 6, data: lon, size: 8 },
    { n: 'elevation', ids: [0, 1], type: 5, data: elevation.flat(), size: 4 }
  ]
  const varHeader = (begin: number[]) =>
    Buffer.concat([
      int(11),
      int(vars.length),
      ...vars.map((v, i) =>
        Buffer.concat([
          name(v.n),
          int(v.ids.length),
          ...v.ids.map(int),
          absent,
          int(v.type),
          int(v.data.length * v.size),
          int(begin[i])
        ])
      )
    ])
  const headLength =
    8 + dims.length + absent.length + varHeader([0, 0, 0]).length
  const begins: number[] = []
  let at = headLength
  for (const v of vars) {
    begins.push(at)
    at += v.data.length * v.size
  }
  const data = vars.map((v) => {
    const b = Buffer.alloc(v.data.length * v.size)
    v.data.forEach((x, i) =>
      v.size === 8 ? b.writeDoubleBE(x, i * 8) : b.writeFloatBE(x, i * 4)
    )
    return b
  })
  return Buffer.concat([
    Buffer.from('CDF\x01'),
    int(0),
    dims,
    absent,
    varHeader(begins),
    ...data
  ])
}

function route(waypoints: Route['waypoints']): Route {
  return {
    name: 'test',
    departure: '2024-01-01T00:00:00Z',
    vessel: { description: '12 m yacht', lengthM: 12, draftM: 2, typeCode: 36 },
    source: 'test',
    waypoints
  }
}

describe('simulator engine', () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(path.join(os.tmpdir(), 'sk-sim-'))
  })
  afterEach(async () => rm(dir, { recursive: true, force: true }))

  describe('depth grids', () => {
    it('projects to UTM like the published reference values', () => {
      const onMeridian = latLonToUtm(45, -81, 17)
      expect(onMeridian.easting).to.be.closeTo(500000, 0.01)
      expect(onMeridian.northing).to.be.closeTo(4982950.4, 0.5)
      expect(latLonToUtm(0, -81, 17).northing).to.be.closeTo(0, 0.01)
      // on the central meridian: 10,000,000 m less 0.9996 x the WGS84 meridian arc to 30 degrees (3,320,113.4 m)
      expect(latLonToUtm(-30, 153, 56, true).northing).to.be.closeTo(
        10000000 - 0.9996 * 3320113.4,
        1
      )
    })

    it('reads a tiled DEFLATE GeoTIFF, with no-data as undefined', () => {
      const file = path.join(dir, 'grid.tif')
      writeFileSync(
        file,
        makeGeoTiff(
          [
            [-1, -2, -3, -4],
            [-5, -6, -9999, 5],
            [-9, -10, -11, -12],
            [-13, -14, -15, -16]
          ],
          150,
          -20,
          0.01
        )
      )
      const grid = new GeoTiffGrid(file)
      expect(grid.elevation(-20.005, 150.005)).to.equal(-1)
      expect(grid.elevation(-20.015, 150.035)).to.equal(5)
      expect(grid.elevation(-20.015, 150.025)).to.equal(undefined)
      expect(grid.elevation(-20.035, 150.035)).to.equal(-16)
      expect(grid.elevation(-19.99, 150.005)).to.equal(undefined)
      expect(grid.resolutionM).to.be.closeTo(1113, 1)
      grid.close()
    })

    it('reads a NetCDF elevation grid by nearest cell', () => {
      const file = path.join(dir, 'grid.nc')
      writeFileSync(
        file,
        makeNetcdf(
          [37.0, 37.01],
          [23.0, 23.01, 23.02],
          [
            [-10, -20, NaN],
            [-30, 4, -50]
          ]
        )
      )
      const grid = new NetcdfGrid(file)
      expect(grid.elevation(37.0, 23.0)).to.equal(-10)
      expect(grid.elevation(37.011, 23.019)).to.equal(-50)
      expect(grid.elevation(37.0, 23.02)).to.equal(undefined)
      expect(grid.elevation(36.9, 23.0)).to.equal(undefined)
    })
  })

  describe('route adjustment', () => {
    // 10 m of water everywhere except an island across the direct line
    const island = {
      elevation: (lat: number, lon: number) =>
        lat > 0.004 && lat < 0.006 && lon > -0.004 && lon < 0.004 ? 2 : -10,
      depth(lat: number, lon: number) {
        const e = this.elevation(lat, lon)
        return e < 0 ? -e : undefined
      }
    }
    const options = {
      minDepthM: 3,
      cellM: 20,
      harbourRadiusM: 0,
      harbourNoDataIsWater: false
    }

    it('leaves a clear route alone', () => {
      const r = route([
        { lat: 0, lon: 0.01, speedKn: 5 },
        { lat: 0.01, lon: 0.01 }
      ])
      const result = adjustRoute(r, island, options)
      expect(result.adjustments).to.deep.equal([])
      expect(result.route.waypoints).to.have.length(2)
    })

    it('routes round land and keeps the leg speed', () => {
      const r = route([
        { lat: 0, lon: 0, speedKn: 5 },
        { lat: 0.01, lon: 0 }
      ])
      const result = adjustRoute(r, island, options)
      expect(result.adjustments[0]).to.include({
        resolved: true,
        shallowestM: undefined
      })
      const w = result.route.waypoints
      expect(w.length).to.be.greaterThan(2)
      const check = new DepthCheck(island, options, [w[0], w[w.length - 1]])
      for (let i = 0; i < w.length - 1; i++) {
        expect(check.clear(w[i], w[i + 1]), `leg ${i + 1}`).to.equal(true)
        expect(w[i].speedKn).to.equal(5)
      }
      const added = routeLegs(result.route).reduce(
        (a, l) => a + l.distanceNm,
        0
      )
      expect(added).to.be.greaterThan(0.6).and.lessThan(1.2)
    })

    it('lets a berth sit in shallow water inside the harbour radius, never on dry land', () => {
      const shallowHarbour = {
        elevation: (lat: number) => (lat < 0.002 ? -1 : -10),
        depth(lat: number) {
          return -this.elevation(lat)
        }
      }
      const r = route([
        { lat: 0, lon: 0, speedKn: 3 },
        { lat: 0.01, lon: 0 }
      ])
      const strict = new DepthCheck(shallowHarbour, options, [r.waypoints[0]])
      expect(strict.safe({ lat: 0.001, lon: 0 })).to.equal(false)
      const relaxed = new DepthCheck(
        shallowHarbour,
        { ...options, harbourRadiusM: 300 },
        [r.waypoints[0]]
      )
      expect(relaxed.safe({ lat: 0.001, lon: 0 })).to.equal(true)
      const withLand = new DepthCheck(
        island,
        { ...options, harbourRadiusM: 2000 },
        [r.waypoints[0]]
      )
      expect(withLand.safe({ lat: 0.005, lon: 0 })).to.equal(false)
    })
  })

  describe('traffic', () => {
    const reports = (id: string, lat: number): AisReport[] =>
      [0, 60, 120].map((s) => ({
        id,
        timeMs: s * 1000,
        lat,
        lon: 0,
        sogKn: 10,
        cogDeg: 0,
        target: { typeCode: 70, lengthM: 200 }
      }))
    const options = {
      receiver: { antennaHeightM: 10 },
      maxGapS: 600,
      staticIntervalS: 360
    }

    it('hears a nearby ship, not a distant one, and sends static data first', () => {
      const traffic = new Traffic(
        [...reports('503000001', 0.05), ...reports('503000002', 2)],
        options
      )
      const { heard } = traffic.advance(0, 30_000, 0, 0)
      expect(heard.map((h) => h.mmsi)).to.deep.equal(['503000001'])
      expect(heard[0].context).to.equal('vessels.urn:mrn:imo:mmsi:503000001')
      expect(heard[0].withStatic).to.equal(true)
      expect(
        traffic.advance(30_000, 60_000, 0, 0).heard[0].withStatic
      ).to.equal(false)
    })

    it('gives anonymised targets a synthetic identity, never an MMSI', () => {
      const traffic = new Traffic(reports('hashed-vessel', 0.05), options)
      const [target] = traffic.advance(0, 30_000, 0, 0).heard
      expect(target.mmsi).to.equal(undefined)
      expect(target.context).to.match(/^vessels\.urn:mrn:signalk:uuid:/)
    })

    it('loses a target that stops being heard', () => {
      const traffic = new Traffic(reports('503000001', 0.05), options)
      expect(traffic.advance(0, 30_000, 0, 0).heard).to.have.length(1)
      // the boat moves far away: no more reports get through
      const later = traffic.advance(30_000, 120_000, 5, 5)
      expect(later.heard).to.deep.equal([])
      const lost = traffic.advance(120_000, 400_000, 5, 5).lost
      expect(lost).to.deep.equal(['vessels.urn:mrn:imo:mmsi:503000001'])
    })
  })

  describe('simulation', () => {
    it('advances at the multiplier and sends the boat, its depth and the traffic', () => {
      const r = route([
        { lat: 0, lon: 0, speedKn: 6 },
        { lat: 0.1, lon: 0 }
      ])
      const depth = new DepthModel([{ resolutionM: 100, elevation: () => -12 }])
      const scenario: Scenario = {
        sampleId: 'test',
        route: r,
        plannedRoute: r,
        legs: routeLegs(r),
        adjustments: [],
        depth,
        traffic: new Traffic(
          [0, 600].map((s) => ({
            id: '503000003',
            timeMs: Date.parse(r.departure) + s * 1000,
            lat: 0.01,
            lon: 0,
            sogKn: 8,
            target: { typeCode: 60, lengthM: 40 }
          })),
          {
            receiver: { antennaHeightM: 10 },
            maxGapS: 900,
            staticIntervalS: 360
          }
        ),
        notes: []
      }
      const deltas: { context: string; paths: string[] }[] = []
      const sim = new Simulation(
        scenario,
        {
          timeMultiplier: 60,
          showTraffic: true,
          scenarioStartMs: Date.parse(r.departure)
        },
        (d) =>
          deltas.push({
            context: d.context,
            paths: d.updates[0].values.map((v) => v.path)
          }),
        0
      )
      const result = sim.tick(10_000)
      expect(result.scenarioMs - Date.parse(r.departure)).to.equal(600_000)
      expect(result.position.lat).to.be.closeTo(1 / 60, 0.0005)
      expect(result.depthM).to.equal(12)
      expect(
        deltas.some((d) => d.paths.includes('environment.depth.belowKeel'))
      ).to.equal(true)
      expect(
        deltas.some((d) => d.context === 'vessels.urn:mrn:imo:mmsi:503000003')
      ).to.equal(true)
    })
  })
})
