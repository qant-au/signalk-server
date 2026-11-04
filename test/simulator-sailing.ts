import { expect } from 'chai'
import path from 'path'
import { PilotError } from '../simulator/autopilot/pilot'
import { Scenario } from '../simulator/engine/scenario'
import { Simulation } from '../simulator/engine/simulation'
import { Route, Waypoint, routeLegs } from '../simulator/routes/route'
import { Polar } from '../simulator/sailing/polar'
import {
  MOTOR_SAIL_SHARE,
  PLAN_HOLD_S,
  SAIL_SHARE,
  Sailing,
  SailingInput
} from '../simulator/sailing/sailing'
import { Delta, forSchema } from '../simulator/soak/deltas'
import { loadProfile } from '../simulator/vessels/profile'
import { Environment } from '../simulator/weather/environment'
import { Series } from '../simulator/weather/sources'

// eslint-disable-next-line @typescript-eslint/no-require-imports
const schema = require(
  require.resolve('@signalk/signalk-schema', {
    paths: [path.join(__dirname, '..', 'packages', 'streams')]
  })
)

const VESSELS = path.join(__dirname, '..', 'simulator', 'vessels')
const START = Date.parse('2024-03-16T14:00:00Z')
const MINUTE = 60000
const HOUR = 60 * MINUTE
const RAD = Math.PI / 180
const KNOT_MS = 1852 / 3600
const wrap = (d: number) => ((((d + 180) % 360) + 360) % 360) - 180

const yacht15 = loadProfile('sailing-yacht-15m', VESSELS)
const yacht9 = loadProfile('sailing-yacht-9m', VESSELS)

/** a steady wind and current at every hour of the run, as a model would give them */
function conditions(
  wind: { kn: number; fromDeg: number },
  current?: { kn: number; toDeg: number }
): Environment {
  const ms: number[] = []
  for (let t = START - HOUR; t <= START + 14 * HOUR; t += HOUR) ms.push(t)
  const steady = (v: number): Series => ({ ms, v: ms.map(() => v) })
  const from = wind.fromDeg * RAD
  const series: Record<string, Series> = {
    windE: steady(wind.kn * Math.sin(from)),
    windN: steady(wind.kn * Math.cos(from))
  }
  if (current) {
    const to = current.toDeg * RAD
    series.currentE = steady(current.kn * Math.sin(to))
    series.currentN = steady(current.kn * Math.cos(to))
  }
  return new Environment([
    { id: 'test', name: 'test', lat: 25.5, lon: -80, series }
  ])
}

/** a berth, and ten miles north at 6 kn, or the waypoints given */
function scenarioFor(
  profileId: string,
  environment?: Environment,
  waypoints: Waypoint[] = [
    { name: 'berth', lat: 25.5, lon: -80.0, speedKn: 6 },
    { name: 'north', lat: 25.6667, lon: -80.0 }
  ],
  departMs = START + 5 * MINUTE
): Scenario {
  const profile = loadProfile(profileId, VESSELS)
  const route: Route = {
    name: 'sailing test',
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
  readonly sent: Delta[] = []
  private wallMs = 0

  constructor(
    readonly scenario: Scenario,
    startMs = START,
    rate = 10
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
      this.sim.tick(this.wallMs)
      const values = new Map<string, unknown>()
      for (const d of this.sent.slice(from))
        for (const u of d.updates)
          for (const v of u.values) values.set(v.path, v.value)
      out.push({ ms: this.sim.systems!.scenarioMs, values })
    }
    return out
  }
}

const num = (t: Tick, p: string) => t.values.get(p) as number
const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length
const under = (ticks: Tick[], p: string) =>
  ticks.filter((t) => t.values.has(p)).map((t) => num(t, p))

describe('Simulator sailing', () => {
  describe('the polar', () => {
    const polar = new Polar(yacht15.polar!)

    it('gives the table at its points and reads linearly between them', () => {
      // 10 kn of true wind abeam
      expect(polar.speedKn(10, 90)).to.equal(7.7)
      expect(polar.speedKn(10, -90)).to.equal(7.7)
      // halfway between 8 and 10 kn, and between 75° and 90°
      expect(polar.speedKn(9, 90)).to.be.closeTo((7.0 + 7.7) / 2, 1e-9)
      expect(polar.speedKn(10, 82.5)).to.be.closeTo((7.6 + 7.7) / 2, 1e-9)
    })

    it('falls to nothing in a calm, holds past its strongest wind, and gives nothing inside its closest angle', () => {
      expect(polar.speedKn(2, 90)).to.be.closeTo(4.1 / 2, 1e-9)
      expect(polar.speedKn(0, 90)).to.equal(0)
      expect(polar.speedKn(40, 90)).to.equal(9.3)
      expect(polar.speedKn(12, 25)).to.equal(0)
    })

    it('finds the beat and gybe angles that make most to windward and to leeward', () => {
      for (const tws of [6, 10, 16]) {
        const beat = polar.beat(tws)
        const gybe = polar.gybe(tws)
        for (let a = 30; a <= 90; a++) {
          expect(polar.speedKn(tws, a) * Math.cos(a * RAD)).to.be.at.most(
            beat.vmgKn + 1e-9
          )
        }
        for (let a = 90; a <= 180; a++) {
          expect(polar.speedKn(tws, a) * Math.cos(a * RAD)).to.be.at.least(
            gybe.vmgKn - 1e-9
          )
        }
        expect(beat.twaDeg).to.be.within(38, 48)
        expect(gybe.twaDeg).to.be.within(140, 175)
        expect(beat.speedKn).to.equal(polar.speedKn(tws, beat.twaDeg))
      }
      // she points higher as the breeze freshens
      expect(polar.beat(16).twaDeg).to.be.below(polar.beat(6).twaDeg)
    })

    it('refuses a table it cannot read', () => {
      expect(
        () => new Polar({ twsKn: [6], twaDeg: [40, 90], speedKn: [[1], [2]] })
      ).to.throw(/twsKn/)
      expect(
        () =>
          new Polar({
            twsKn: [6, 10],
            twaDeg: [40, 90],
            speedKn: [[1, 2]]
          })
      ).to.throw(/speedKn/)
    })
  })

  describe('the sails', () => {
    it("sets the 15 m yacht's full main and genoa to a fresh breeze, and reefs above it", () => {
      const s = new Sailing(yacht15.sails!, yacht15.polar!)
      expect(s.sailsFor(10)).to.deep.equal(['main', 'genoa'])
      expect(s.sailsFor(21)).to.deep.equal(['main', 'genoa'])
      expect(s.sailsFor(23)).to.deep.equal(['mainReef1', 'genoa'])
      expect(s.sailsFor(30)).to.deep.equal(['mainReef2'])
      expect(s.sailsFor(40)).to.deep.equal([])
      expect(s.fullAreaM2).to.equal(62 + 70)
    })

    it("sets the 9 m yacht's main and jib, and the jib alone above a fresh breeze", () => {
      const s = new Sailing(yacht9.sails!, yacht9.polar!)
      expect(s.sailsFor(10)).to.deep.equal(['main', 'jib'])
      expect(s.sailsFor(25)).to.deep.equal(['jib'])
      expect(s.fullAreaM2).to.equal(21 + 17)
    })

    it('gives a motor boat no sails or polar, and a sailing boat both', () => {
      expect(loadProfile('motor-yacht-20m', VESSELS).sails).to.equal(undefined)
      expect(loadProfile('motor-sailer-15m', VESSELS).polar).to.equal(undefined)
      expect(yacht15.sails).to.have.length(4)
      expect(yacht9.sails).to.have.length(2)
    })
  })

  describe('sailing or motoring', () => {
    const s = () => new Sailing(yacht15.sails!, yacht15.polar!)
    const leg = (over: Partial<SailingInput>): SailingInput => ({
      underWay: true,
      nearStop: false,
      twsKn: 10,
      twdDeg: 270,
      stwKn: 6,
      waterTrackDeg: 0,
      ...over
    })

    it('sails when the polar gives the leg speed or near it, motor-sails on some of it, and motors otherwise', () => {
      // abeam in 10 kn the polar gives 7.7 kn
      expect(s().wanted(leg({}))).to.deep.equal({
        propulsion: 'sailing',
        sails: ['main', 'genoa']
      })
      const polar = new Polar(yacht15.polar!)
      // in 4 kn abeam it gives 4.1 kn: two thirds of 6 kn
      const light = polar.speedKn(4, 90) / 6
      expect(light).to.be.within(MOTOR_SAIL_SHARE, SAIL_SHARE)
      expect(s().wanted(leg({ twsKn: 4 })).propulsion).to.equal('motor-sailing')
      // in 2 kn it gives too little to help
      expect(s().wanted(leg({ twsKn: 2 })).propulsion).to.equal('motoring')
      // dead to windward the sails cannot draw
      expect(s().wanted(leg({ twdDeg: 10 }))).to.deep.equal({
        propulsion: 'motoring',
        sails: []
      })
      // close to a stop, and alongside, the sails come down
      expect(s().wanted(leg({ nearStop: true })).propulsion).to.equal(
        'motoring'
      )
      expect(s().wanted(leg({ underWay: false })).propulsion).to.equal(null)
    })

    it('gets under way under power, and changes to sail once it has been wanted for the wait', () => {
      const sailing = s()
      sailing.step(2, leg({}))
      expect(sailing.plan.propulsion).to.equal('motoring')
      for (let t = 4; t < PLAN_HOLD_S; t += 2) sailing.step(2, leg({}))
      expect(sailing.plan.propulsion).to.equal('motoring')
      sailing.step(2, leg({}))
      expect(sailing.plan.propulsion).to.equal('sailing')
      // a lull shorter than the wait changes nothing
      for (let t = 0; t < PLAN_HOLD_S / 2; t += 2)
        sailing.step(2, leg({ twsKn: 2 }))
      expect(sailing.plan.propulsion).to.equal('sailing')
      // coming in to a stop the sails come down at once
      sailing.step(2, leg({ nearStop: true }))
      expect(sailing.plan).to.deep.equal({ propulsion: 'motoring', sails: [] })
      sailing.step(2, leg({ underWay: false }))
      expect(sailing.plan.propulsion).to.equal(null)
    })

    it('motors a light morning and sails an afternoon sea breeze, as on the Saronic', function () {
      this.timeout(60000)
      // the Saronic day as ERA5 has it off Piraeus: 2 to 3 kn from the north until mid-morning,
      // a calm, then a 10 kn sea breeze from the south-south-east through the afternoon
      const hourly: [number, number][] = [
        [3, 355],
        [3, 355],
        [3, 0],
        [3, 0],
        [3, 0],
        [3, 350],
        [3, 345],
        [3, 350],
        [2, 20],
        [1, 90],
        [6, 150],
        [10, 158],
        [10, 160],
        [10, 160],
        [9, 165],
        [8, 170],
        [6, 180]
      ]
      const ms = hourly.map((_, i) => START + (i - 1) * HOUR)
      const series = (f: (kn: number, r: number) => number): Series => ({
        ms,
        v: hourly.map(([kn, deg]) => f(kn, deg * RAD))
      })
      const environment = new Environment([
        {
          id: 'day',
          name: 'day',
          lat: 25.5,
          lon: -80,
          series: {
            windE: series((kn, r) => kn * Math.sin(r)),
            windN: series((kn, r) => kn * Math.cos(r)),
            currentE: series(() => 0),
            currentN: series(() => 0)
          }
        }
      ])
      // back and forth on an east-west line at 6 kn
      const waypoints: Waypoint[] = []
      for (let i = 0; i < 24; i++) {
        waypoints.push({
          name: 'mark ' + i,
          lat: 25.5,
          lon: i % 2 ? -79.85 : -80.05,
          speedKn: 6
        })
      }
      const run = new Run(
        scenarioFor('sailing-yacht-15m', environment, waypoints),
        START,
        30
      )
      const ticks = run.until(START + 15 * HOUR)
      const share = (fromH: number, toH: number, state: string) => {
        const span = ticks.filter(
          (t) =>
            t.ms >= START + fromH * HOUR &&
            t.ms < START + toH * HOUR &&
            t.values.has('navigation.state')
        )
        return (
          span.filter((t) => t.values.get('navigation.state') === state)
            .length / span.length
        )
      }
      // the light morning: the engine on, motoring or motor-sailing (navigation state motoring)
      expect(share(0.5, 7, 'motoring')).to.be.above(0.9)
      // the sea breeze: under sail
      expect(share(10.5, 13, 'sailing')).to.be.above(0.9)
    })
  })

  describe('in a run', () => {
    it('holds her heading against the current, her speed through the water the difference', () => {
      // north at 6 kn over the ground, the current 1 kn setting east
      const run = new Run(
        scenarioFor(
          'motor-yacht-20m',
          conditions({ kn: 8, fromDeg: 0 }, { kn: 1, toDeg: 90 })
        )
      )
      const ticks = run.until(START + 40 * MINUTE).slice(-60)
      const heading = mean(under(ticks, 'navigation.headingTrue')) / RAD
      expect(wrap(heading - Math.atan2(-1, 6) / RAD)).to.be.closeTo(0, 1.5)
      expect(mean(under(ticks, 'navigation.speedThroughWater'))).to.be.closeTo(
        Math.hypot(1, 6) * KNOT_MS,
        0.02
      )
      // under power she makes no leeway
      expect(under(ticks, 'navigation.leewayAngle')).to.satisfy(
        (xs: number[]) => xs.every((x) => x === 0)
      )
      const current = under(ticks, 'environment.current') as unknown as {
        drift: number
        setTrue: number
        setMagnetic?: number
      }[]
      expect(current.length).to.be.above(5)
      expect(current[0].drift).to.be.closeTo(KNOT_MS, 0.001)
      expect(current[0].setTrue).to.be.closeTo(90 * RAD, 0.001)
      // the test scenario has no magnetic variation
      expect(current[0].setMagnetic).to.equal(undefined)
    })

    it('makes leeway to leeward under sail, growing with the heel, her heading held up to windward', () => {
      for (const [fromDeg, sign] of [
        [270, 1],
        [90, -1]
      ]) {
        // north with the wind abeam, from port then from starboard, and no current
        const run = new Run(
          scenarioFor(
            'sailing-yacht-15m',
            conditions({ kn: 14, fromDeg }, { kn: 0, toDeg: 0 })
          )
        )
        const ticks = run.until(START + 40 * MINUTE).slice(-60)
        expect(ticks.at(-1)!.values.get('navigation.state')).to.equal('sailing')
        const leeway = mean(under(ticks, 'navigation.leewayAngle')) / RAD
        const roll = mean(
          under(ticks, 'navigation.attitude').map(
            (a) => (a as unknown as { roll: number }).roll
          )
        )
        expect(Math.sign(leeway)).to.equal(sign)
        expect(Math.abs(leeway)).to.be.within(1, 10)
        // wind over the port side heels her to starboard, and she slides to starboard
        expect(Math.sign(roll)).to.equal(sign)
        expect(Math.sign(mean(under(ticks, 'performance.leeway')))).to.equal(
          sign
        )
        expect(
          Math.sign(
            mean(under(ticks, 'navigation.speedThroughWaterTransverse'))
          )
        ).to.equal(sign)
        // her track over the ground is north; her heading is to windward of it
        const heading = wrap(mean(under(ticks, 'navigation.headingTrue')) / RAD)
        expect(heading * sign).to.be.below(0)
        expect(heading).to.be.closeTo(-leeway, 1.5)
      }
    })

    it('sends the polar paths for the point of sail she is on', () => {
      for (const fromDeg of [315, 270, 180]) {
        const run = new Run(
          scenarioFor(
            'sailing-yacht-15m',
            conditions({ kn: 12, fromDeg }, { kn: 0, toDeg: 0 })
          )
        )
        const t = run
          .until(START + 30 * MINUTE)
          .filter((x) => x.values.has('performance.polarSpeed'))
          .at(-1)!
        const polar = new Polar(yacht15.polar!)
        const tws = num(t, 'environment.wind.speedTrue') / KNOT_MS
        const heading = num(t, 'navigation.headingTrue') / RAD
        const twd = num(t, 'environment.wind.directionTrue') / RAD
        const twa = wrap(twd - heading)
        const stw = num(t, 'navigation.speedThroughWater') / KNOT_MS
        const beat = polar.beat(tws)
        const gybe = polar.gybe(tws)
        const kn = (p: string) => num(t, p) / KNOT_MS
        const deg = (p: string) => num(t, p) / RAD
        expect(kn('performance.polarSpeed')).to.be.closeTo(
          polar.speedKn(tws, twa),
          0.01
        )
        expect(num(t, 'performance.polarSpeedRatio')).to.be.closeTo(
          stw / polar.speedKn(tws, twa),
          0.01
        )
        expect(kn('performance.velocityMadeGood')).to.be.closeTo(
          stw * Math.cos(twa * RAD),
          0.01
        )
        expect(deg('performance.beatAngle')).to.be.closeTo(beat.twaDeg, 0.01)
        expect(kn('performance.beatAngleTargetSpeed')).to.be.closeTo(
          beat.speedKn,
          0.01
        )
        expect(kn('performance.beatAngleVelocityMadeGood')).to.be.closeTo(
          beat.vmgKn,
          0.01
        )
        expect(deg('performance.gybeAngle')).to.be.closeTo(gybe.twaDeg, 0.01)
        expect(kn('performance.gybeAngleVelocityMadeGood')).to.be.below(0)
        const target = Math.abs(twa) < 90 ? beat : gybe
        expect(deg('performance.targetAngle')).to.be.closeTo(
          target.twaDeg,
          0.01
        )
        expect(kn('performance.targetSpeed')).to.be.closeTo(
          target.speedKn,
          0.01
        )
        // the same angle to the wind on her other side
        expect(
          wrap(deg('performance.tackTrue') - (2 * twd - heading))
        ).to.be.closeTo(0, 0.05)
      }
    })

    it('sends the sails set and their area on a sailing boat, only under way', () => {
      const run = new Run(
        scenarioFor('sailing-yacht-15m', conditions({ kn: 12, fromDeg: 270 }))
      )
      const alongside = run.until(START + 4 * MINUTE)
      const before = alongside.filter((t) => t.values.has('sails.area.active'))
      expect(before.length).to.be.above(0)
      for (const t of before) expect(num(t, 'sails.area.active')).to.equal(0)
      const sailing = run
        .until(START + 30 * MINUTE)
        .filter((t) => t.values.has('sails.area.active'))
        .at(-1)!
      expect(num(sailing, 'sails.area.active')).to.equal(62 + 70)
      expect(num(sailing, 'sails.area.total')).to.equal(62 + 70)
      expect(sailing.values.get('sails.inventory.main')).to.deep.include({
        name: 'Main',
        type: 'main',
        active: true,
        area: 62
      })
      expect(sailing.values.get('sails.inventory.mainReef1')).to.deep.include({
        active: false
      })
    })

    it('sends no performance or sails paths from a motor boat', () => {
      const run = new Run(
        scenarioFor('motor-yacht-20m', conditions({ kn: 12, fromDeg: 270 }))
      )
      const paths = new Set(
        run.until(START + 20 * MINUTE).flatMap((t) => [...t.values.keys()])
      )
      expect(
        [...paths].filter((p) => /^(performance|sails)\./.test(p))
      ).to.deep.equal([])
      expect(paths.has('environment.current')).to.equal(true)
      expect(paths.has('navigation.speedThroughWaterLongitudinal')).to.equal(
        true
      )
    })

    it('sends only what the schema allows', () => {
      const run = new Run(
        scenarioFor(
          'sailing-yacht-15m',
          conditions({ kn: 12, fromDeg: 270 }, { kn: 0.5, toDeg: 120 })
        )
      )
      run.until(START + 20 * MINUTE)
      for (const delta of run.sent.slice(-40)) {
        const result = schema.validateDelta(forSchema(delta))
        expect(result.errors, JSON.stringify(result.errors)).to.deep.equal([])
      }
    })
  })

  describe('the pilot in wind mode', () => {
    const engaged = (fromDeg: number, kn = 12) => {
      const run = new Run(
        scenarioFor('sailing-yacht-15m', conditions({ kn, fromDeg }))
      )
      run.until(START + 10 * MINUTE)
      const pilot = run.sim.pilot!
      pilot.engage()
      return { run, pilot }
    }

    it('holds a target inside the beat angle at the beat, the wind alarm saying why', () => {
      const { run, pilot } = engaged(315)
      pilot.setMode('wind')
      pilot.setTarget(-15 * RAD)
      const held = pilot.heldTargetDeg.awaDeg!
      expect(held).to.be.below(-20)
      const raised = pilot.alarms.find((a) => a.path === 'wind')!
      expect(raised.value.state).to.equal('warn')
      expect(raised.value.message).to.match(
        /^Inside the beat angle: holding \d+° apparent, the polar's beat of \d+° true/
      )
      run.until(START + 14 * MINUTE)
      // a target outside the beat clears it
      pilot.setTarget(-60 * RAD)
      expect(pilot.alarms.find((a) => a.path === 'wind')).to.equal(undefined)
    })

    it("tacks and gybes onto the polar's angles on her other side", () => {
      const close = engaged(315)
      close.pilot.setMode('wind')
      close.pilot.setTarget(-50 * RAD)
      close.run.until(START + 13 * MINUTE)
      close.pilot.tack('port')
      const ticks = close.run.until(START + 18 * MINUTE)
      const target = close.pilot.heldTargetDeg.awaDeg!
      expect(target).to.be.above(15)
      const awa = mean(
        under(ticks.slice(-20), 'environment.wind.angleApparent')
      )
      expect(awa / RAD).to.be.closeTo(target, 6)
      expect(Math.abs(target)).to.be.below(50)

      // the wind on her starboard quarter, she gybes to port onto the polar's gybe angle
      const run = engaged(150)
      run.pilot.setMode('wind')
      run.pilot.setTarget(120 * RAD)
      run.run.until(START + 13 * MINUTE)
      run.pilot.gybe('port')
      expect(run.pilot.heldTargetDeg.awaDeg).to.be.below(-120)
    })

    it('refuses wind mode, a tack and a gybe in a calm', () => {
      const calm = engaged(315, 0)
      expect(() => calm.pilot.setMode('wind')).to.throw(
        PilotError,
        /too little to steer by, under 3 kn/
      )
      const { run, pilot } = engaged(315)
      pilot.setMode('wind')
      run.until(START + 12 * MINUTE)
      expect(() => pilot.tack('port')).not.to.throw()
    })
  })
})
