import { expect } from 'chai'
import { mkdtempSync, readFileSync, writeFileSync } from 'fs'
import os from 'os'
import path from 'path'
import { Scenario } from '../simulator/engine/scenario'
import { Simulation } from '../simulator/engine/simulation'
import { Route, routeLegs } from '../simulator/routes/route'
import { Delta, forSchema } from '../simulator/soak/deltas'
import { loadProfile } from '../simulator/vessels/profile'
import {
  AT_STATION_M,
  Environment,
  loadEnvironment
} from '../simulator/weather/environment'
import { loadStations } from '../simulator/weather/sources'

// eslint-disable-next-line @typescript-eslint/no-require-imports
const schema = require(
  require.resolve('@signalk/signalk-schema', {
    paths: [path.join(__dirname, '..', 'packages', 'streams')]
  })
)

const SAMPLES = path.join(__dirname, '..', 'simulator', 'samples')
const VESSELS = path.join(__dirname, '..', 'simulator', 'vessels')
const MIAMI = path.join(SAMPLES, 'miami-icw-2024-03-16')
const SARONIC = path.join(SAMPLES, 'saronic-gulf-2018-07-13')
const QUEENSLAND = path.join(SAMPLES, 'manly-hamilton-island-2026-08-21')
const KN_PER_MS = 3600 / 1852
const KNOT_MS = 1852 / 3600
const RAD = Math.PI / 180
const METRES_PER_DEG = (6371000 * Math.PI) / 180

const VIRGINIA_KEY = { lat: 25.7314, lon: -80.1618 }
const PORT_EVERGLADES = { lat: 26.0817, lon: -80.1167 }
const HOLLYWOOD_BUOY = { lat: 26.001, lon: -80.096 }

/** a CO-OPS file's value at a GMT time, read straight from the file */
function coops(file: string, time: string, column = 1): number {
  const row = readFileSync(path.join(MIAMI, 'open', 'weather', file), 'utf8')
    .split('\n')
    .find((l) => l.startsWith(time))!
  return Number(row.split(',')[column])
}

const utc = (s: string) => Date.parse(s + 'Z')

describe('Simulator weather', () => {
  const miami = loadEnvironment(MIAMI)!

  describe('reading the samples', () => {
    it('gives a buoy reading at the buoy, at the hour it was taken', () => {
      // 41122, Hollywood Beach: 2024 03 16 01 26 ... WVHT 0.46, WTMP 24.8
      const at = utc('2024-03-16T01:26')
      expect(
        miami.value('waveHeightM', HOLLYWOOD_BUOY.lat, HOLLYWOOD_BUOY.lon, at)
      ).to.equal(0.46)
      const c = miami.at(HOLLYWOOD_BUOY.lat, HOLLYWOOD_BUOY.lon, at)
      expect(c.waterC).to.equal(24.8)
    })

    it('gives the Virginia Key station its own wind, pressure and tide', () => {
      const at = utc('2024-03-16T12:00')
      const c = miami.at(VIRGINIA_KEY.lat, VIRGINIA_KEY.lon, at)
      const file = (product: string) => `coops_8723214_${product}_20240316.csv`
      expect(c.windKn).to.be.closeTo(
        coops(file('wind'), '2024-03-16 12:00') * KN_PER_MS,
        1e-9
      )
      expect(c.windDeg).to.be.closeTo(
        coops(file('wind'), '2024-03-16 12:00', 2),
        1e-9
      )
      expect(c.pressurePa).to.be.closeTo(
        coops(file('air_pressure'), '2024-03-16 12:00') * 100,
        1e-9
      )
      expect(c.tide!.heightM).to.equal(
        coops(file('water_level'), '2024-03-16 12:00')
      )
      // the grid is on NAVD88, 0.614 m above Virginia Key's MLLW
      expect(c.waterLevelM).to.be.closeTo(c.tide!.heightM - 0.614, 1e-9)
    })

    it('reads between two readings of a station in time', () => {
      const file = 'coops_8723214_air_pressure_20240316.csv'
      const a = coops(file, '2024-03-16 12:00')
      const b = coops(file, '2024-03-16 12:06')
      expect(
        miami.value(
          'pressurePa',
          VIRGINIA_KEY.lat,
          VIRGINIA_KEY.lon,
          utc('2024-03-16T12:03')
        )
      ).to.be.closeTo(((a + b) / 2) * 100, 1e-6)
    })

    it('combines two stations by inverse distance squared at a point between them', () => {
      const at = utc('2024-03-16T15:00')
      const vk = coops(
        'coops_8723214_air_pressure_20240316.csv',
        '2024-03-16 15:00'
      )
      const pe = coops(
        'coops_8722956_air_pressure_20240316.csv',
        '2024-03-16 15:00'
      )
      // a third of the way from Virginia Key to Port Everglades
      const p = {
        lat: VIRGINIA_KEY.lat + (PORT_EVERGLADES.lat - VIRGINIA_KEY.lat) / 3,
        lon: VIRGINIA_KEY.lon + (PORT_EVERGLADES.lon - VIRGINIA_KEY.lon) / 3
      }
      const d = (s: { lat: number; lon: number }) =>
        Math.hypot(
          (s.lat - p.lat) * METRES_PER_DEG,
          (s.lon - p.lon) * METRES_PER_DEG * Math.cos(p.lat * RAD)
        )
      const w1 = 1 / d(VIRGINIA_KEY) ** 2
      const w2 = 1 / d(PORT_EVERGLADES) ** 2
      expect(miami.value('pressurePa', p.lat, p.lon, at)).to.be.closeTo(
        ((w1 * vk + w2 * pe) / (w1 + w2)) * 100,
        1e-6
      )
    })

    it('gives the next high and low water from the predictions', () => {
      const rows = readFileSync(
        path.join(MIAMI, 'open/weather/coops_8723214_predictions_20240316.csv'),
        'utf8'
      )
        .split('\n')
        .slice(1)
        .filter(Boolean)
        .map((l) => {
          const [t, v] = l.split(',')
          return { ms: utc(t.replace(' ', 'T')), v: Number(v) }
        })
      const from = utc('2024-03-16T12:00')
      const ahead = rows.filter((r) => r.ms >= from)
      const i = ahead.findIndex(
        (r, k) =>
          k > 0 &&
          k < ahead.length - 1 &&
          r.v > ahead[k - 1].v &&
          r.v >= ahead[k + 1].v
      )
      const tide = miami.at(VIRGINIA_KEY.lat, VIRGINIA_KEY.lon, from).tide!
      expect(tide.high).to.deep.equal({ heightM: ahead[i].v, ms: ahead[i].ms })
      expect(tide.low!.ms).to.be.above(from)
    })

    it('reads Queensland at a wave buoy, and the Saronic at its model points', () => {
      const q = loadEnvironment(QUEENSLAND)!
      // Mackay, 2026-08-20T00:00 AEST is 2026-08-19 14:00 UTC; the next record, 00:30 AEST
      const mackay = { lat: -21.0358, lon: 149.5479 }
      expect(
        q.value('waveHeightM', mackay.lat, mackay.lon, utc('2026-08-19T14:30'))
      ).to.equal(1.82)
      expect(
        q.value('tideM', mackay.lat, mackay.lon, utc('2026-08-21T00:00'))
      ).to.equal(undefined)
      expect(
        q.value('waterLevelM', -22.375, 150.625, utc('2026-08-21T00:00'))
      ).to.be.a('number')
      const s = loadEnvironment(SARONIC)!
      const era5 = JSON.parse(
        readFileSync(
          path.join(SARONIC, 'open/weather/open-meteo-era5.json'),
          'utf8'
        )
      )[1]
      const k = era5.hourly.time.indexOf('2018-07-13T15:00')
      // at an ERA5 point its own reading, unless the downloaded GFS grid joins it
      if (s.missing.length) {
        expect(
          s.value(
            'pressurePa',
            era5.latitude,
            era5.longitude,
            utc('2018-07-13T15:00')
          )
        ).to.be.closeTo(era5.hourly.pressure_msl[k] * 100, 1e-6)
      }
      expect(s.has('tideM')).to.equal(false)
      expect(s.has('waterC')).to.equal(false)
    })
  })

  describe('the current', () => {
    const GOVERNMENT_CUT = { lat: 25.76405, lon: -80.13394 }
    const SEVENTEENTH_STREET = { lat: 26.09973, lon: -80.1191 }
    const file = 'coops_MIH0901_currents_predictions_20240316.csv'

    it('reads a CO-OPS prediction as running towards the flood or the ebb direction', () => {
      // 2024-03-16 16:18,8,1.72,293.0,114.0,9: a flood of 1.72 kn setting 293°
      const flood = miami.at(
        GOVERNMENT_CUT.lat,
        GOVERNMENT_CUT.lon,
        utc('2024-03-16T16:18')
      )
      expect(coops(file, '2024-03-16 16:18', 2)).to.equal(1.72)
      expect(flood.currentKn).to.be.closeTo(1.72, 1e-9)
      expect(flood.currentToDeg).to.be.closeTo(293, 1e-9)
      // 2024-03-16 00:00,8,-1.52,293.0,114.0,9: an ebb of 1.52 kn setting 114°
      const ebb = miami.at(
        GOVERNMENT_CUT.lat,
        GOVERNMENT_CUT.lon,
        utc('2024-03-16T00:00')
      )
      expect(ebb.currentKn).to.be.closeTo(1.52, 1e-9)
      expect(ebb.currentToDeg).to.be.closeTo(114, 1e-9)
    })

    it('reads an Open-Meteo ocean current, from km/h towards its direction', () => {
      const q = loadEnvironment(QUEENSLAND)!
      const marine = JSON.parse(
        readFileSync(
          path.join(QUEENSLAND, 'open/weather/open-meteo-marine.json'),
          'utf8'
        )
      )[7]
      const k = marine.hourly.time.indexOf('2026-08-22T06:00')
      const c = q.at(marine.latitude, marine.longitude, utc('2026-08-22T06:00'))
      expect(c.currentKn).to.be.closeTo(
        (marine.hourly.ocean_current_velocity[k] * 1000) / 1852,
        1e-9
      )
      expect(c.currentToDeg).to.be.closeTo(
        marine.hourly.ocean_current_direction[k],
        1e-9
      )
    })

    it('blends two stations as vectors by inverse distance squared, holding past the edges', () => {
      const at = utc('2024-03-16T15:00')
      const p = {
        lat: (GOVERNMENT_CUT.lat + SEVENTEENTH_STREET.lat) / 2,
        lon: (GOVERNMENT_CUT.lon + SEVENTEENTH_STREET.lon) / 2
      }
      const vector = (f: string, deg: (v: number) => number) => {
        const v = coops(f, '2024-03-16 15:00', 2)
        const r = deg(v) * RAD
        return [Math.abs(v) * Math.sin(r), Math.abs(v) * Math.cos(r)]
      }
      const a = vector(file, (v) => (v >= 0 ? 293 : 114))
      const b = vector(
        'coops_PEV0903_currents_predictions_20240316.csv',
        (v) => (v >= 0 ? 22 : 184)
      )
      const d = (s: { lat: number; lon: number }) =>
        Math.hypot(
          (s.lat - p.lat) * METRES_PER_DEG,
          (s.lon - p.lon) * METRES_PER_DEG * Math.cos(p.lat * RAD)
        )
      const wa = 1 / d(GOVERNMENT_CUT) ** 2
      const wb = 1 / d(SEVENTEENTH_STREET) ** 2
      const e = (wa * a[0] + wb * b[0]) / (wa + wb)
      const n = (wa * a[1] + wb * b[1]) / (wa + wb)
      const c = miami.at(p.lat, p.lon, at)
      expect(c.currentKn).to.be.closeTo(Math.hypot(e, n), 1e-9)
      expect(c.currentToDeg).to.be.closeTo(
        (Math.atan2(e, n) / RAD + 360) % 360,
        1e-9
      )
      // past the predictions' end, each station holds its last
      const late = miami.at(
        GOVERNMENT_CUT.lat,
        GOVERNMENT_CUT.lon,
        utc('2024-03-19T00:00')
      )
      expect(late.currentKn).to.be.closeTo(1.88, 1e-9)
      expect(late.currentToDeg).to.be.closeTo(114, 1e-9)
    })

    it('gives the Saronic, which has no current data, none', () => {
      const s = loadEnvironment(SARONIC)!
      expect(s.has('currentE')).to.equal(false)
      expect(s.at(37.9, 23.6, utc('2018-07-13T12:00')).currentKn).to.equal(
        undefined
      )
    })
  })

  describe('past the edges', () => {
    it('holds the first reading before the record starts and the last after it ends', () => {
      const first = miami.value(
        'pressurePa',
        VIRGINIA_KEY.lat,
        VIRGINIA_KEY.lon,
        utc('2024-03-16T00:00')
      )
      const last = miami.value(
        'pressurePa',
        VIRGINIA_KEY.lat,
        VIRGINIA_KEY.lon,
        utc('2024-03-17T23:54')
      )
      expect(
        miami.value(
          'pressurePa',
          VIRGINIA_KEY.lat,
          VIRGINIA_KEY.lon,
          utc('2024-03-15T18:00')
        )
      ).to.equal(first)
      expect(
        miami.value(
          'pressurePa',
          VIRGINIA_KEY.lat,
          VIRGINIA_KEY.lon,
          utc('2024-03-18T06:00')
        )
      ).to.equal(last)
      // the predictions run out, so the table gives no next high or low water
      const tide = miami.at(
        VIRGINIA_KEY.lat,
        VIRGINIA_KEY.lon,
        utc('2024-03-18T06:00')
      ).tide!
      expect(tide.high).to.equal(undefined)
      expect(tide.low).to.equal(undefined)
    })

    it('hands over to the stations still recording where one stops', () => {
      // the NDBC air temperature ends on the 16th; no other station measures the air, so it holds
      const end = miami.value('airC', 25.9, -80.13, utc('2024-03-16T23:54'))
      expect(
        miami.value('airC', 25.9, -80.13, utc('2024-03-17T03:00'))
      ).to.equal(end)
    })

    it('gives the nearest station beyond the spread of them, never more than was measured', () => {
      const at = utc('2024-03-16T12:00')
      const vk = miami.value(
        'pressurePa',
        VIRGINIA_KEY.lat,
        VIRGINIA_KEY.lon,
        at
      )!
      const pe = miami.value(
        'pressurePa',
        PORT_EVERGLADES.lat,
        PORT_EVERGLADES.lon,
        at
      )!
      const far = miami.value('pressurePa', 24.5, -80.5, at)!
      expect(far).to.be.within(Math.min(vk, pe), Math.max(vk, pe))
      expect(Math.abs(far - vk)).to.be.below(Math.abs(far - pe))
      // within the station's radius it is the station's own
      const near = VIRGINIA_KEY.lat + AT_STATION_M / 2 / METRES_PER_DEG
      expect(miami.value('pressurePa', near, VIRGINIA_KEY.lon, at)).to.equal(vk)
    })

    it('leaves out a station across a gap of more than four hours', () => {
      const env = new Environment([
        {
          id: 'a',
          name: 'a',
          lat: 0,
          lon: 0,
          series: { airC: { ms: [0, 10 * 3600000], v: [10, 20] } }
        },
        {
          id: 'b',
          name: 'b',
          lat: 0,
          lon: 1,
          series: {
            airC: {
              ms: [0, 3 * 3600000, 6 * 3600000, 10 * 3600000],
              v: [30, 30, 30, 30]
            }
          }
        }
      ])
      expect(env.value('airC', 0, 0.001, 5 * 3600000)).to.equal(30)
    })
  })

  describe('the tide', () => {
    it('takes the predictions where the observations run out', () => {
      const dir = mkdtempSync(path.join(os.tmpdir(), 'coops-'))
      const header = 'Date Time, Water Level, Sigma\n'
      writeFileSync(
        path.join(dir, 'x_water_level.csv'),
        header + '2024-03-16 00:00,0.500,0\n2024-03-16 00:06,,0\n'
      )
      writeFileSync(
        path.join(dir, 'x_predictions.csv'),
        'Date Time, Prediction\n2024-03-16 00:00,0.400\n2024-03-16 00:06,0.450\n'
      )
      const { stations } = loadStations(dir, [
        {
          format: 'coops',
          file: 'x_{product}.csv',
          use: ['tide', 'waterLevel'],
          station: { id: 'x', name: 'x', lat: 0, lon: 0 },
          gridDatumAboveChartDatumM: 0.6
        }
      ])
      expect(stations[0].series.tideM!.v).to.deep.equal([0.5, 0.45])
      expect(
        stations[0].series.waterLevelM!.v.map((v) => +v.toFixed(3))
      ).to.deep.equal([-0.1, -0.15])
    })
  })

  describe('in a run', () => {
    const START = utc('2024-03-16T13:30')

    /** a boat north out of Biscayne Bay on Miami's weather, over a flat 10 m grid */
    function scenario(environment?: Environment): Scenario {
      const profile = loadProfile('sailing-yacht-15m', VESSELS)
      const route: Route = {
        name: 'weather test',
        departure: new Date(START + 10 * 60000).toISOString(),
        vessel: {
          description: profile.name,
          lengthM: profile.lengthM,
          draftM: profile.draftM,
          typeCode: profile.typeCode,
          profile: profile.id
        },
        source: 'test',
        waypoints: [
          { name: 'a', lat: 25.75, lon: -80.17, speedKn: 6 },
          { name: 'b', lat: 26.05, lon: -80.12 }
        ]
      }
      return {
        sampleId: 'test',
        route,
        plannedRoute: route,
        legs: routeLegs(route),
        adjustments: [],
        profile,
        depth: { depth: () => 10 } as unknown as Scenario['depth'],
        environment,
        notes: []
      }
    }

    /** a run on the controllable clock, a scenario minute a tick */
    function runner(
      environment: Environment | undefined,
      seed = 1,
      profileId = 'sailing-yacht-15m'
    ) {
      const sent: Delta[] = []
      const s = scenario(environment)
      s.profile = loadProfile(profileId, VESSELS)
      const sim = new Simulation(
        s,
        {
          timeMultiplier: 60,
          showTraffic: false,
          scenarioStartMs: START,
          seed
        },
        (d) => sent.push(d),
        0
      )
      let wall = 0
      const ticks: { ms: number; values: Map<string, unknown> }[] = []
      const minutes = (n: number) => {
        const out: typeof ticks = []
        for (let i = 0; i < n; i++) {
          const from = sent.length
          wall += 1000
          sim.tick(wall)
          const values = new Map<string, unknown>()
          for (const d of sent.slice(from))
            for (const u of d.updates)
              for (const v of u.values)
                values.set(
                  u.source.src ? `${u.source.src}:${v.path}` : v.path,
                  v.value
                )
          out.push({ ms: sim.systems!.scenarioMs, values })
        }
        ticks.push(...out)
        return out
      }
      return { sim, sent, ticks, minutes }
    }

    function sail(
      environment: Environment | undefined,
      minutes: number,
      seed = 1
    ) {
      const r = runner(environment, seed)
      r.minutes(minutes)
      return r
    }

    it('sends the sample wind with the seed gusts on it, the air, water and tide', () => {
      const { ticks, sim } = sail(miami, 180)
      const slow = ticks.filter((t) =>
        t.values.has('environment.outside.pressure')
      )
      expect(slow.length).to.be.above(20)
      for (const t of slow) {
        const pos = t.values.get('navigation.position') as {
          latitude: number
          longitude: number
        }
        const c = miami.at(pos.latitude, pos.longitude, t.ms)
        expect(t.values.get('environment.outside.pressure')).to.equal(
          Math.round(c.pressurePa!)
        )
        expect(t.values.get('environment.water.temperature')).to.be.closeTo(
          c.waterC! + 273.15,
          0.01
        )
        expect(t.values.get('environment.tide.heightNow')).to.be.closeTo(
          c.tide!.heightM,
          0.001
        )
        expect(t.values.has('environment.outside.relativeHumidity')).to.equal(
          false
        )
      }
      // the gusts and shifts ride on the sample's wind: near it, not on it
      const offsets = ticks
        .filter((t) => t.values.has('environment.wind.speedTrue'))
        .map((t) => {
          const pos = t.values.get('navigation.position') as {
            latitude: number
            longitude: number
          }
          return (
            (t.values.get('environment.wind.speedTrue') as number) / KNOT_MS -
            miami.at(pos.latitude, pos.longitude, t.ms).windKn!
          )
        })
      expect(Math.max(...offsets.map(Math.abs)))
        .to.be.above(0.1)
        .and.below(8)
      expect(sim.systems!.summary().weather.tideM).to.be.a('number')
    })

    it('works the apparent wind out of the true wind and her own motion', () => {
      const { ticks } = sail(miami, 120)
      const checked = ticks.filter(
        (t) =>
          t.values.has('environment.wind.speedApparent') &&
          (t.values.get('navigation.speedOverGround') as number) > 1
      )
      expect(checked.length).to.be.above(50)
      for (const t of checked) {
        const n = (p: string) => t.values.get(p) as number
        // the true wind back from what is sent: the air over the ground, then over the deck
        const tws = n('environment.wind.speedTrue')
        const from = n('environment.wind.directionTrue')
        const sog = n('navigation.speedOverGround')
        const cog = n('navigation.courseOverGroundTrue')
        const east = -tws * Math.sin(from) - sog * Math.sin(cog)
        const north = -tws * Math.cos(from) - sog * Math.cos(cog)
        expect(n('environment.wind.speedApparent')).to.be.closeTo(
          Math.hypot(east, north),
          0.02
        )
        // within what rounding the sent speeds and angles allows at a few knots of apparent wind
        const angle = Math.atan2(-east, -north) - n('navigation.headingTrue')
        const wrapped = Math.atan2(Math.sin(angle), Math.cos(angle))
        expect(
          Math.abs(
            Math.atan2(
              Math.sin(n('environment.wind.angleApparent') - wrapped),
              Math.cos(n('environment.wind.angleApparent') - wrapped)
            )
          )
        ).to.be.below(0.035)
      }
    })

    it('moves the depth under the keel with the tide', () => {
      const { ticks } = sail(miami, 180)
      const readings = ticks
        .filter((t) => t.values.has('sounder:environment.depth.belowSurface'))
        .map((t) => {
          const pos = t.values.get('navigation.position') as {
            latitude: number
            longitude: number
          }
          return {
            depth: t.values.get(
              'sounder:environment.depth.belowSurface'
            ) as number,
            keel: t.values.get('sounder:environment.depth.belowKeel') as number,
            level: miami.value(
              'waterLevelM',
              pos.latitude,
              pos.longitude,
              t.ms
            )!
          }
        })
      for (const r of readings) {
        // the 10 m grid, the water level on it, and the sounder's own small bias and drift
        expect(r.depth).to.be.closeTo(10 + r.level, 0.15)
        expect(r.depth - r.keel).to.be.closeTo(2.2, 0.011)
      }
      const levels = readings.map((r) => r.level)
      expect(Math.max(...levels) - Math.min(...levels)).to.be.above(0.2)
    })

    it('repeats exactly for a seed and start, and differs for another seed', () => {
      const a = sail(miami, 60).sent
      const b = sail(miami, 60).sent
      expect(JSON.stringify(b)).to.equal(JSON.stringify(a))
      const c = sail(miami, 60, 2).sent
      expect(JSON.stringify(c)).to.not.equal(JSON.stringify(a))
    })

    it('shows what a frozen wind instrument showed, and nothing on a boat without one', () => {
      const r = runner(miami)
      const before = r.minutes(30)
      const speeds = (ticks: typeof before) =>
        ticks
          .map((t) => t.values.get('environment.wind.speedTrue'))
          .filter((v) => v !== undefined)
      expect(new Set(speeds(before)).size).to.be.above(5)
      r.sim.faults!.raise('windInstrumentFrozen')
      expect(new Set(speeds(r.minutes(30))).size).to.equal(1)

      const boat = loadProfile('boat-4m', VESSELS)
      expect(boat.wind).to.equal(false)
      const small = runner(miami, 1, 'boat-4m')
      expect(
        small
          .minutes(20)
          .some((t) =>
            [...t.values.keys()].some((k) => k.startsWith('environment.wind.'))
          )
      ).to.equal(false)
    })

    it('sends only what the schema allows', () => {
      const { sent } = sail(miami, 20)
      const withTide = sent.filter((d) =>
        d.updates.some((u) =>
          u.values.some((v) => v.path.startsWith('environment.tide.'))
        )
      )
      expect(withTide.length).to.be.above(0)
      const v = schema.validateFull(
        schema.deltaToFull({
          ...forSchema(withTide[0]),
          context: 'vessels.urn:mrn:imo:mmsi:366000001'
        })
      )
      expect(v.valid, JSON.stringify(v.errors)).to.equal(true)
    })
  })
})
