import { expect } from 'chai'
import path from 'path'
import {
  ADVANCE_LEAD_MS,
  Autopilot,
  FAILURE,
  OFF_TARGET_MS,
  PilotContext,
  PilotError,
  PilotUpdate,
  XTE_ALARM_M
} from '../simulator/autopilot/pilot'
import { Scenario } from '../simulator/engine/scenario'
import { Simulation, SimulationOptions } from '../simulator/engine/simulation'
import {
  Route,
  loadRoute,
  routeLegs,
  turnMiddleMs
} from '../simulator/routes/route'
import { Delta, forSchema } from '../simulator/soak/deltas'
import { loadProfile } from '../simulator/vessels/profile'
import { Environment } from '../simulator/weather/environment'

// eslint-disable-next-line @typescript-eslint/no-require-imports
const schema = require(
  require.resolve('@signalk/signalk-schema', {
    paths: [path.join(__dirname, '..', 'packages', 'streams')]
  })
)

const VESSELS = path.join(__dirname, '..', 'simulator', 'vessels')
const MIAMI = path.join(
  __dirname,
  '..',
  'simulator',
  'samples',
  'miami-icw-2024-03-16'
)
const START = Date.parse('2024-03-16T14:00:00Z')
const MINUTE = 60000
const RAD = Math.PI / 180
const wrap = (d: number) => ((((d + 180) % 360) + 360) % 360) - 180

/**
 * A steady wind from `fromDeg`, turning to `laterDeg` at `shiftMs` if given, read every
 * hour as a model would give it
 */
function windFrom(
  fromDeg: number,
  kn = 12,
  shiftMs?: number,
  laterDeg?: number
) {
  const ms: number[] = []
  const e: number[] = []
  const n: number[] = []
  const add = (t: number, deg: number) => {
    ms.push(t)
    e.push(kn * Math.sin(deg * RAD))
    n.push(kn * Math.cos(deg * RAD))
  }
  for (let t = START - 3600000; t <= START + 10 * 3600000; t += 3600000) {
    if (shiftMs !== undefined && t >= shiftMs && ms.at(-1)! < shiftMs) {
      add(shiftMs - 1000, fromDeg)
      add(shiftMs, laterDeg!)
    }
    add(t, shiftMs !== undefined && t >= shiftMs ? laterDeg! : fromDeg)
  }
  return new Environment([
    {
      id: 'wind',
      name: 'wind',
      lat: 25.5,
      lon: -80,
      series: { windE: { ms, v: e }, windN: { ms, v: n } }
    }
  ])
}

/** a berth, and ten miles north at 6 kn */
function scenarioFor(profileId: string, environment?: Environment): Scenario {
  const profile = loadProfile(profileId, VESSELS)
  const route: Route = {
    name: 'pilot test',
    departure: new Date(START + 5 * MINUTE).toISOString(),
    vessel: {
      description: profile.name,
      lengthM: profile.lengthM,
      draftM: profile.draftM,
      typeCode: profile.typeCode,
      profile: profile.id
    },
    source: 'test',
    waypoints: [
      { name: 'berth', lat: 25.5, lon: -80.0, speedKn: 6 },
      { name: 'north', lat: 25.6667, lon: -80.0 }
    ]
  }
  return {
    sampleId: 'test',
    route,
    plannedRoute: route,
    legs: routeLegs(route),
    adjustments: [],
    profile,
    depth: { depth: () => 20 } as unknown as Scenario['depth'],
    environment,
    notes: []
  }
}

interface Tick {
  ms: number
  values: Map<string, unknown>
}

class Run {
  readonly sim: Simulation
  readonly ticks: Tick[] = []
  readonly updates: { ms: number; u: PilotUpdate }[] = []
  readonly sent: Delta[] = []
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
        autopilotUpdate: (u) =>
          this.updates.push({ ms: this.sim.systems!.scenarioMs, u }),
        ...options
      },
      (d) => this.sent.push(d),
      0
    )
  }

  get pilot(): Autopilot {
    return this.sim.pilot!
  }

  until(minutes: number): Tick[] {
    const out: Tick[] = []
    while (this.sim.scenarioMs < START + minutes * MINUTE) {
      const from = this.sent.length
      this.wallMs += 1000
      this.sim.tick(this.wallMs)
      const values = new Map<string, unknown>()
      for (const d of this.sent.slice(from))
        for (const u of d.updates)
          for (const v of u.values) values.set(v.path, v.value)
      out.push({ ms: this.sim.systems!.scenarioMs, values })
    }
    this.ticks.push(...out)
    return out
  }

  alarms(path: string, state?: string) {
    return this.updates.filter(
      (x) =>
        x.u.alarm?.path === path &&
        (state === undefined || x.u.alarm.value.state === state)
    )
  }
}

const deg = (t: Tick, p: string) => (t.values.get(p) as number) / RAD

describe('Simulator autopilot', () => {
  describe('the provider', () => {
    it("gives a motor boat's states, route and compass modes and its actions", () => {
      const run = new Run(scenarioFor('motor-yacht-20m'))
      run.until(10)
      const data = run.pilot.data()
      expect(data.options.states).to.deep.equal([
        { name: 'auto', engaged: true },
        { name: 'standby', engaged: false }
      ])
      expect(data.options.modes).to.deep.equal(['route', 'compass'])
      expect(data.options.actions.map((a) => a.id)).to.deep.equal([
        'dodge',
        'courseCurrentPoint',
        'courseNextPoint'
      ])
      expect(data).to.include({
        state: 'standby',
        mode: 'route',
        engaged: false
      })
    })

    it('gives a sailing boat wind mode, and tack and gybe while steering to the wind', () => {
      const run = new Run(scenarioFor('sailing-yacht-15m', windFrom(315)))
      run.until(10)
      expect(run.pilot.data().options.modes).to.deep.equal([
        'route',
        'compass',
        'wind'
      ])
      run.pilot.engage()
      run.pilot.setMode('wind')
      const actions = run.pilot.data().options.actions
      expect(actions.find((a) => a.id === 'tack')).to.include({
        available: true
      })
      expect(actions.find((a) => a.id === 'gybe')).to.include({
        available: true
      })
    })

    it('gives the 4 m boat no pilot, the helm steering as before', () => {
      const run = new Run(scenarioFor('boat-4m'))
      expect(run.sim.pilot).to.equal(undefined)
    })
  })

  describe('the states', () => {
    it('refuses to engage alongside and at anchor, saying why, and engages under way', () => {
      const run = new Run(scenarioFor('motor-yacht-20m'))
      run.until(1)
      expect(() => run.pilot.engage()).to.throw(
        PilotError,
        /alongside her berth/
      )
      expect(run.pilot.refusal()).to.match(/alongside/)
      run.until(10)
      run.pilot.engage()
      expect(run.pilot.state).to.equal('auto')
      run.pilot.disengage()
      expect(run.pilot.state).to.equal('standby')
      run.pilot.setState('auto')
      expect(run.pilot.engaged).to.equal(true)
      expect(() => run.pilot.setState('drift')).to.throw(PilotError)
      expect(() => run.pilot.setMode('wind')).to.throw(
        PilotError,
        /no mode called wind/
      )
      expect(() => run.pilot.setTarget(1)).to.throw(
        PilotError,
        /route sets the target/
      )
      expect(() => run.pilot.tack('port')).to.throw(PilotError, /motor boat/)
      // every change goes to the Autopilot API, with the next send
      run.until(10.5)
      const states = run.updates.filter((x) => x.u.state).map((x) => x.u.state)
      expect(states).to.deep.equal(['auto', 'standby', 'auto'])
    })

    it('stands by on arriving alongside, with the route complete', () => {
      const run = new Run(scenarioFor('motor-yacht-20m'))
      run.until(10)
      run.pilot.engage()
      const arrive = run.scenario.legs[0].arriveMs
      run.until((arrive - START) / MINUTE + 2)
      expect(run.pilot.state).to.equal('standby')
      const complete = run.alarms('routeComplete', 'alert')
      expect(complete).to.have.length(1)
      expect(Math.abs(complete[0].ms - arrive)).to.be.at.most(10000)
    })
  })

  describe('compass mode', () => {
    it('holds the target heading within a degree once the turn has settled, off the route', () => {
      const run = new Run(scenarioFor('motor-yacht-20m'))
      run.until(10)
      run.pilot.engage()
      run.pilot.setMode('compass')
      run.pilot.setTarget(45 * RAD)
      run.until(13)
      const held = run.until(20)
      const headings = held.map((t) => deg(t, 'navigation.headingTrue'))
      const mean = headings.reduce((a, b) => a + b, 0) / headings.length
      expect(Math.abs(wrap(mean - 45))).to.be.below(1)
      for (const h of headings) expect(Math.abs(wrap(h - 45))).to.be.below(5)
      expect(run.pilot.onRoute).to.equal(false)
      // the specification's target agrees with the API's
      const last = held.at(-1)!
      expect(deg(last, 'steering.autopilot.target.headingTrue')).to.be.closeTo(
        45,
        0.01
      )
      const sentTarget = run.updates
        .filter((x) => x.u.target !== undefined)
        .at(-1)!.u.target!
      expect(sentTarget / RAD).to.be.closeTo(45, 1e-9)
    })

    it('adjusts the target by a degree and by ten', () => {
      const run = new Run(scenarioFor('motor-yacht-20m'))
      run.until(10)
      run.pilot.engage()
      run.pilot.setMode('compass')
      run.pilot.setTarget(90 * RAD)
      run.pilot.adjustTarget(10 * RAD)
      run.pilot.adjustTarget(-1 * RAD)
      expect(run.pilot.heldTargetDeg.headingDeg).to.be.closeTo(99, 1e-9)
    })
  })

  describe('wind mode', () => {
    it('holds the apparent wind angle, her heading following a shift', () => {
      const shift = START + 20 * MINUTE
      const run = new Run(
        scenarioFor('sailing-yacht-15m', windFrom(315, 12, shift, 345))
      )
      run.until(10)
      run.pilot.engage()
      run.pilot.setMode('wind')
      const target = run.pilot.heldTargetDeg.awaDeg!
      const before = run.until(19).at(-1)!
      run.until(25)
      const after = run.until(27)
      const awa = after.map((t) => deg(t, 'environment.wind.angleApparent'))
      const mean = awa.reduce((a, b) => a + b, 0) / awa.length
      // the seed's gusts and shifts ride on the wind, so within a few degrees
      expect(Math.abs(wrap(mean - target))).to.be.below(5)
      // she turned with the wind: the 30° shift and the seed's own shifts on it
      const turned = wrap(
        deg(after.at(-1)!, 'navigation.headingTrue') -
          deg(before, 'navigation.headingTrue')
      )
      const veered = wrap(
        deg(after.at(-1)!, 'environment.wind.directionTrue') -
          deg(before, 'environment.wind.directionTrue')
      )
      expect(veered).to.be.within(15, 45)
      expect(turned).to.be.closeTo(veered, 6)
      expect(
        deg(after.at(-1)!, 'steering.autopilot.target.windAngleApparent')
      ).to.be.closeTo(target, 0.01)
    })

    it('tacks through the wind on the sailing profile', () => {
      const run = new Run(scenarioFor('sailing-yacht-15m', windFrom(315)))
      run.until(10)
      run.pilot.engage()
      run.pilot.setMode('wind')
      const before = run.until(12).at(-1)!
      const awaBefore = deg(before, 'environment.wind.angleApparent')
      expect(awaBefore).to.be.below(0)
      expect(() => run.pilot.tack('starboard')).to.throw(PilotError, /port bow/)
      expect(() => run.pilot.gybe('port')).to.throw(PilotError)
      run.pilot.tack('port')
      const after = run.until(16).at(-1)!
      expect(deg(after, 'environment.wind.angleApparent')).to.be.above(0)
      expect(
        wrap(
          deg(after, 'navigation.headingTrue') -
            deg(before, 'navigation.headingTrue')
        )
      ).to.be.below(-60)
    })
  })

  it('holds the nearest heading in a light air that cannot give the angle, and says so', () => {
    const run = new Run(scenarioFor('sailing-yacht-15m', windFrom(315, 2)))
    run.until(10)
    run.pilot.engage()
    run.pilot.setMode('wind')
    run.pilot.setTarget(45 * RAD)
    run.until(14)
    const held = run.until(17).map((t) => deg(t, 'navigation.headingTrue'))
    // she does not go round in circles chasing it: the heading moves only with the seed's
    // gusts and shifts, which in a 2 kn air are as large as the wind itself
    for (const h of held) expect(Math.abs(wrap(h - held[0]))).to.be.below(60)
    expect(run.alarms('wind', 'warn')).to.have.length(1)
  })

  describe('a dodge', () => {
    it('puts the rudder over for as long as it is held, then back to the target', () => {
      const run = new Run(scenarioFor('motor-yacht-20m'))
      run.until(10)
      run.pilot.engage()
      run.pilot.setMode('compass')
      run.pilot.setTarget(0)
      run.until(12)
      run.pilot.dodge(10 * RAD)
      expect(run.pilot.mode).to.equal('dodge')
      const dodging = run.until(13)
      const rudder = dodging.map((t) => deg(t, 'steering.rudderAngle'))
      expect(rudder.at(-1)).to.be.closeTo(10, 2)
      expect(deg(dodging.at(-1)!, 'navigation.rateOfTurn')).to.be.above(0.3)
      run.pilot.dodge(null)
      expect(run.pilot.mode).to.equal('compass')
      const back = run.until(16).at(-1)!
      expect(Math.abs(wrap(deg(back, 'navigation.headingTrue')))).to.be.below(5)
    })
  })

  describe('leaving and rejoining the route', () => {
    it('rejoins at the nearest point ahead, the route timing resumed, the cross track error raised and cleared once', () => {
      const run = new Run(scenarioFor('motor-yacht-20m'))
      run.until(10)
      run.pilot.engage()
      run.pilot.setMode('compass')
      run.pilot.setTarget(90 * RAD)
      run.until(15)
      expect(run.pilot.onRoute).to.equal(false)
      const behind = run.sim.scenarioMs - run.sim.routeMs(run.sim.scenarioMs)
      expect(behind).to.be.above(4 * MINUTE)
      run.pilot.setMode('route')
      expect(run.pilot.rejoin!.distanceM).to.be.above(XTE_ALARM_M)
      run.until(25)
      expect(run.pilot.onRoute).to.equal(true)
      expect(run.alarms('xte', 'warn')).to.have.length(1)
      expect(run.alarms('xte', 'normal')).to.have.length(1)
      // on the route again, she is where the route has her at its own time
      const t = run.ticks.at(-1)!
      const pos = t.values.get('navigation.position') as {
        latitude: number
        longitude: number
      }
      expect(pos.longitude).to.be.closeTo(-80, 0.0005)
    })

    it('rejoins with the helm when the pilot is put to standby off the route', () => {
      const run = new Run(scenarioFor('motor-yacht-20m'))
      run.until(10)
      run.pilot.engage()
      run.pilot.setMode('compass')
      run.pilot.setTarget(270 * RAD)
      run.until(13)
      run.pilot.disengage()
      expect(run.pilot.rejoin).to.not.equal(undefined)
      run.until(22)
      expect(run.pilot.onRoute).to.equal(true)
    })

    it('carries on exactly after a restart, off the route', () => {
      const s = scenarioFor('motor-yacht-20m')
      const unbroken = new Run(s)
      unbroken.until(10)
      unbroken.pilot.engage()
      unbroken.pilot.setMode('compass')
      unbroken.pilot.setTarget(60 * RAD)
      unbroken.until(14)
      const first = new Run(s)
      first.until(10)
      first.pilot.engage()
      first.pilot.setMode('compass')
      first.pilot.setTarget(60 * RAD)
      first.until(12)
      const resumed = new Run(s, {
        scenarioStartMs: first.sim.systems!.scenarioMs,
        systemsState: JSON.parse(JSON.stringify(first.sim.systems!.save())),
        pilotState: JSON.parse(JSON.stringify(first.pilot.save()))
      })
      resumed.until(14)
      expect(resumed.pilot.save()).to.deep.equal(unbroken.pilot.save())
      expect(resumed.sim.systems!.save()).to.deep.equal(
        unbroken.sim.systems!.save()
      )
    })
  })

  describe('the alarms on Miami', () => {
    it('raises the waypoint advance before each turn, the arrival at it, and the route complete at the end, each once', async () => {
      const route = await loadRoute(MIAMI)
      const legs = routeLegs(route)
      const profile = loadProfile(route.vessel.profile!, VESSELS)
      const scenario: Scenario = {
        sampleId: 'miami',
        route,
        plannedRoute: route,
        legs,
        adjustments: [],
        profile,
        depth: { depth: () => 10 } as unknown as Scenario['depth'],
        notes: []
      }
      const sim: { updates: { ms: number; u: PilotUpdate }[] } = { updates: [] }
      const s: Simulation = new Simulation(
        scenario,
        {
          timeMultiplier: 5,
          showTraffic: false,
          scenarioStartMs: legs[0].departMs + MINUTE,
          seed: 1,
          autopilotUpdate: (u) =>
            sim.updates.push({ ms: s.systems!.scenarioMs, u })
        },
        () => {},
        0
      )
      let wall = 0
      const end = legs.at(-1)!.arriveMs + 5 * MINUTE
      while (s.scenarioMs < end) {
        wall += 1000
        s.tick(wall)
        if (
          !s.pilot!.engaged &&
          !s.pilot!.refusal() &&
          s.scenarioMs < legs.at(-1)!.arriveMs
        ) {
          s.pilot!.engage()
        }
      }
      const raised = (path: string) =>
        sim.updates.filter(
          (x) => x.u.alarm?.path === path && x.u.alarm.value.state !== 'normal'
        )
      // a turning waypoint: its advance before the turn, its arrival abeam of it, once each
      const i = legs.findIndex((l, k) => k > 3 && l.turn)
      const leg = legs[i]
      const name = (x: { u: PilotUpdate }) => x.u.alarm!.value.message
      const advance = raised('waypointAdvance').filter((x) =>
        name(x).endsWith(leg.to.name ?? `point ${i + 1}`)
      )
      const arrival = raised('waypointArrival').filter((x) =>
        name(x).endsWith(leg.to.name ?? `point ${i + 1}`)
      )
      expect(advance).to.have.length(1)
      expect(arrival).to.have.length(1)
      expect(
        Math.abs(advance[0].ms - (leg.turn!.startMs - ADVANCE_LEAD_MS))
      ).to.be.at.most(5000)
      expect(Math.abs(arrival[0].ms - turnMiddleMs(leg.turn!))).to.be.at.most(
        5000
      )
      // every point of the route has its arrival, once, and the last is the route complete
      expect(raised('waypointArrival')).to.have.length(legs.length - 1)
      expect(raised('routeComplete')).to.have.length(1)
      expect(
        Math.abs(raised('routeComplete')[0].ms - legs.at(-1)!.arriveMs)
      ).to.be.at.most(5000)
      // she holds the route: no cross track error, and nothing off target in route mode
      expect(raised('xte')).to.deep.equal([])
      expect(raised('heading')).to.deep.equal([])
    })
  })

  describe('the off-target alarms', () => {
    const legs = routeLegs({
      name: 't',
      departure: new Date(START).toISOString(),
      vessel: { description: 't', lengthM: 15, draftM: 2, typeCode: 37 },
      source: 't',
      waypoints: [
        { lat: 25.5, lon: -80, speedKn: 6 },
        { lat: 25.6, lon: -80 }
      ]
    })
    const ctx = (headingDeg: number): PilotContext => ({
      headingDeg,
      windKn: 12,
      windDeg: 315,
      currentKn: 0,
      currentToDeg: 0,
      failed: false
    })

    it('raises heading once when she cannot hold the target, and clears it when she does', () => {
      const p = new Autopilot({ lengthM: 15, sail: true, legs })
      p.step(START + MINUTE, 2, ctx(0))
      p.engage()
      p.setMode('compass')
      p.setTarget(90 * RAD)
      p.takeUpdates()
      // her heading stuck where it was: the error does not close
      for (let t = 0; t <= OFF_TARGET_MS + 10000; t += 2000)
        p.step(START + 2 * MINUTE + t, 2, ctx(0))
      const raised = p.takeUpdates().filter((u) => u.alarm?.path === 'heading')
      expect(raised).to.have.length(1)
      expect(raised[0].alarm!.value.state).to.equal('warn')
      p.step(START + 4 * MINUTE, 2, ctx(85))
      expect(
        p.takeUpdates().filter((u) => u.alarm?.path === 'heading')[0].alarm!
          .value.state
      ).to.equal('normal')
    })

    it('raises wind once in wind mode when the angle cannot be held', () => {
      const p = new Autopilot({ lengthM: 15, sail: true, legs })
      p.step(START + MINUTE, 2, ctx(0))
      p.engage()
      p.setMode('wind')
      p.setTarget(-120 * RAD)
      p.takeUpdates()
      for (let t = 0; t <= OFF_TARGET_MS + 10000; t += 2000)
        p.step(START + 2 * MINUTE + t, 2, { ...ctx(0) })
      expect(
        p
          .takeUpdates()
          .filter(
            (u) => u.alarm?.path === 'wind' && u.alarm.value.state === 'warn'
          )
      ).to.have.length(1)
    })
  })

  describe('the pilot fault', () => {
    it('drops her to standby under way with the alarm, refuses to engage, and engages once cleared', () => {
      const run = new Run(scenarioFor('motor-yacht-20m'))
      run.until(1)
      expect(run.sim.faults!.available().map((k) => k.kind)).not.to.include(
        'autopilotFailure'
      )
      run.until(10)
      run.pilot.engage()
      run.sim.faults!.raise('autopilotFailure')
      run.until(11)
      expect(run.pilot.state).to.equal('standby')
      const alarm = run.alarms('heading', 'alarm')
      expect(alarm).to.have.length(1)
      expect(alarm[0].u.alarm!.value.message).to.equal(FAILURE)
      expect(() => run.pilot.engage()).to.throw(PilotError, /fault/)
      run.sim.faults!.clear('autopilotFailure', 'autopilot')
      run.until(12)
      expect(run.alarms('heading', 'normal')).to.have.length(1)
      run.pilot.engage()
      expect(run.pilot.engaged).to.equal(true)
    })
  })

  it('sends only what the schema allows', () => {
    const run = new Run(scenarioFor('sailing-yacht-15m', windFrom(315)))
    run.until(10)
    run.pilot.engage()
    run.pilot.setMode('wind')
    run.until(11)
    run.pilot.setMode('compass')
    run.until(12)
    const pilotDeltas = run.sent.filter((d) =>
      d.updates.some((u) =>
        u.values.some((v) => v.path.startsWith('steering.autopilot'))
      )
    )
    expect(pilotDeltas.length).to.be.above(10)
    for (const d of [pilotDeltas[0], pilotDeltas.at(-1)!]) {
      const v = schema.validateFull(
        schema.deltaToFull({
          ...forSchema(d),
          context: 'vessels.urn:mrn:imo:mmsi:239555210'
        })
      )
      expect(v.valid, JSON.stringify(v.errors)).to.equal(true)
    }
  })
})
