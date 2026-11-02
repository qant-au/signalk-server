import { expect } from 'chai'
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync
} from 'fs'
import { rm } from 'fs/promises'
import { mock } from 'node:test'
import os from 'os'
import path from 'path'
import { Scenario } from '../simulator/engine/scenario'
import { Simulation } from '../simulator/engine/simulation'
import simulatorPlugin from '../simulator/plugin/index'
import {
  Route,
  Waypoint,
  positionAt,
  routeLegs,
  turnRateDegS
} from '../simulator/routes/route'
import { Delta } from '../simulator/soak/deltas'
import { SystemsModel, SystemsState } from '../simulator/systems/model'
import { VARIATION_FILE, loadVariation } from '../simulator/systems/magnetic'
import {
  VesselProfile,
  listProfiles,
  loadProfile
} from '../simulator/vessels/profile'

const SIMULATOR = path.join(__dirname, '..', 'simulator')
const VESSELS = path.join(SIMULATOR, 'vessels')
const SARONIC = path.join(SIMULATOR, 'samples', 'saronic-gulf-2018-07-13')
const START = Date.parse('2018-07-13T07:00:00Z')
const MINUTE = 60000
const RAD = Math.PI / 180
const KNOT_MS = 1852 / 3600

const profiles = listProfiles(VESSELS).map((id) => loadProfile(id, VESSELS))
const variation = loadVariation(SARONIC)!

/** a point `nm` from another along a bearing, in the local plane the route is drawn in */
function offset(from: Waypoint, bearingDeg: number, nm: number): Waypoint {
  return {
    lat: from.lat + (nm * Math.cos(bearingDeg * RAD)) / 60,
    lon:
      from.lon +
      (nm * Math.sin(bearingDeg * RAD)) / (60 * Math.cos(from.lat * RAD))
  }
}

/**
 * Out of a berth in the Saronic Gulf, a starboard turn, a stop at anchor, a long turn
 * back, a port turn and in to a berth again: every navigational state and every kind of
 * turn on one route.
 */
function tour(profile: VesselProfile): Route {
  const slow = Math.max(2, 0.3 * profile.maxSpeedKn)
  const cruise = 0.7 * profile.maxSpeedKn
  const legs: [number, number, number, Partial<Waypoint>?][] = [
    // bearing, nm, speed, what the waypoint the leg leaves does
    [90, 1, slow],
    [180, 3, cruise],
    [120, 2, cruise],
    [300, 3, cruise, { anchor: true, holdS: 20 * 60 }],
    [0, 3, cruise],
    [270, 1, cruise]
  ]
  const waypoints: Waypoint[] = []
  let at: Waypoint = { lat: 37.75, lon: 23.5 }
  legs.forEach(([bearing, nm, speedKn, extra], i) => {
    waypoints.push({ ...at, ...extra, name: `w${i}`, speedKn })
    at = offset(at, bearing, nm)
  })
  waypoints.push({ ...at, name: 'berth' })
  return {
    name: 'tour',
    departure: new Date(START + 10 * MINUTE).toISOString(),
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
}

function scenarioFor(profile: VesselProfile): Scenario {
  const route = tour(profile)
  return {
    sampleId: 'test',
    route,
    plannedRoute: route,
    legs: routeLegs(route),
    adjustments: [],
    profile,
    variation,
    notes: []
  }
}

interface Sent {
  ms: number
  values: Map<string, unknown>
}

/** everything the boat sends each tick, keyed `src:path` for sources with an id */
function collect(deltas: Delta[]): Map<string, unknown> {
  const values = new Map<string, unknown>()
  for (const d of deltas) {
    for (const u of d.updates) {
      for (const v of u.values) {
        values.set(u.source.src ? `${u.source.src}:${v.path}` : v.path, v.value)
      }
    }
  }
  return values
}

function sail(profile: VesselProfile, seed = 3): Sent[] {
  const scenario = scenarioFor(profile)
  const legs = scenario.legs
  const endMs = legs[legs.length - 1].arriveMs + 10 * MINUTE
  let pending: Delta[] = []
  const sim = new Simulation(
    scenario,
    { timeMultiplier: 10, showTraffic: false, scenarioStartMs: START, seed },
    (d) => pending.push(d),
    0
  )
  pending = []
  const sent: Sent[] = []
  for (let wall = 1000; START + wall * 10 <= endMs; wall += 1000) {
    sim.tick(wall)
    const values = collect(pending)
    sent.push({
      ms: Date.parse(values.get('navigation.datetime') as string),
      values
    })
    pending = []
  }
  return sent
}

const n = (s: Sent, p: string) => s.values.get(p) as number
const wrapDeg = (d: number) => ((((d + 180) % 360) + 360) % 360) - 180

describe('Simulator route turns', () => {
  for (const profile of profiles) {
    it(`swings ${profile.id} through each waypoint it passes`, () => {
      const route = tour(profile)
      const legs = routeLegs(route)
      const turns = legs.filter((l) => l.turn).map((l) => l.turn!)
      // the anchor stop is the one waypoint passed by stopping, not by turning
      expect(turns).to.have.length(4)
      const metres = (a: { lat: number; lon: number }, b: typeof a) =>
        Math.hypot(
          (a.lat - b.lat) * 111320,
          (a.lon - b.lon) * 111320 * Math.cos(a.lat * RAD)
        )
      for (const turn of turns) {
        for (const edge of [turn.startMs, turn.endMs]) {
          expect(
            metres(positionAt(legs, edge - 1), positionAt(legs, edge + 1))
          ).to.be.below(0.5)
        }
        const durationS = (turn.endMs - turn.startMs) / 1000
        const rate = Math.abs(turn.deltaDeg) / durationS
        const i = legs.findIndex((l) => l.turn === turn)
        const slower = Math.min(legs[i].speedKn, legs[i + 1].speedKn)
        expect(rate).to.be.at.least(
          turnRateDegS(profile.lengthM, slower) * (1 - 1e-6)
        )
        expect(rate).to.be.at.most(5 * (1 + 1e-6))
        // the motion along the arc is the course and speed the position reports
        for (let t = turn.startMs + 500; t < turn.endMs - 500; t += 500) {
          const a = positionAt(legs, t)
          const b = positionAt(legs, t + 100)
          const east = (b.lon - a.lon) * 111320 * Math.cos(a.lat * RAD)
          const north = (b.lat - a.lat) * 111320
          const moved = Math.atan2(east, north) / RAD
          expect(Math.abs(wrapDeg(moved - a.cogDeg))).to.be.below(1)
          expect(Math.hypot(east, north) / 0.1).to.be.closeTo(
            a.sogKn * KNOT_MS,
            0.02 * a.sogKn * KNOT_MS
          )
          expect(a.rateOfTurnDegS).to.be.closeTo(
            turn.deltaDeg / durationS,
            1e-6
          )
        }
      }
      // the legs keep their timings: the arcs straddle the waypoints evenly
      const straight = routeLegs({
        ...route,
        vessel: { ...route.vessel, lengthM: 0 }
      })
      expect(legs.map((l) => l.arriveMs)).to.deep.equal(
        straight.map((l) => l.arriveMs)
      )
    })
  }
})

describe('Simulator navigation', () => {
  const runs = new Map<string, Sent[]>()
  before(() => {
    for (const p of profiles) runs.set(p.id, sail(p))
  })
  const each = (fn: (p: VesselProfile, sent: Sent[]) => void) => () => {
    for (const p of profiles) fn(p, runs.get(p.id)!)
  }

  it(
    'keeps the navigation state in step with the engines',
    each((p, sent) => {
      const seen = new Set<string>()
      for (const s of sent) {
        const state = s.values.get('navigation.state') as string
        seen.add(state)
        const units = [...p.engines.map((e) => e.id)]
        const started = units.filter(
          (id) => s.values.get(`propulsion.${id}.state`) === 'started'
        )
        const inGear = units.filter(
          (id) =>
            s.values.get(`propulsion.${id}.transmission.gear`) === 'Forward'
        )
        const at = `${p.id} ${new Date(s.ms).toISOString()} ${state}`
        if (state === 'moored' || state === 'anchored' || state === 'sailing') {
          expect(started, at).to.deep.equal([])
          expect(inGear, at).to.deep.equal([])
          for (const id of units) {
            expect(n(s, `propulsion.${id}.engineLoad`), at).to.equal(0)
          }
        } else {
          expect(state, at).to.equal('motoring')
          expect(inGear.length, at).to.be.above(0)
        }
      }
      expect([...seen].sort(), p.id).to.include.members([
        'anchored',
        'moored',
        'motoring'
      ])
      if (p.rig === 'sail') expect([...seen], p.id).to.include('sailing')
    })
  )

  it(
    'heads into the current and reads the water speed against the ground speed',
    each((p, sent) => {
      for (const s of sent) {
        const sog = n(s, 'navigation.speedOverGround') / KNOT_MS
        const stw = n(s, 'navigation.speedThroughWater') / KNOT_MS
        const at = `${p.id} ${new Date(s.ms).toISOString()}`
        expect(Math.abs(stw - sog), at).to.be.at.most(1.0001)
        if (s.values.get('navigation.state') === 'moored') {
          expect(stw, at).to.equal(0)
        } else if (sog > 2) {
          const heading = n(s, 'navigation.headingTrue') / RAD
          const cog = n(s, 'navigation.courseOverGroundTrue') / RAD
          const crab = Math.asin(Math.min(1, 1 / sog)) / RAD
          expect(Math.abs(wrapDeg(heading - cog)), at).to.be.below(crab + 8)
        }
        const pos = s.values.get('navigation.position') as {
          latitude: number
          longitude: number
        }
        const v = n(s, 'navigation.magneticVariation')
        expect(v, at).to.be.closeTo(
          variation.at(pos.latitude, pos.longitude) * RAD,
          1e-4
        )
        const magnetic =
          n(s, 'navigation.headingTrue') -
          v -
          n(s, 'navigation.headingMagnetic')
        expect(Math.abs(Math.sin(magnetic / 2)), at).to.be.below(2e-4)
      }
    })
  )

  it(
    'turns through a waypoint on the rudder, heading and course together',
    each((p, sent) => {
      const legs = scenarioFor(p).legs
      const turns = legs.filter((l) => l.turn).map((l) => l.turn!)
      for (const turn of turns) {
        const inside = sent.filter(
          (s) => s.ms > turn.startMs + 2000 && s.ms < turn.endMs - 2000
        )
        const side = Math.sign(turn.deltaDeg)
        const rot = inside.map((s) => n(s, 'navigation.rateOfTurn'))
        const rudder = inside.map((s) => n(s, 'steering.rudderAngle'))
        const withTurn = rot.filter((r) => Math.sign(r) === side).length
        const label = `${p.id} turn of ${turn.deltaDeg.toFixed(0)}`
        if (inside.length) {
          expect(withTurn / inside.length, label).to.be.at.least(0.8)
          expect(
            rudder.filter((r) => Math.sign(r) === side).length / inside.length,
            label
          ).to.be.at.least(0.8)
        }
        const before = sent.filter((s) => s.ms <= turn.startMs).pop()!
        const after = sent.find((s) => s.ms >= turn.endMs + 4000)!
        const swung = wrapDeg(
          (n(after, 'navigation.headingTrue') -
            n(before, 'navigation.headingTrue')) /
            RAD
        )
        expect(swung, label).to.be.closeTo(turn.deltaDeg, 12)
      }
      for (const s of sent) {
        expect(Math.abs(n(s, 'steering.rudderAngle'))).to.be.at.most(35 * RAD)
      }
    })
  )

  it(
    'counts the logs through the water and resets the trip on leaving the berth',
    each((p, sent) => {
      const departure = scenarioFor(p).legs[0].departMs
      let integrated = 0
      for (let i = 1; i < sent.length; i++) {
        const a = sent[i - 1]
        const b = sent[i]
        expect(n(b, 'navigation.log')).to.be.at.least(n(a, 'navigation.log'))
        integrated +=
          ((n(a, 'navigation.speedThroughWater') +
            n(b, 'navigation.speedThroughWater')) /
            2) *
          ((b.ms - a.ms) / 1000)
      }
      const last = sent[sent.length - 1]
      expect(
        n(last, 'navigation.log') - n(sent[0], 'navigation.log'),
        p.id
      ).to.be.closeTo(integrated, 0.02 * integrated + 5)
      const reset = Date.parse(
        last.values.get('navigation.trip.lastReset') as string
      )
      expect(reset - departure, p.id).to.be.within(0, 2000)
      expect(n(last, 'navigation.trip.log'), p.id).to.be.closeTo(
        n(last, 'navigation.log') -
          // alongside the log stands still, so its last reading there is the one at the reset
          n(sent.filter((s) => s.ms < reset).pop()!, 'navigation.log'),
        3
      )
    })
  )

  it(
    'reports a GNSS fix whose satellites and dilution drift slowly',
    each((p, sent) => {
      const sats = sent.map((s) => n(s, 'navigation.gnss.satellites'))
      const hdop = sent.map((s) => n(s, 'navigation.gnss.horizontalDilution'))
      expect(sent[0].values.get('navigation.gnss.type')).to.equal(
        'Combined GPS/GLONASS'
      )
      for (let i = 0; i < sats.length; i++) {
        expect(Number.isInteger(sats[i])).to.equal(true)
        expect(sats[i]).to.be.within(5, 16)
        expect(hdop[i]).to.be.within(0.5, 3)
        if (i) expect(Math.abs(sats[i] - sats[i - 1])).to.be.at.most(1)
      }
      expect(new Set(sats).size, p.id).to.be.above(1)
      expect(new Set(hdop).size, p.id).to.be.above(1)
    })
  )

  it('rolls and pitches more on a smaller boat, and heels under sail', () => {
    const spread = (id: string, key: 'roll' | 'pitch') => {
      const xs = runs
        .get(id)!
        .filter((s) => s.values.get('navigation.state') === 'motoring')
        .map(
          (s) =>
            (s.values.get('navigation.attitude') as Record<string, number>)[key]
        )
      const mean = xs.reduce((a, b) => a + b, 0) / xs.length
      return Math.sqrt(xs.reduce((a, b) => a + (b - mean) ** 2, 0) / xs.length)
    }
    expect(spread('boat-4m', 'roll')).to.be.above(
      spread('motor-yacht-45m', 'roll')
    )
    expect(spread('boat-4m', 'pitch')).to.be.above(
      spread('motor-yacht-45m', 'pitch')
    )
    const meanRoll = (state: string) => {
      const rolls = runs
        .get('sailing-yacht-15m')!
        .filter((s) => s.values.get('navigation.state') === state)
        .map((s) =>
          Math.abs(
            (s.values.get('navigation.attitude') as { roll: number }).roll
          )
        )
      return rolls.reduce((a, b) => a + b, 0) / rolls.length
    }
    expect(meanRoll('sailing')).to.be.above(2 * meanRoll('motoring'))
  })
})

describe('Simulator time multiplier', () => {
  const profile = profiles.find((p) => p.id === 'sailing-yacht-15m')!
  const tmp = mkdtempSync(path.join(os.tmpdir(), 'simulator-multiplier-'))
  const samples = path.join(tmp, 'samples')
  /** a stretch every multiplier ends on a save at: 6000 s is 6000, 250 and 20 ticks */
  const STRETCH_S = 6000

  before(() => {
    mkdirSync(path.join(samples, 'tour'), { recursive: true })
    mkdirSync(path.join(tmp, 'vessels'))
    copyFileSync(
      path.join(VESSELS, `${profile.id}.json`),
      path.join(tmp, 'vessels', `${profile.id}.json`)
    )
    copyFileSync(
      path.join(SARONIC, VARIATION_FILE),
      path.join(samples, 'tour', VARIATION_FILE)
    )
    writeFileSync(
      path.join(samples, 'tour', 'sample.json'),
      JSON.stringify({ id: 'tour' })
    )
    writeFileSync(
      path.join(samples, 'tour', 'route.json'),
      JSON.stringify(tour(profile))
    )
    process.env.SIGNALK_SIMULATOR_SAMPLES = samples
  })

  after(async () => {
    mock.timers.reset()
    delete process.env.SIGNALK_SIMULATOR_SAMPLES
    await rm(tmp, { recursive: true, force: true })
  })

  interface PluginRun {
    /** what was sent, by the scenario time it carries */
    byTime: Map<number, Map<string, unknown>>
    deltas: number
    saved: SystemsState
  }

  /** the plugin itself, on mocked timers, from the start of the route for the stretch */
  async function runPlugin(timeMultiplier: number): Promise<PluginRun> {
    const dataDir = path.join(tmp, `data-${timeMultiplier}`)
    mkdirSync(dataDir)
    const byTime = new Map<number, Map<string, unknown>>()
    let deltas = 0
    let tick: Delta[] = []
    const errors: string[] = []
    const plugin = simulatorPlugin({
      handleMessage: (_id: string, delta: Partial<Delta>) => {
        deltas++
        tick.push(delta as Delta)
      },
      setPluginStatus: () => undefined,
      setPluginError: (message: string) => errors.push(message),
      getDataDirPath: () => dataDir,
      error: (message: string) => errors.push(message),
      debug: () => undefined,
      resourcesApi: { setResource: async () => undefined }
    })
    mock.timers.enable({
      apis: ['setInterval', 'Date'],
      now: 1_700_000_000_000
    })
    try {
      plugin.start({
        sample: 'tour',
        seed: 5,
        timeMultiplier,
        startAtMinutes: 0
      })
      // the scenario loads from disk on real I/O; the run starts when the boat is named
      while (deltas === 0 && !errors.length) {
        await new Promise((resolve) => setImmediate(resolve))
      }
      expect(errors).to.deep.equal([])
      const ticks = STRETCH_S / timeMultiplier
      tick = []
      deltas = 0
      for (let i = 0; i < ticks; i++) {
        mock.timers.tick(1000)
        const values = collect(tick)
        const ms = Date.parse(values.get('navigation.datetime') as string)
        const earlier = byTime.get(ms)
        if (earlier) {
          // a slower clock can send one step twice; it must say the same both times
          for (const [k, v] of values) {
            if (earlier.has(k)) expect(v, k).to.deep.equal(earlier.get(k))
            earlier.set(k, v)
          }
        } else {
          byTime.set(ms, values)
        }
        tick = []
      }
    } finally {
      plugin.stop()
      mock.timers.reset()
    }
    const state = JSON.parse(
      readFileSync(path.join(dataDir, 'state.json'), 'utf8')
    )
    // the plugin starts a fresh run at the departure
    expect(state.scenarioMs - Date.parse(tour(profile).departure)).to.equal(
      STRETCH_S * 1000
    )
    return { byTime, deltas, saved: state.systems }
  }

  it('tells the same story at 1x, 24x and 300x', async () => {
    const runs = new Map<number, PluginRun>()
    for (const m of [1, 24, 300]) runs.set(m, await runPlugin(m))
    const reference = runs.get(1)!

    const fuelL = (s: SystemsState) =>
      s.tanks
        .filter((t) => t.id.startsWith('fuel.'))
        .reduce((sum, t) => sum + (t.values.litres as number), 0)
    // the run starts fresh at the departure, as a new model for the same seed does
    const departure = Date.parse(tour(profile).departure)
    const fresh = new SystemsModel(profile, { seed: 5, startMs: departure })
    const startFuelL = fuelL(fresh.save())
    const story = (s: SystemsState) => ({
      fuelBurnedL: startFuelL - fuelL(s),
      freshUsedL: s.values.freshUsedL,
      engineRunS: s.engines.map((e) => e.values.runS),
      logM: s.navigation.logM
    })
    const evidence = [...runs.entries()].map(([m, run]) => ({
      multiplier: `${m}x`,
      ticks: STRETCH_S / m,
      deltas: run.deltas,
      'scenario times sent': run.byTime.size,
      'fuel burned (l)': story(run.saved).fuelBurnedL,
      'fresh water used (l)': story(run.saved).freshUsedL,
      'engine run time (s)': story(run.saved).engineRunS.join(', ')
    }))
    console.table(evidence)
    for (const m of [24, 300]) {
      const run = runs.get(m)!
      expect(story(run.saved), `${m}x`).to.deep.equal(story(reference.saved))
      expect(run.saved, `${m}x`).to.deep.equal(reference.saved)

      let compared = 0
      for (const [ms, values] of run.byTime) {
        const at = reference.byTime.get(ms)
        expect(at, `${m}x sent ${new Date(ms).toISOString()}`).to.not.equal(
          undefined
        )
        for (const [k, v] of values) {
          if (!at!.has(k)) continue
          expect(
            v,
            `${m}x ${k} at ${new Date(ms).toISOString()}`
          ).to.deep.equal(at!.get(k))
          compared++
        }
      }
      expect(compared).to.be.above(run.byTime.size * 40)
      expect(run.deltas).to.be.below(reference.deltas)
    }
    // every step the model takes is sent at 1x, and fewer of them faster
    expect(reference.byTime.size).to.equal(STRETCH_S / 2 + 1)
    expect(runs.get(24)!.byTime.size).to.equal(STRETCH_S / 24)
    expect(runs.get(300)!.byTime.size).to.equal(STRETCH_S / 300)
  })
})
