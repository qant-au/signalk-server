import { expect } from 'chai'
import { mkdtempSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import path from 'path'
import { isNight } from '../simulator/deck/deck'
import { Scenario } from '../simulator/engine/scenario'
import { Simulation } from '../simulator/engine/simulation'
import { FaultError } from '../simulator/faults/faults'
import {
  Route,
  Waypoint,
  bridgeHoldAt,
  bridgeWords,
  loadRoute,
  routeLegs
} from '../simulator/routes/route'
import { Delta, forSchema } from '../simulator/soak/deltas'
import { SystemsSummary } from '../simulator/systems/model'
import { VesselProfile, loadProfile } from '../simulator/vessels/profile'
import { Environment } from '../simulator/weather/environment'
import { Series } from '../simulator/weather/sources'

// eslint-disable-next-line @typescript-eslint/no-require-imports
const schema = require(
  require.resolve('@signalk/signalk-schema', {
    paths: [path.join(__dirname, '..', 'packages', 'streams')]
  })
)

const VESSELS = path.join(__dirname, '..', 'simulator', 'vessels')
const SAMPLES = path.join(__dirname, '..', 'simulator', 'samples')
const MINUTE = 60000
const HOUR = 60 * MINUTE
const RAD = Math.PI / 180
/** the sun sets off Miami at about 23:28 UTC on this day, and rises at about 11:20 */
const DUSK = Date.parse('2024-03-16T23:00:00Z')
const MIDDAY = Date.parse('2024-03-16T17:00:00Z')
const LAT = 25.5
const LON = -80

/** a steady wind at every hour of the run */
function steadyWind(kn: number, fromDeg: number, fromMs: number): Environment {
  const ms: number[] = []
  for (let t = fromMs - HOUR; t <= fromMs + 30 * HOUR; t += HOUR) ms.push(t)
  const steady = (v: number): Series => ({ ms, v: ms.map(() => v) })
  return new Environment([
    {
      id: 'test',
      name: 'test',
      lat: LAT,
      lon: LON,
      series: {
        windE: steady(kn * Math.sin(fromDeg * RAD)),
        windN: steady(kn * Math.cos(fromDeg * RAD))
      }
    }
  ])
}

function scenarioFor(
  profile: VesselProfile,
  waypoints: Waypoint[],
  departMs: number,
  environment?: Environment
): Scenario {
  const route: Route = {
    name: 'deck test',
    departure: new Date(departMs).toISOString(),
    vessel: {
      description: profile.name,
      lengthM: profile.lengthM,
      draftM: profile.draftM,
      typeCode: profile.typeCode,
      profile: profile.id
    },
    source: 'test',
    waypoints
  }
  return {
    sampleId: 'test',
    route,
    plannedRoute: route,
    legs: routeLegs(route),
    adjustments: [],
    profile,
    depth: { depth: () => 8 } as unknown as Scenario['depth'],
    environment,
    notes: []
  }
}

/** a berth and a run north at this speed for this many miles, alongside at the end */
const passage = (speedKn: number, miles: number): Waypoint[] => [
  { name: 'berth', lat: LAT, lon: LON, speedKn },
  { name: 'north', lat: LAT + miles / 60, lon: LON }
]

interface Tick {
  ms: number
  values: Map<string, unknown>
  summary: SystemsSummary
  lat: number
  lon: number
}

class Run {
  readonly sim: Simulation
  readonly sent: Delta[] = []
  private wallMs = 0

  constructor(
    readonly scenario: Scenario,
    startMs: number,
    rate = 60
  ) {
    this.sim = new Simulation(
      scenario,
      {
        timeMultiplier: rate,
        showTraffic: false,
        scenarioStartMs: startMs,
        seed: 1
      },
      (d) => this.sent.push(d),
      0
    )
  }

  until(ms: number): Tick[] {
    const out: Tick[] = []
    while (this.sim.scenarioMs < ms) {
      const from = this.sent.length
      this.wallMs += 1000
      const result = this.sim.tick(this.wallMs)
      const values = new Map<string, unknown>()
      for (const d of this.sent.slice(from))
        for (const u of d.updates)
          for (const v of u.values) values.set(v.path, v.value)
      out.push({
        ms: this.sim.systems!.scenarioMs,
        values,
        summary: this.sim.systems!.summary(),
        lat: result.position.lat,
        lon: result.position.lon
      })
    }
    return out
  }
}

const profile = (id: string) => loadProfile(id, VESSELS)
const night = (t: Tick) => isNight(t.ms, t.lat, t.lon)
const lights = (t: Tick) => t.values.get('navigation.lights')

describe('Simulator deck', () => {
  describe('navigation lights', () => {
    it('lights a motor boat at night under way, never by day or alongside', () => {
      // away mid-afternoon, under way through dusk for five hours, alongside after
      const run = new Run(
        scenarioFor(
          profile('motor-yacht-20m'),
          passage(6, 30),
          MIDDAY + 4 * HOUR
        ),
        MIDDAY
      )
      const ticks = run.until(MIDDAY + 12 * HOUR)
      const seen = new Set<unknown>()
      for (const t of ticks) {
        const v = lights(t)
        seen.add(v)
        const state = t.values.get('navigation.state')
        if (!night(t) || state === 'moored') expect(v, iso(t)).to.equal('off')
        else expect(v, iso(t)).to.equal('motoring')
      }
      expect([...seen].sort()).to.deep.equal(['motoring', 'off'])
      const dark = ticks.filter((t) => night(t) && lights(t) === 'motoring')
      expect(dark.length).to.be.greaterThan(60)
    })

    it('shows sailing lights under sail alone, motoring lights motor-sailing, the anchor light at anchor', () => {
      // out at dusk on a beam reach, anchored overnight, weighing by day
      const waypoints: Waypoint[] = [
        { name: 'berth', lat: LAT, lon: LON, speedKn: 6 },
        {
          name: 'anchorage',
          lat: LAT + 0.25,
          lon: LON,
          speedKn: 6,
          holdS: 12 * 3600,
          anchor: true
        },
        { name: 'north', lat: LAT + 0.35, lon: LON }
      ]
      const run = new Run(
        scenarioFor(
          profile('sailing-yacht-15m'),
          waypoints,
          DUSK + HOUR,
          steadyWind(14, 90, DUSK)
        ),
        DUSK
      )
      const ticks = run.until(DUSK + 18 * HOUR)
      const seen = new Set<unknown>()
      for (const t of ticks) {
        const v = lights(t)
        seen.add(v)
        const state = t.values.get('navigation.state')
        const want =
          !night(t) || state === 'moored'
            ? 'off'
            : state === 'anchored'
              ? 'anchored'
              : t.summary.sailing
                ? 'sailing'
                : 'motoring'
        expect(v, `${iso(t)} ${state}`).to.equal(want)
        // motor-sailing is motoring, by the rules and by the lights
        if (t.summary.sails?.propulsion === 'motor-sailing')
          expect(v === 'off' || v === 'motoring', iso(t)).to.equal(true)
      }
      expect([...seen]).to.include.members([
        'off',
        'motoring',
        'sailing',
        'anchored'
      ])
      // the anchor comes up by day, so the anchor light is off before she weighs
      const weighed = ticks.findIndex(
        (t, i) =>
          i > 0 &&
          ticks[i - 1].values.get('navigation.state') === 'anchored' &&
          t.values.get('navigation.state') !== 'anchored'
      )
      expect(night(ticks[weighed])).to.equal(false)
      expect(lights(ticks[weighed - 1])).to.equal('off')
    })

    it('lights the 4 m boat under way at night, with the draw on her one battery', () => {
      const run = new Run(
        scenarioFor(profile('boat-4m'), passage(5, 4), DUSK + HOUR),
        DUSK
      )
      const ticks = run.until(DUSK + 2 * HOUR)
      expect(ticks.some((t) => lights(t) === 'motoring')).to.equal(true)
      const books = run.sim.systems!.books()
      const battery = books.banks.find((b) => b.id === 'start')!
      expect(battery.outJ['navigation lights']).to.be.greaterThan(0)
    })

    it('fails only from dusk, showing no lights with an alarm until cleared', () => {
      const run = new Run(
        scenarioFor(
          profile('motor-yacht-20m'),
          passage(6, 30),
          MIDDAY + 4 * HOUR
        ),
        MIDDAY
      )
      run.until(MIDDAY + 5 * HOUR)
      const faults = run.sim.faults!
      expect(() => faults.raise('navLightsFailure')).to.throw(
        FaultError,
        /only from dusk/
      )
      expect(
        faults.available().some((k) => k.kind === 'navLightsFailure')
      ).to.equal(false)
      run.until(DUSK + HOUR)
      expect(
        faults.available().some((k) => k.kind === 'navLightsFailure')
      ).to.equal(true)
      const view = faults.raise('navLightsFailure')
      expect(view.clearsMs! - view.raisedMs).to.be.within(
        10 * MINUTE,
        60 * MINUTE
      )
      const from = run.sent.length
      const failed = run.until(DUSK + HOUR + 5 * MINUTE)
      expect(lights(failed[failed.length - 1])).to.equal('fault')
      const notes = run.sent
        .slice(from)
        .flatMap((d) => d.updates.flatMap((u) => u.values))
        .filter((v) => v.path === 'notifications.navigation.lights')
      expect(notes[0].value).to.deep.include({
        state: 'alarm',
        method: ['visual', 'sound'],
        message: 'Navigation lights failure: showing no lights'
      })
      faults.clear('navLightsFailure', 'lights')
      const after = run.until(DUSK + HOUR + 10 * MINUTE)
      expect(lights(after[after.length - 1])).to.equal('motoring')
      const cleared = run.sent
        .flatMap((d) => d.updates.flatMap((u) => u.values))
        .filter((v) => v.path === 'notifications.navigation.lights')
      expect(cleared[cleared.length - 1].value).to.include({ state: 'normal' })
    })
  })

  describe('the chain and the windlass', () => {
    it('pays the chain out and heaves it in on the windlass, 0 under way', () => {
      const yacht = profile('sailing-yacht-15m')
      const waypoints: Waypoint[] = [
        { name: 'berth', lat: LAT, lon: LON, speedKn: 6 },
        {
          name: 'anchorage',
          lat: LAT + 0.05,
          lon: LON,
          speedKn: 6,
          holdS: 1200,
          anchor: true
        },
        { name: 'north', lat: LAT + 0.1, lon: LON }
      ]
      // one model step a tick, so a tick's chain moves exactly when the windlass runs
      const run = new Run(
        scenarioFor(yacht, waypoints, MIDDAY + 5 * MINUTE),
        MIDDAY,
        2
      )
      const ticks = run.until(MIDDAY + 80 * MINUTE)
      const chain = (t: Tick) =>
        t.values.get('navigation.anchor.rodeCounterLength') as number
      const windlass = (t: Tick) =>
        t.values.get('electrical.switches.windlass.state')
      let paidOut = false
      let heaved = false
      for (let i = 1; i < ticks.length; i++) {
        const moved = chain(ticks[i]) - chain(ticks[i - 1])
        // the windlass runs while the chain moves, and only then
        expect(windlass(ticks[i]), iso(ticks[i])).to.equal(moved !== 0 ? 1 : 0)
        if (moved > 0) paidOut = true
        if (moved < 0) heaved = true
        const state = ticks[i].values.get('navigation.state')
        if (state !== 'anchored') expect(chain(ticks[i])).to.equal(0)
      }
      expect(paidOut && heaved).to.equal(true)
      // lying to it, she has five times the depth and the bow's height out
      const lying = Math.max(...ticks.map(chain))
      expect(lying / (8 + 0.08 * yacht.lengthM)).to.be.closeTo(5, 0.01)
      // its draw goes to the house bank, in the books
      const house = run.sim.systems!.books().banks.find((b) => b.id === 'house')
      expect(house!.outJ.windlass).to.be.greaterThan(0)
    })

    it('has no windlass or chain counter on the 4 m boat: the crew hauls by hand', () => {
      const waypoints: Waypoint[] = [
        { name: 'berth', lat: LAT, lon: LON, speedKn: 4 },
        {
          name: 'anchorage',
          lat: LAT + 0.03,
          lon: LON,
          speedKn: 4,
          holdS: 1800,
          anchor: true
        },
        { name: 'north', lat: LAT + 0.06, lon: LON }
      ]
      const run = new Run(
        scenarioFor(profile('boat-4m'), waypoints, MIDDAY + 5 * MINUTE),
        MIDDAY,
        10
      )
      const ticks = run.until(MIDDAY + 2 * HOUR)
      expect(
        ticks.some((t) => t.values.get('navigation.state') === 'anchored')
      ).to.equal(true)
      const paths = new Set(ticks.flatMap((t) => [...t.values.keys()]))
      expect(paths.has('electrical.switches.windlass.state')).to.equal(false)
      expect(paths.has('navigation.anchor.rodeCounterLength')).to.equal(false)
    })
  })

  describe('outboard trim', () => {
    it('tilts up alongside, trims down to leave and come in, and up at speed', () => {
      const boat = profile('boat-4m')
      const waypoints: Waypoint[] = [
        { name: 'berth', lat: LAT, lon: LON, speedKn: 4 },
        { name: 'harbour', lat: LAT + 0.01, lon: LON, speedKn: 16 },
        { name: 'outside', lat: LAT + 0.11, lon: LON, speedKn: 4 },
        { name: 'berth', lat: LAT + 0.12, lon: LON }
      ]
      const run = new Run(
        scenarioFor(boat, waypoints, MIDDAY + 5 * MINUTE),
        MIDDAY,
        5
      )
      const ticks = run.until(MIDDAY + 70 * MINUTE)
      const trim = (t: Tick) => t.values.get('propulsion.main.drive.trimState')
      const at = (ms: number) => ticks.find((t) => t.ms >= ms)!
      const legs = run.scenario.legs
      expect(trim(at(MIDDAY + MINUTE))).to.equal(1)
      expect(trim(at(legs[0].departMs + 2 * MINUTE))).to.equal(0)
      expect(trim(at((legs[1].departMs + legs[1].arriveMs) / 2))).to.equal(0.2)
      expect(trim(at(legs[2].departMs + 2 * MINUTE))).to.equal(0)
      expect(trim(at(legs[2].arriveMs + 2 * MINUTE))).to.equal(1)
      expect(
        ticks.some((t) => t.values.get('propulsion.main.drive.type'))
      ).to.equal(true)
    })

    it('sends no trim from a boat without an outboard', () => {
      const run = new Run(
        scenarioFor(
          profile('motor-yacht-20m'),
          passage(6, 2),
          MIDDAY + 5 * MINUTE
        ),
        MIDDAY,
        10
      )
      const paths = new Set(
        run.until(MIDDAY + HOUR).flatMap((t) => [...t.values.keys()])
      )
      expect([...paths].some((p) => p.includes('.drive.'))).to.equal(false)
      expect(paths.has('electrical.switches.stabilisers.state')).to.equal(false)
    })
  })

  describe('stabilisers', () => {
    const roll = (ticks: Tick[]) => {
      const rolls = ticks
        .map((t) => t.values.get('navigation.attitude') as { roll: number })
        .filter(Boolean)
        .map((a) => a.roll)
      return Math.sqrt(rolls.reduce((s, r) => s + r * r, 0) / rolls.length)
    }
    const underWay = (ticks: Tick[]) =>
      ticks.filter((t) => t.values.get('navigation.state') === 'motoring')

    it('take two thirds of the roll out under way above 6 kn', () => {
      const fitted = profile('motor-yacht-34m')
      const without: VesselProfile = { ...fitted, stabilisers: undefined }
      const sea = steadyWind(25, 90, MIDDAY)
      const runOf = (p: VesselProfile) =>
        new Run(
          scenarioFor(p, passage(10, 20), MIDDAY + 5 * MINUTE, sea),
          MIDDAY
        ).until(MIDDAY + 2 * HOUR)
      const on = runOf(fitted)
      const off = runOf(without)
      const moving = underWay(on).filter((t) => t.summary.deck.stabilisers)
      expect(moving.length).to.be.greaterThan(60)
      for (const t of on)
        if (t.values.get('navigation.state') === 'moored')
          expect(
            t.values.get('electrical.switches.stabilisers.state')
          ).to.equal(0)
      expect(roll(underWay(on)) / roll(underWay(off))).to.be.closeTo(1 / 3, 0.1)
      expect(
        moving.every(
          (t) => t.values.get('electrical.switches.stabilisers.state') === 1
        )
      ).to.equal(true)
    })

    it('keep working at anchor on zero-speed fins, and draw on the AC supply', () => {
      const waypoints: Waypoint[] = [
        { name: 'berth', lat: LAT, lon: LON, speedKn: 10 },
        {
          name: 'anchorage',
          lat: LAT + 0.1,
          lon: LON,
          speedKn: 10,
          holdS: 3600,
          anchor: true
        },
        { name: 'north', lat: LAT + 0.2, lon: LON }
      ]
      const runOf = (p: VesselProfile) =>
        new Run(scenarioFor(p, waypoints, MIDDAY + 5 * MINUTE), MIDDAY, 10)
      const runAt = (id: string) =>
        runOf(profile(id)).until(MIDDAY + 80 * MINUTE)
      const anchored = (ticks: Tick[]) =>
        ticks.filter(
          (t) =>
            t.values.get('navigation.state') === 'anchored' &&
            t.values.has('electrical.switches.stabilisers.state')
        )
      const zero = anchored(runAt('motor-yacht-45m'))
      const fins = anchored(runAt('motor-yacht-34m'))
      expect(zero.length && fins.length).to.be.greaterThan(10)
      expect(
        zero.every(
          (t) => t.values.get('electrical.switches.stabilisers.state') === 1
        )
      ).to.equal(true)
      expect(
        fins.every(
          (t) => t.values.get('electrical.switches.stabilisers.state') === 0
        )
      ).to.equal(true)
      // the pump is a load on the generators, which carry the AC away from the berth
      const output = (p: VesselProfile) => {
        const run = runOf(p)
        run.until(MIDDAY + 80 * MINUTE)
        return run.sim
          .systems!.books()
          .generators.reduce((sum, g) => sum + g.outputJ, 0)
      }
      const big = profile('motor-yacht-45m')
      const kwh =
        (output(big) - output({ ...big, stabilisers: undefined })) / 3.6e6
      // 9 kW for the hour at anchor and the passage either side of it
      expect(kwh).to.be.within(9, 20)
    })
  })

  describe('radars', () => {
    it('transmit under way and stand by alongside and at anchor', () => {
      const yacht = profile('motor-yacht-34m')
      const waypoints: Waypoint[] = [
        { name: 'berth', lat: LAT, lon: LON, speedKn: 10 },
        {
          name: 'anchorage',
          lat: LAT + 0.1,
          lon: LON,
          speedKn: 10,
          holdS: 1800,
          anchor: true
        },
        { name: 'north', lat: LAT + 0.2, lon: LON }
      ]
      const ticks = new Run(
        scenarioFor(yacht, waypoints, MIDDAY + 5 * MINUTE),
        MIDDAY,
        10
      ).until(MIDDAY + 2 * HOUR)
      const states = new Set<unknown>()
      for (const t of ticks) {
        const state = t.values.get('navigation.state')
        states.add(state)
        const want = state === 'motoring' ? 1 : 0
        for (const r of yacht.radars)
          expect(t.values.get(`electrical.switches.${r.id}.state`)).to.equal(
            want
          )
      }
      expect([...states]).to.include.members(['moored', 'motoring', 'anchored'])
      const named = new Map(
        metaOf(yacht).map((m) => [m.path, m.value.displayName])
      )
      for (const r of yacht.radars)
        expect(named.get(`electrical.switches.${r.id}`)).to.equal(r.displayName)
      expect(named.get('electrical.switches.stabilisers')).to.equal(
        'Stabilisers'
      )
      expect(named.get('electrical.switches.windlass')).to.equal('Windlass')
    })
  })

  describe('bridges', () => {
    it('says which Miami bridge each hold waits for, and whether she clears it closed', async () => {
      const route = await loadRoute(path.join(SAMPLES, 'miami-icw-2024-03-16'))
      const legs = routeLegs(route)
      const air = profile('motor-yacht-20m').airHeightM
      const words = route.bridges!.map((b) => {
        const arrive = legs[b.waypoint - 1].arriveMs
        const leave = legs[b.waypoint].departMs
        expect(bridgeHoldAt(route, legs, arrive - MINUTE, air)).to.equal(
          undefined
        )
        expect(bridgeHoldAt(route, legs, leave, air)).to.equal(undefined)
        return bridgeWords(
          bridgeHoldAt(route, legs, (arrive + leave) / 2, air)!
        )
      })
      expect(words).to.deep.equal([
        'holding at the 79th Street Causeway bridge, though she clears it closed: 5.9 m air height against 7.6 m closed clearance',
        'holding for the Broad Causeway bridge to open: 5.9 m air height against 4.9 m closed clearance',
        'holding at the Hollywood Boulevard bridge, though she clears it closed: 5.9 m air height against 7.6 m closed clearance',
        'holding at the Dania Beach Boulevard bridge, though she clears it closed: 5.9 m air height against 6.7 m closed clearance'
      ])
    })
  })

  it('refuses a bridge on a waypoint that does not hold', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'bridges-'))
    const route = {
      name: 'bad bridge',
      departure: new Date(MIDDAY).toISOString(),
      vessel: { description: 'test', lengthM: 10, draftM: 1, typeCode: 37 },
      source: 'test',
      waypoints: passage(6, 2),
      bridges: [{ waypoint: 1, name: 'Test bridge', closedClearanceM: 5 }]
    }
    writeFileSync(path.join(dir, 'route.json'), JSON.stringify(route))
    const error = await loadRoute(dir).then(
      () => undefined,
      (e: Error) => e
    )
    expect(error?.message).to.match(
      /Test bridge is at waypoint 1, which has no hold/
    )
  })

  describe('the schema', () => {
    it('takes every new path it has a place for, and still has none for the others', () => {
      // the 4 m boat at night for the trim; the 34 m yacht for the switches and the chain
      const yacht = profile('motor-yacht-34m')
      const waypoints: Waypoint[] = [
        { name: 'berth', lat: LAT, lon: LON, speedKn: 10 },
        {
          name: 'anchorage',
          lat: LAT + 0.1,
          lon: LON,
          speedKn: 10,
          holdS: 1800,
          anchor: true
        },
        { name: 'north', lat: LAT + 0.2, lon: LON }
      ]
      const runs = [
        new Run(scenarioFor(yacht, waypoints, DUSK + HOUR), DUSK, 10),
        new Run(
          scenarioFor(profile('boat-4m'), passage(5, 4), DUSK + HOUR),
          DUSK,
          10
        )
      ]
      const values = new Map<string, unknown>()
      for (const run of runs) {
        run.until(DUSK + 3 * HOUR)
        for (const d of run.sent)
          for (const u of d.updates)
            for (const v of u.values) values.set(v.path, v.value)
      }
      const fresh = [...values.keys()].filter((p) =>
        /^navigation\.lights$|^navigation\.anchor\.rodeCounterLength$|^electrical\.switches\.|\.drive\./.test(
          p
        )
      )
      const valid = (p: string) => {
        const delta = {
          context: 'vessels.urn:mrn:imo:mmsi:230099999',
          updates: [
            {
              source: { label: 'simulator', type: 'test' },
              timestamp: new Date(DUSK).toISOString(),
              values: [{ path: p, value: values.get(p) }]
            }
          ]
        }
        return schema.validateFull(schema.deltaToFull(delta)).valid as boolean
      }
      const inSchema = fresh.filter(valid)
      expect(inSchema).to.deep.equal(['propulsion.main.drive.trimState'])
      // and the rest are what forSchema leaves out, as the README says
      for (const p of fresh.filter((x) => !valid(x))) {
        const kept = forSchema({
          context: 'vessels.self',
          updates: [
            {
              source: { label: 'simulator', type: 'test' },
              timestamp: '',
              values: [{ path: p, value: values.get(p) }]
            }
          ]
        }).updates[0].values
        expect(kept, p).to.deep.equal([])
      }
      expect(fresh).to.include.members([
        'navigation.lights',
        'navigation.anchor.rodeCounterLength',
        'electrical.switches.windlass.state',
        'electrical.switches.stabilisers.state',
        'electrical.switches.radarX.state',
        'propulsion.main.drive.type'
      ])
    })
  })
})

function metaOf(p: VesselProfile) {
  const run = new Run(scenarioFor(p, passage(10, 2), MIDDAY), MIDDAY, 10)
  run.until(MIDDAY + MINUTE)
  return run.sent.flatMap((d) => d.updates.flatMap((u) => u.meta ?? []))
}

function iso(t: Tick): string {
  return new Date(t.ms).toISOString()
}
