import { expect } from 'chai'
import path from 'path'
import { withoutArrivalClaims } from '../simulator/engine/claims'
import { Scenario } from '../simulator/engine/scenario'
import { Simulation, SimulationOptions } from '../simulator/engine/simulation'
import { FaultError } from '../simulator/faults/faults'
import {
  Route,
  loadRoute,
  nextPointIndex,
  routeLegs
} from '../simulator/routes/route'
import { Delta, forSchema } from '../simulator/soak/deltas'
import {
  ANCHOR_WATCH_HOLD_M,
  ANCHOR_WATCH_MARGIN_M,
  Anchorage,
  DRAG_KN,
  SCOPE,
  anchorWatch,
  metresBetween
} from '../simulator/systems/anchor'
import { loadDepthModel } from '../simulator/depth/depth'
import { SystemsState } from '../simulator/systems/model'
import { loadProfile } from '../simulator/vessels/profile'

// eslint-disable-next-line @typescript-eslint/no-require-imports
const schema = require(
  require.resolve('@signalk/signalk-schema', {
    paths: [path.join(__dirname, '..', 'packages', 'streams')]
  })
)

const VESSELS = path.join(__dirname, '..', 'simulator', 'vessels')
const SARONIC = path.join(
  __dirname,
  '..',
  'simulator',
  'samples',
  'saronic-gulf-2018-07-13'
)
/** 10:00 EDT: the anchorage below runs from about 09:00 to 13:00 by the sun at 80° W */
const START = Date.parse('2024-03-16T14:00:00Z')
const MINUTE = 60000
const DEPTH_M = 8
const KNOT_MS = 1852 / 3600
const ANCHORAGE = { lat: 25.0167, lon: -80.0 }

/** a berth, a mile out to an anchorage for four hours, then on */
function scenarioFor(profileId: string, anchorHours = 4): Scenario {
  const profile = loadProfile(profileId, VESSELS)
  const route: Route = {
    name: 'anchorage test',
    departure: new Date(START + 10 * MINUTE).toISOString(),
    vessel: {
      description: profile.name,
      lengthM: profile.lengthM,
      draftM: profile.draftM,
      typeCode: profile.typeCode,
      profile: profile.id
    },
    source: 'test',
    waypoints: [
      // in and out of the anchorage at 3 kn, under engine
      { name: 'berth', lat: 25.0, lon: -80.0, speedKn: 3 },
      {
        name: 'anchorage',
        ...ANCHORAGE,
        speedKn: 3,
        anchor: true,
        holdS: anchorHours * 3600
      },
      { name: 'on', lat: 25.2, lon: -80.0 }
    ]
  }
  return {
    sampleId: 'test',
    route,
    plannedRoute: route,
    legs: routeLegs(route),
    adjustments: [],
    profile,
    depth: { depth: () => DEPTH_M } as unknown as Scenario['depth'],
    notes: []
  }
}

interface Tick {
  ms: number
  values: Map<string, unknown>
  deltas: Delta[]
}

/** a run on the controllable clock, one wall second a tick, `rate` scenario seconds each */
class Run {
  readonly sim: Simulation
  readonly ticks: Tick[] = []
  private pending: Delta[] = []
  private wallMs = 0

  constructor(
    readonly scenario: Scenario,
    options: Partial<SimulationOptions> = {},
    readonly rate = 10
  ) {
    this.sim = new Simulation(
      scenario,
      {
        timeMultiplier: rate,
        showTraffic: false,
        scenarioStartMs: START,
        seed: 1,
        ...options
      },
      (d) => this.pending.push(d),
      0
    )
    this.pending = []
  }

  /** runs until this many scenario minutes after START */
  until(minutes: number): Tick[] {
    const from = this.ticks.length
    while (this.sim.scenarioMs < START + minutes * MINUTE) {
      this.wallMs += 1000
      this.sim.tick(this.wallMs)
      const values = new Map<string, unknown>()
      for (const d of this.pending)
        for (const u of d.updates)
          for (const v of u.values) values.set(v.path, v.value)
      this.ticks.push({
        ms: this.sim.systems!.scenarioMs,
        values,
        deltas: this.pending
      })
      this.pending = []
    }
    return this.ticks.slice(from)
  }
}

const anchoredFrom = (s: Scenario) => s.legs[0].arriveMs
const weighsAt = (s: Scenario) => s.legs[1].departMs
const minutesAt = (ms: number) => (ms - START) / MINUTE

const position = (t: Tick) =>
  t.values.get('navigation.position') as { latitude: number; longitude: number }
const num = (t: Tick, p: string) => t.values.get(p) as number

describe('Simulator anchorage', () => {
  describe('the geometry', () => {
    it('pays out five times the depth and the bow, and swings in its reach plus the antenna aft of the bow', () => {
      const a = new Anchorage(15, 1)
      const h = 7 + 0.08 * 15
      const reach = Math.sqrt((SCOPE * h) ** 2 - h ** 2)
      expect(a.maxRadiusFor(7)).to.be.closeTo(reach + 7.5, 1e-9)
    })

    it('lies downwind of the anchor, inside her radius, bow to it, the radius her distance from it', () => {
      const run = new Run(scenarioFor('sailing-yacht-15m'))
      const s = run.scenario
      run.until(minutesAt(weighsAt(s)) - 10)
      const anchored = run.ticks.filter(
        (t) => t.ms > anchoredFrom(s) + 5 * MINUTE
      )
      expect(anchored.length).to.be.above(1000)
      let sogMax = 0
      const radii: number[] = []
      for (const t of anchored) {
        const at = new Date(t.ms).toISOString()
        const p = position(t)
        const anchor = t.values.get('navigation.anchor.position') as {
          latitude: number
          longitude: number
          altitude: number
        }
        expect(anchor, at).to.deep.equal({
          latitude: ANCHORAGE.lat,
          longitude: ANCHORAGE.lon,
          altitude: -DEPTH_M
        })
        const current = num(t, 'navigation.anchor.currentRadius')
        const distance = metresBetween(
          { lat: anchor.latitude, lon: anchor.longitude },
          { lat: p.latitude, lon: p.longitude }
        )
        expect(current, at).to.be.closeTo(distance, 0.01)
        expect(current, at).to.be.below(
          num(t, 'navigation.anchor.maxRadius') + 0.01
        )
        radii.push(current)
        // bow to the anchor: the heading is the bearing from the boat to it, give or take her yaw
        const bearing =
          (Math.atan2(
            (anchor.longitude - p.longitude) *
              Math.cos((p.latitude * Math.PI) / 180),
            anchor.latitude - p.latitude
          ) *
            180) /
          Math.PI
        const heading = (num(t, 'navigation.headingTrue') * 180) / Math.PI
        expect(Math.abs(wrap(heading - bearing)), at).to.be.below(20)
        const sog = num(t, 'navigation.speedOverGround') / KNOT_MS
        const stw = num(t, 'navigation.speedThroughWater') / KNOT_MS
        sogMax = Math.max(sogMax, sog)
        expect(stw, at).to.be.below(1)
        expect(t.values.get('navigation.state'), at).to.equal('anchored')
      }
      // she moves as a boat on her chain does: some speed over the ground, never a passage's
      expect(sogMax).to.be.above(0.1).and.below(1)
      const spread = Math.max(...radii) - Math.min(...radii)
      expect(spread).to.be.above(1)
    })

    it('lies to the wind: the apparent wind is off her bow', () => {
      const run = new Run(scenarioFor('sailing-yacht-15m'))
      const s = run.scenario
      const anchored = run
        .until(minutesAt(weighsAt(s)) - 10)
        .filter((t) => t.ms > anchoredFrom(s) + 10 * MINUTE)
      const angles = anchored.map(
        (t) =>
          (Math.abs(num(t, 'environment.wind.angleApparent')) * 180) / Math.PI
      )
      const mean = angles.reduce((a, b) => a + b, 0) / angles.length
      expect(mean).to.be.below(30)
    })
  })

  describe('the boat at anchor', () => {
    it('anchors, lies anchored with her AIS status at anchor, and weighs under way', () => {
      const run = new Run(scenarioFor('sailing-yacht-15m'))
      const s = run.scenario
      const ticks = run.until(minutesAt(weighsAt(s)) + 10)
      const stateAt = (ms: number) =>
        ticks.find((t) => t.ms >= ms)!.values.get('navigation.state')
      expect(stateAt(anchoredFrom(s) - MINUTE)).to.equal('motoring')
      expect(stateAt(anchoredFrom(s) + MINUTE)).to.equal('anchored')
      expect(stateAt(weighsAt(s) - MINUTE)).to.equal('anchored')
      expect(stateAt(weighsAt(s) + MINUTE)).to.equal('motoring')
      // weighed: the anchor's values cleared once, as the anchor alarm plugin clears them
      const cleared = ticks.filter(
        (t) => t.values.get('navigation.anchor.position') === null
      )
      expect(cleared).to.have.length(1)
      expect(cleared[0].values.get('navigation.anchor.maxRadius')).to.equal(
        null
      )
      expect(cleared[0].values.get('navigation.anchor.currentRadius')).to.equal(
        null
      )
      expect(cleared[0].ms).to.be.at.least(weighsAt(s))
      const after = ticks.filter((t) => t.ms > cleared[0].ms)
      expect(
        after.some((t) => t.values.has('navigation.anchor.position'))
      ).to.equal(false)
    })

    it('heaves in before she leaves, coming up to her anchor', () => {
      const run = new Run(scenarioFor('sailing-yacht-15m'))
      const s = run.scenario
      const ticks = run.until(minutesAt(weighsAt(s)))
      const radiusAt = (ms: number) =>
        num(
          ticks.find((t) => t.ms >= ms)!,
          'navigation.anchor.currentRadius'
        )
      expect(radiusAt(weighsAt(s) - 10 * MINUTE)).to.be.above(25)
      // at the last report, ten seconds out, three metres of chain are left to come in;
      // the antenna is half her length aft of the bow
      const lastReport = ticks
        .filter(
          (t) =>
            typeof t.values.get('navigation.anchor.currentRadius') === 'number'
        )
        .at(-1)!
      expect(num(lastReport, 'navigation.anchor.currentRadius')).to.be.within(
        7.5,
        16
      )
    })

    it('keeps the house going on the bank, the sun charging by day and the generator at meals, engines stopped', () => {
      const run = new Run(scenarioFor('motor-sailer-15m'))
      const s = run.scenario
      const ticks = run
        .until(minutesAt(weighsAt(s)) + 10)
        .filter(
          (t) => t.ms > anchoredFrom(s) + MINUTE && t.ms < weighsAt(s) - MINUTE
        )
      const profile = s.profile!
      for (const t of ticks) {
        const at = new Date(t.ms).toISOString()
        for (const e of profile.engines) {
          if (t.values.has(`propulsion.${e.id}.state`))
            expect(t.values.get(`propulsion.${e.id}.state`), at).to.equal(
              'stopped'
            )
        }
        for (const thruster of profile.thrusters) {
          if (t.values.has(`propulsion.${thruster.id}.state`))
            expect(
              t.values.get(`propulsion.${thruster.id}.state`),
              at
            ).to.equal('stopped')
        }
        expect(t.values.has('electrical.ac.shore.voltage'), at).to.equal(false)
      }
      const solar = ticks
        .map((t) => t.values.get('electrical.solar.array.panelPower'))
        .filter((w): w is number => typeof w === 'number')
      expect(solar.length).to.be.above(100)
      expect(Math.min(...solar)).to.be.above(0)
      const gen = profile.generators[0].id
      const generator = ticks.map(
        (t) => t.values.get(`propulsion.${gen}.state`) ?? undefined
      )
      expect(generator).to.include('started')
      // the house draws from its bank while nothing charges it
      expect(
        ticks.some((t) => num(t, 'electrical.batteries.house.current') < 0)
      ).to.equal(true)
      const after = run.ticks.find((t) => t.ms > weighsAt(s) + 2 * MINUTE)!
      expect(
        profile.engines.some(
          (e) => after.values.get(`propulsion.${e.id}.state`) === 'started'
        )
      ).to.equal(true)
    })

    it('sends only what the schema allows, the cleared anchor included', () => {
      const run = new Run(scenarioFor('sailing-yacht-15m', 1))
      const s = run.scenario
      const ticks = run.until(minutesAt(weighsAt(s)) + 5)
      const anchorDeltas = ticks
        .flatMap((t) => t.deltas)
        .filter((d) =>
          d.updates.some((u) =>
            u.values.some((v) => v.path.startsWith('navigation.anchor'))
          )
        )
      expect(anchorDeltas.length).to.be.above(100)
      for (const d of [anchorDeltas[0], anchorDeltas.at(-1)!]) {
        const v = schema.validateFull(
          schema.deltaToFull({
            ...forSchema(d),
            context: 'vessels.urn:mrn:imo:mmsi:239555210'
          })
        )
        expect(v.valid, JSON.stringify(v.errors)).to.equal(true)
      }
    })

    it('carries a stay at anchor on unchanged after a restart', () => {
      const s = scenarioFor('sailing-yacht-15m')
      const midStay = minutesAt(anchoredFrom(s)) + 60
      const unbroken = new Run(s)
      unbroken.until(midStay + 30)
      const first = new Run(s)
      first.until(midStay)
      const state: SystemsState = JSON.parse(
        JSON.stringify(first.sim.systems!.save())
      )
      const resumed = new Run(s, {
        scenarioStartMs: first.sim.systems!.scenarioMs,
        systemsState: state
      })
      resumed.until(midStay + 30)
      expect(resumed.sim.systems!.save()).to.deep.equal(
        unbroken.sim.systems!.save()
      )
    })
  })

  describe('the course', () => {
    it('holds the point after the anchorage through the stay, and makes for it once weighed', () => {
      const s = scenarioFor('sailing-yacht-15m')
      for (const ms of [
        anchoredFrom(s),
        anchoredFrom(s) + 60 * MINUTE,
        weighsAt(s) - 1,
        weighsAt(s) + MINUTE
      ]) {
        expect(nextPointIndex(s.legs, ms), new Date(ms).toISOString()).to.equal(
          2
        )
      }
      expect(nextPointIndex(s.legs, anchoredFrom(s) - MINUTE)).to.equal(1)
    })

    it('claims no arrival at the next point while she swings at anchor', () => {
      const delta = {
        context: 'vessels.urn:mrn:imo:mmsi:239555210',
        updates: [
          {
            values: [
              { path: 'navigation.course.calcValues.distance', value: 1200 },
              { path: 'navigation.course.calcValues.bearingTrue', value: 1.2 },
              { path: 'navigation.course.calcValues.timeToGo', value: 6000 },
              {
                path: 'navigation.course.calcValues.estimatedTimeOfArrival',
                value: '2018-07-13T17:00:00Z'
              },
              {
                path: 'navigation.course.calcValues.velocityMadeGood',
                value: 0.1
              },
              {
                path: 'navigation.course.calcValues.route.timeToGo',
                value: 90000
              },
              {
                path: 'navigation.course.calcValues.route.estimatedTimeOfArrival',
                value: '2018-07-14T17:00:00Z'
              },
              { path: 'performance.velocityMadeGoodToWaypoint', value: 0.1 },
              { path: 'navigation.course.calcValues.targetSpeed', value: 3 }
            ]
          }
        ]
      }
      const out = withoutArrivalClaims(delta)
      expect(
        Object.fromEntries(out.updates[0].values.map((v) => [v.path, v.value]))
      ).to.deep.equal({
        'navigation.course.calcValues.distance': 1200,
        'navigation.course.calcValues.bearingTrue': 1.2,
        'navigation.course.calcValues.timeToGo': null,
        'navigation.course.calcValues.estimatedTimeOfArrival': null,
        'navigation.course.calcValues.velocityMadeGood': null,
        'navigation.course.calcValues.route.timeToGo': null,
        'navigation.course.calcValues.route.estimatedTimeOfArrival': null,
        'performance.velocityMadeGoodToWaypoint': null,
        'navigation.course.calcValues.targetSpeed': null
      })
      // the delta as handed in is left as it was
      expect(delta.updates[0].values[2].value).to.equal(6000)
      const other = { updates: [{ values: [{ path: 'a.b', value: 1 }] }] }
      expect(withoutArrivalClaims(other)).to.equal(other)
    })
  })

  describe('the anchor watch', () => {
    it('raises past the radius, holds until back inside by the margin, then clears', () => {
      const r = 50
      expect(anchorWatch(false, 49, r)).to.equal(false)
      expect(anchorWatch(false, 50.1, r)).to.equal(true)
      expect(anchorWatch(true, 49, r)).to.equal(true)
      expect(anchorWatch(true, r - ANCHOR_WATCH_HOLD_M + 0.1, r)).to.equal(true)
      expect(anchorWatch(true, r - ANCHOR_WATCH_HOLD_M - 0.1, r)).to.equal(
        false
      )
    })

    it('raises nothing while she lies to her anchor', () => {
      const run = new Run(scenarioFor('sailing-yacht-15m'))
      const ticks = run.until(minutesAt(weighsAt(run.scenario)) + 10)
      expect(
        ticks.some((t) => t.values.has('notifications.navigation.anchor'))
      ).to.equal(false)
    })

    it('raises the anchor alarm as the anchor alarm plugin does when she drags, and clears it when the crew re-anchors', () => {
      const run = new Run(scenarioFor('sailing-yacht-15m'))
      const s = run.scenario
      run.until(minutesAt(anchoredFrom(s)) + 30)
      const before = run.sim.systems!.anchor!
      expect(before.watchRadiusM).to.be.closeTo(
        before.maxRadiusM + ANCHOR_WATCH_MARGIN_M,
        1e-9
      )
      const fault = run.sim.faults!.raise('anchorDragging')
      expect(fault.id).to.equal('anchorDragging:anchor')
      const dragging = run.until(minutesAt(anchoredFrom(s)) + 45)
      const raised = dragging.filter((t) =>
        t.values.has('notifications.navigation.anchor')
      )
      expect(raised).to.have.length(1)
      expect(
        raised[0].values.get('notifications.navigation.anchor')
      ).to.deep.equal({
        state: 'emergency',
        method: ['visual', 'sound'],
        message: 'Anchor Alarm - Emergency'
      })
      expect(num(raised[0], 'navigation.anchor.currentRadius')).to.be.above(
        before.watchRadiusM
      )
      // the anchor she reports stays where it went down while it drags
      expect(raised[0].values.get('navigation.anchor.position')).to.include({
        latitude: ANCHORAGE.lat,
        longitude: ANCHORAGE.lon
      })
      // downwind, at a dragging boat's pace
      const first = dragging[0]
      const last = dragging.at(-1)!
      const moved = metresBetween(
        { lat: position(first).latitude, lon: position(first).longitude },
        { lat: position(last).latitude, lon: position(last).longitude }
      )
      const s15 = 15 * 60
      expect(moved).to.be.within(
        0.7 * DRAG_KN * KNOT_MS * s15,
        1.3 * DRAG_KN * KNOT_MS * s15 + 20
      )
      expect(run.sim.alarms!.active().map((a) => a.path)).to.include(
        'notifications.navigation.anchor'
      )

      run.sim.faults!.clear('anchorDragging', 'anchor')
      const after = run.until(minutesAt(anchoredFrom(s)) + 50)
      const cleared = after.filter((t) =>
        t.values.has('notifications.navigation.anchor')
      )
      expect(cleared).to.have.length(1)
      expect(
        cleared[0].values.get('notifications.navigation.anchor')
      ).to.deep.equal({
        state: 'normal',
        method: [],
        message: 'Anchor Alarm - Emergency'
      })
      // set again where it now lies, with the radius for the depth there
      const now = run.sim.systems!.anchor!
      expect(metresBetween(now, before)).to.be.above(100)
      expect(now.maxRadiusM).to.be.closeTo(before.maxRadiusM, 1e-9)
      expect(now.currentRadiusM).to.be.below(now.maxRadiusM)
      expect(cleared[0].values.get('navigation.anchor.position')).to.include({
        latitude: now.lat,
        longitude: now.lon
      })
    })

    it('watches the radius set in the settings, and clears when the anchor is weighed', () => {
      const s = scenarioFor('sailing-yacht-15m', 1)
      const run = new Run(s, { anchorWatchRadiusM: 20 })
      const ticks = run.until(minutesAt(weighsAt(s)) + 5)
      expect(run.sim.systems!.anchor).to.equal(undefined)
      const states = ticks
        .map((t) => t.values.get('notifications.navigation.anchor'))
        .filter(Boolean)
        .map((n) => (n as { state: string }).state)
      expect(states).to.deep.equal(['emergency', 'normal'])
      const cleared = ticks.find(
        (t) =>
          (
            t.values.get('notifications.navigation.anchor') as
              { state: string } | undefined
          )?.state === 'normal'
      )!
      // she came up to her anchor as the crew heaved in, inside the set radius by the margin
      expect(cleared.ms).to.be.below(weighsAt(s) + MINUTE)
    })
  })

  describe('the dragging fault', () => {
    it('can be raised only at anchor, by hand or by the seed', () => {
      const s = scenarioFor('sailing-yacht-15m')
      const run = new Run(s)
      run.until(5)
      expect(() => run.sim.faults!.raise('anchorDragging')).to.throw(
        FaultError,
        /only while the boat lies at anchor/
      )
      expect(run.sim.faults!.available().map((k) => k.kind)).not.to.include(
        'anchorDragging'
      )
      run.until(minutesAt(anchoredFrom(s)) + 5)
      expect(
        run.sim.faults!.available().find((k) => k.kind === 'anchorDragging')
      ).to.include({ title: 'Anchor dragging' })

      // thrown by the seed, at a rate that throws faults often, it comes only at anchor
      const seeded = new Run(s, { faultsPerDay: 200 })
      const seen: { kind: string; ms: number }[] = []
      for (let m = 5; m < minutesAt(weighsAt(s)) + 60; m += 5) {
        seeded.until(m)
        for (const f of seeded.sim.faults!.active())
          if (f.kind === 'anchorDragging')
            seen.push({ kind: f.kind, ms: f.raisedMs })
      }
      expect(seen.length).to.be.above(0)
      for (const f of seen) {
        expect(f.ms).to.be.at.least(anchoredFrom(s))
        expect(f.ms).to.be.below(weighsAt(s))
      }
    })

    it('runs its course and re-anchors when it clears on its own, and ends when the anchor is weighed', () => {
      const s = scenarioFor('sailing-yacht-15m', 1)
      const run = new Run(s)
      run.until(minutesAt(anchoredFrom(s)) + 10)
      const set = run.sim.systems!.anchor!
      const fault = run.sim.faults!.raise('anchorDragging')
      run.until(minutesAt(fault.clearsMs!) + 2)
      expect(
        run.sim.faults!.active().filter((f) => f.kind === 'anchorDragging')
      ).to.deep.equal([])
      const reset = run.sim.systems!.anchor!
      expect(metresBetween(reset, set)).to.be.above(50)
      expect(run.sim.alarms!.active()).to.deep.equal([])

      const again = new Run(s)
      again.until(minutesAt(weighsAt(s)) - 3)
      again.sim.faults!.raise('anchorDragging')
      again.until(minutesAt(weighsAt(s)) + 2)
      expect(again.sim.faults!.active()).to.deep.equal([])
      expect(again.sim.alarms!.active()).to.deep.equal([])
    })
  })

  describe('the Saronic route', () => {
    it('anchors off Skala, on Angistri, in water to anchor in, for two and a half hours', async () => {
      const route = await loadRoute(SARONIC)
      const at = route.waypoints.findIndex((w) => w.anchor)
      const skala = route.waypoints[at]
      expect(skala.name).to.equal('Skala bay, Angistri')
      expect(skala.holdS).to.equal(2.5 * 3600)
      const depth = loadDepthModel(SARONIC, [
        { file: 'open/depth/emodnet-dtm2024-saronic.nc', format: 'netcdf' }
      ])
      const anchorage = new Anchorage(15, 1)
      const radius = anchorage.maxRadiusFor(depth.depth(skala.lat, skala.lon)!)
      expect(depth.depth(skala.lat, skala.lon)).to.be.within(5, 10)
      // the water all round, out to where she swings, has her draft and a metre under it
      for (let b = 0; b < 360; b += 30) {
        const r = (b * Math.PI) / 180
        const lat = skala.lat + (radius * Math.cos(r)) / 111195
        const lon =
          skala.lon +
          (radius * Math.sin(r)) /
            (111195 * Math.cos((skala.lat * Math.PI) / 180))
        expect(depth.depth(lat, lon), `${b}°`).to.be.above(2.2 + 1)
      }
      // the passage still ends inside the sample's AIS, which runs to 07:00 UTC
      const legs = routeLegs(route)
      expect(legs.at(-1)!.arriveMs).to.be.below(
        Date.parse('2018-07-14T07:00:00Z')
      )
    })
  })
})

function wrap(deg: number): number {
  return ((((deg + 180) % 360) + 360) % 360) - 180
}
