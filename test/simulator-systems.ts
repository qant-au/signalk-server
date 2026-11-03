import { expect } from 'chai'
import path from 'path'
import { Simulation } from '../simulator/engine/simulation'
import { Scenario } from '../simulator/engine/scenario'
import { Route, routeLegs } from '../simulator/routes/route'
import { Delta, forSchema } from '../simulator/soak/deltas'
import { Motion, STEP_S, SystemsModel } from '../simulator/systems/model'
import { Drift, Rng } from '../simulator/systems/random'
import {
  MAX_TANKS,
  ProfileFile,
  TankType,
  VesselProfile,
  listProfiles,
  loadProfile,
  resolveProfile
} from '../simulator/vessels/profile'

// The server pins signalk-schema 1.0; free names under environment.inside need 1.1 or
// later, so the deltas are validated against the newer copy the streams package uses.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const schema = require(
  require.resolve('@signalk/signalk-schema', {
    paths: [path.join(__dirname, '..', 'packages', 'streams')]
  })
)

const VESSELS = path.join(__dirname, '..', 'simulator', 'vessels')
const START = Date.parse('2024-07-13T09:00:00Z')
const MINUTE = 60000
const MMSI_CONTEXT = 'vessels.urn:mrn:imo:mmsi:230099999'

interface Validation {
  valid: boolean
  errors?: { message: string; dataPath?: string }[]
}

function check(delta: Delta): string[] {
  const d = { ...forSchema(delta), context: MMSI_CONTEXT }
  const problems: string[] = []
  const envelope: Validation = schema.validateDelta(d)
  if (!envelope.valid)
    problems.push('delta: ' + JSON.stringify(envelope.errors))
  const full: Validation = schema.validateFull(schema.deltaToFull(d))
  if (!full.valid) {
    problems.push(
      'full: ' +
        (full.errors ?? [])
          .map((e) => `${e.dataPath} ${e.message}`)
          .filter((m) => !/url|uuid|aircraft|aton|sar/i.test(m))
          .join('; ')
    )
  }
  return problems
}

/** a day out: at the berth, out through the harbour, a passage, back in, at the berth */
function dayOut(profile: VesselProfile): (ms: number) => Motion {
  return (ms) => {
    const minutes = (ms - START) / MINUTE
    const base = { lat: 37.9, lon: 23.6, cogDeg: 200 }
    if (minutes < 10 || minutes >= 230)
      return { ...base, sogKn: 0, atBerth: true }
    if (minutes < 40 || minutes >= 200) {
      return { ...base, sogKn: 0.25 * profile.maxSpeedKn, atBerth: false }
    }
    return { ...base, sogKn: 0.75 * profile.maxSpeedKn, atBerth: false }
  }
}

function paths(deltas: Delta[]): Set<string> {
  return new Set(
    deltas.flatMap((d) => d.updates.flatMap((u) => u.values.map((v) => v.path)))
  )
}

function value(deltas: Delta[], p: string): unknown {
  for (const d of deltas) {
    for (const u of d.updates) {
      const found = u.values.find((v) => v.path === p)
      if (found) return found.value
    }
  }
  return undefined
}

function idsUnder(all: Set<string>, prefix: string): Set<string> {
  const ids = new Set<string>()
  for (const p of all) {
    if (p.startsWith(prefix)) ids.add(p.slice(prefix.length).split('.')[0])
  }
  return ids
}

function model(profile: VesselProfile, seed = 1, depth = 25): SystemsModel {
  return new SystemsModel(profile, {
    seed,
    startMs: START,
    depthAt: () => depth
  })
}

const profiles = listProfiles(VESSELS).map((id) => loadProfile(id, VESSELS))

describe('Simulator vessel profiles', () => {
  it('has the ten profiles', () => {
    expect(profiles.map((p) => p.id)).to.deep.equal([
      'boat-4m',
      'electric-launch-7m',
      'hybrid-catamaran-60ft',
      'motor-sailer-15m',
      'motor-yacht-20m',
      'motor-yacht-34m',
      'motor-yacht-45m',
      'sailing-yacht-15m',
      'sailing-yacht-9m',
      'yacht-12m'
    ])
  })

  it('fills in counts by length', () => {
    const at = (lengthM: number) =>
      resolveProfile({ id: 'x', name: 'x', lengthM })
    expect(at(8).engines).to.have.length(1)
    expect(at(8).generators).to.have.length(0)
    expect(at(12).engines).to.have.length(2)
    expect(at(12).generators).to.have.length(1)
    const big = at(40)
    expect(big.tanks.fuel).to.have.length(4)
    expect(big.tanks.freshWater).to.have.length(2)
    expect(big.tanks.wasteWater).to.have.length(2)
    expect(big.tanks.blackWater).to.have.length(2)
    expect(at(4).tanks.freshWater).to.have.length(0)
    for (const L of [4, 9, 15, 30, 45]) {
      const p = at(L)
      for (const type of Object.keys(MAX_TANKS) as TankType[]) {
        expect(p.tanks[type].length).to.be.at.most(MAX_TANKS[type])
      }
    }
  })

  it('refuses more tanks than a profile may have', () => {
    const tanks = Array.from({ length: 5 }, (_, i) => ({
      id: `w${i}`,
      displayName: `Water ${i}`,
      capacityL: 100
    }))
    const file: ProfileFile = {
      id: 'x',
      name: 'x',
      lengthM: 20,
      tanks: { freshWater: tanks }
    }
    expect(() => resolveProfile(file)).to.throw(/freshWater/)
  })

  it('keeps main engines and generators apart', () => {
    const file: ProfileFile = {
      id: 'x',
      name: 'x',
      lengthM: 20,
      engines: [
        {
          id: 'generator1',
          displayName: 'Engine',
          type: 'diesel',
          powerKw: 100,
          maxRpm: 3000,
          idleRpm: 700
        }
      ]
    }
    expect(() => resolveProfile(file)).to.throw(/generator/)
  })

  it('models the hybrid catamaran on the Xquisite Sixty Solar Power', () => {
    const cat = profiles.find((p) => p.id === 'hybrid-catamaran-60ft')!
    expect(cat.lengthM).to.equal(18.5)
    expect(cat.beamM).to.equal(8.1)
    expect(cat.draftM).to.equal(1.2)
    expect(cat.engines.map((e) => [e.type, e.electricKw])).to.deep.equal([
      ['hybrid', 130],
      ['hybrid', 130]
    ])
    expect(cat.generators.map((g) => g.powerKw)).to.deep.equal([180])
    expect(cat.solar.reduce((s, a) => s + a.peakW, 0)).to.equal(8000)
    expect(cat.tanks.fuel.reduce((s, t) => s + t.capacityL, 0)).to.equal(3400)
    expect(cat.tanks.freshWater.reduce((s, t) => s + t.capacityL, 0)).to.equal(
      1000
    )
  })
})

describe('Simulator systems model', () => {
  for (const profile of profiles) {
    describe(profile.id, () => {
      const m = model(profile)
      const motion = dayOut(profile)
      const samples: Record<string, Delta[]> = {}
      const meta = m.metaDelta(START)
      for (const [name, minute] of [
        ['berth', 5],
        ['harbour', 30],
        ['passage', 120],
        ['home', 235]
      ] as const) {
        m.advance(START + minute * MINUTE, motion)
        samples[name] = m.deltas(START + minute * MINUTE, true)
      }

      it('sends only deltas that validate against the Signal K schema', () => {
        const problems = [meta, ...Object.values(samples).flat()].flatMap(check)
        expect(problems).to.deep.equal([])
      })

      it('follows the profile in its counts', () => {
        const all = paths(samples.passage)
        const propulsion = idsUnder(all, 'propulsion.')
        const generators = [...propulsion].filter((id) =>
          profile.generators.some((g) => g.id === id)
        )
        const mains = [...propulsion].filter((id) =>
          profile.engines.some((e) => e.id === id)
        )
        expect(mains.sort()).to.deep.equal(
          profile.engines.map((e) => e.id).sort()
        )
        expect(generators.sort()).to.deep.equal(
          profile.generators.map((g) => g.id).sort()
        )
        const thrusters = [...propulsion].filter((id) =>
          profile.thrusters.some((t) => t.id === id)
        )
        expect(thrusters.sort()).to.deep.equal(
          profile.thrusters.map((t) => t.id).sort()
        )
        expect(propulsion.size).to.equal(
          mains.length + generators.length + thrusters.length
        )
        for (const type of Object.keys(MAX_TANKS) as TankType[]) {
          expect(idsUnder(all, `tanks.${type}.`).size, type).to.equal(
            profile.tanks[type].length
          )
        }
        expect(idsUnder(all, 'electrical.batteries.').size).to.equal(
          profile.banks.length
        )
        expect(idsUnder(all, 'electrical.solar.').size).to.equal(
          profile.solar.length
        )
        expect(idsUnder(all, 'environment.inside.').size).to.equal(
          profile.zones.length
        )
        const sounderSources = samples.passage
          .flatMap((d) => d.updates)
          .filter((u) =>
            u.values.some((v) => v.path === 'environment.depth.belowSurface')
          )
          .map((u) => u.source.src)
        expect(sounderSources).to.deep.equal(profile.sounders.map((s) => s.id))
        expect([...all].some((p) => /radar/i.test(p))).to.equal(false)
        expect(all.has('environment.wind.speedApparent')).to.equal(profile.wind)
      })

      it('names every engine, generator, tank, bank and sounder', () => {
        const named = new Map(
          meta.updates[0].meta!.map((m) => [m.path, m.value.displayName])
        )
        for (const e of [...profile.engines, ...profile.generators]) {
          expect(named.get(`propulsion.${e.id}`)).to.equal(e.displayName)
        }
        for (const b of profile.banks) {
          expect(named.get(`electrical.batteries.${b.id}`)).to.equal(
            b.displayName
          )
        }
        for (const type of Object.keys(MAX_TANKS) as TankType[]) {
          for (const t of profile.tanks[type]) {
            expect(named.get(`tanks.${type}.${t.id}`)).to.equal(t.displayName)
          }
        }
        for (const s of profile.sounders) {
          expect(named.get(`sensors.${s.id}`)).to.equal(s.displayName)
        }
        const names = [...named.values()]
        expect(new Set(names).size, 'display names are distinct').to.equal(
          names.length
        )
      })

      it('has the engines off at the berth and on for the passage', () => {
        for (const e of profile.engines) {
          expect(value(samples.berth, `propulsion.${e.id}.state`)).to.equal(
            'stopped'
          )
          expect(
            value(samples.berth, `propulsion.${e.id}.revolutions`)
          ).to.equal(0)
        }
        for (const g of profile.generators) {
          expect(value(samples.berth, `propulsion.${g.id}.state`)).to.equal(
            'stopped'
          )
        }
        if (profile.rig === 'motor') {
          for (const e of profile.engines) {
            expect(
              value(samples.passage, `propulsion.${e.id}.revolutions`)
            ).to.be.above(0)
          }
        }
      })
    })
  }

  it('burns fuel from the named tank and tops up the day tanks', () => {
    const yacht = profiles.find((p) => p.id === 'motor-yacht-45m')!
    const m = model(yacht)
    const before = m.summary().fuelL
    const motion = dayOut(yacht)
    m.advance(START + 150 * MINUTE, motion)
    const after = m.deltas(START, true)
    expect(m.summary().fuelL).to.be.below(before)
    expect(m.summary().generatorsRunning).to.be.at.least(1)
    const rate = value(after, 'propulsion.port.fuel.rate') as number
    // 0.75 of top speed on 1500 kW is about 630 kW: some 160 l/h
    expect(rate * 1000 * 3600).to.be.within(100, 250)
    for (const day of ['dayTankPort', 'dayTankStarboard']) {
      expect(
        value(after, `tanks.fuel.${day}.currentLevel`) as number
      ).to.be.above(0.45)
    }
  })

  it('runs the generator at its set speed with the AC load on it', () => {
    const yacht = profiles.find((p) => p.id === 'motor-yacht-45m')!
    const m = model(yacht)
    m.advance(START + 120 * MINUTE, dayOut(yacht))
    const d = m.deltas(START, true)
    expect(value(d, 'propulsion.generator1.state')).to.equal('started')
    expect(
      (value(d, 'propulsion.generator1.revolutions') as number) * 60
    ).to.be.within(1460, 1510)
    expect(
      value(d, 'electrical.ac.generator1.phase.A.frequency') as number
    ).to.be.within(49.4, 50.2)
    expect(value(d, 'propulsion.generator1.engineLoad') as number).to.be.above(
      0.2
    )
    expect(value(d, 'propulsion.generator1.fuel.rate') as number).to.be.above(0)
  })

  it('drives the hybrid electrically at harbour speed and on diesel at sea', () => {
    const cat = profiles.find((p) => p.id === 'hybrid-catamaran-60ft')!
    const m = model(cat)
    const motion = dayOut(cat)
    m.advance(START + 30 * MINUTE, motion)
    const harbour = m.deltas(START, true)
    expect(value(harbour, 'propulsion.port.state')).to.equal('stopped')
    expect(value(harbour, 'propulsion.port.revolutions')).to.equal(0)
    expect(
      value(harbour, 'electrical.batteries.propulsion.current') as number
    ).to.be.below(0)
    m.advance(START + 120 * MINUTE, motion)
    const sea = m.deltas(START, true)
    expect(value(sea, 'propulsion.port.state')).to.equal('started')
    expect(value(sea, 'propulsion.port.fuel.rate') as number).to.be.above(0)
  })

  it('takes the hybrid passage rules from the profile, with defaults for any left out', () => {
    const cat = profiles.find((p) => p.id === 'hybrid-catamaran-60ft')!
    expect(cat.hybrid).to.deep.equal({
      electricBelowKn: 7,
      dieselBelowSoc: 0.3,
      electricAboveSoc: 0.8,
      chargeWhileDiesel: true,
      generatorChargesAtAnchor: true
    })
    const plain = resolveProfile({
      id: 'x',
      name: 'x',
      lengthM: 18,
      maxSpeedKn: 16,
      engines: cat.engines,
      banks: cat.banks,
      hybrid: { dieselBelowSoc: 0.25 }
    })
    expect(plain.hybrid).to.deep.equal({
      // where the propeller takes a fifth of the motors' 260 kW of the drives' 522 kW
      electricBelowKn: 7.5,
      dieselBelowSoc: 0.25,
      electricAboveSoc: 0.6,
      chargeWhileDiesel: true,
      generatorChargesAtAnchor: true
    })
    expect(profiles.filter((p) => p.hybrid).map((p) => p.id)).to.deep.equal([
      'hybrid-catamaran-60ft'
    ])
  })

  /** the catamaran with a small propulsion bank, so its rules come into play within hours */
  function smallBankCat(rules: Partial<VesselProfile['hybrid']> = {}) {
    const cat = profiles.find((p) => p.id === 'hybrid-catamaran-60ft')!
    return {
      ...cat,
      hybrid: { ...cat.hybrid!, ...rules },
      banks: cat.banks.map((b) =>
        b.role === 'propulsion' ? { ...b, capacityAh: 20 } : b
      )
    }
  }
  const steady =
    (sogKn: number, anchored = false) =>
    (): Motion => ({
      lat: 37.9,
      lon: 23.6,
      cogDeg: 200,
      sogKn,
      atBerth: false,
      anchored
    })
  const soc = (m: SystemsModel) =>
    m.save().banks.find((b) => b.id === 'propulsion')!.values.soc as number

  it('takes the diesels in below the charge floor and goes electric again above the ceiling', () => {
    const cat = smallBankCat()
    const m = model(cat)
    const states: string[] = []
    let lowest = 1
    for (let s = 10; s <= 4 * 3600; s += 10) {
      m.advance(START + s * 1000, steady(5))
      const state = value(m.deltas(START, false), 'propulsion.port.state')
      const changed = states[states.length - 1] !== state
      if (changed) states.push(state as string)
      if (state === 'started') lowest = Math.min(lowest, soc(m))
      if (changed && state === 'stopped' && states.includes('started')) {
        // back on the motors only once the bank is over its ceiling, less ten seconds' draw
        expect(soc(m)).to.be.above(0.79)
      }
    }
    expect(states.slice(0, 3)).to.deep.equal(['stopped', 'started', 'stopped'])
    expect(lowest).to.be.below(0.3)
  })

  it('charges at anchor with the generator only when the bank needs it, and not where the profile says not', () => {
    const hours = (m: SystemsModel) => {
      let started: number | undefined
      for (let minute = 1; minute <= 12 * 60; minute++) {
        m.advance(START + minute * MINUTE, steady(0, true))
        if (m.summary().generatorsRunning && started === undefined)
          started = soc(m)
      }
      return started
    }
    const startedAt = hours(model(smallBankCat()))
    // read up to a minute after it started charging
    expect(startedAt).to.be.a('number').and.below(0.31)
    expect(
      hours(model(smallBankCat({ generatorChargesAtAnchor: false })))
    ).to.equal(undefined)
  })

  it('runs the electric launch from its bank', () => {
    const launch = profiles.find((p) => p.id === 'electric-launch-7m')!
    const m = model(launch)
    m.advance(START + 120 * MINUTE, dayOut(launch))
    const d = m.deltas(START, true)
    expect(value(d, 'propulsion.main.state')).to.equal('started')
    expect(value(d, 'propulsion.main.fuel.rate')).to.equal(undefined)
    expect(
      value(d, 'electrical.batteries.propulsion.current') as number
    ).to.be.below(0)
  })

  it('reads each sounder at its own place under the hull', () => {
    const cat = profiles.find((p) => p.id === 'hybrid-catamaran-60ft')!
    // deeper to starboard: the course is 200 degrees, so starboard is to the west
    const m = new SystemsModel(cat, {
      seed: 1,
      startMs: START,
      depthAt: (_lat, lon) => (lon < 23.6 ? 12 : 8)
    })
    m.advance(START + 60 * MINUTE, dayOut(cat))
    const updates = m.deltas(START, false).flatMap((d) => d.updates)
    const reading = (src: string) =>
      updates
        .find((u) => u.source.src === src)!
        .values.find((v) => v.path === 'environment.depth.belowSurface')!
        .value as number
    expect(reading('portSounder')).to.be.closeTo(8, 0.3)
    expect(reading('starboardSounder')).to.be.closeTo(12, 0.3)
  })

  it('gives the same run for the same seed and a different one for another', () => {
    const yacht = profiles.find((p) => p.id === 'motor-yacht-34m')!
    const run = (seed: number) => {
      const m = model(yacht, seed)
      const motion = dayOut(yacht)
      const out: string[] = []
      for (let minute = 0; minute <= 240; minute += 5) {
        m.advance(START + minute * MINUTE, motion)
        out.push(JSON.stringify(m.deltas(START + minute * MINUTE, true)))
      }
      return out
    }
    const first = run(7)
    expect(run(7)).to.deep.equal(first)
    const other = run(8)
    expect(other).to.not.deep.equal(first)
    expect(other.filter((d, i) => d === first[i]).length).to.be.below(
      first.length / 4
    )
  })

  it('does not depend on how often it is ticked', () => {
    const yacht = profiles.find((p) => p.id === 'motor-yacht-20m')!
    const motion = dayOut(yacht)
    const once = model(yacht)
    once.advance(START + 90 * MINUTE, motion)
    const often = model(yacht)
    for (let s = 0; s <= 90 * 60; s += 7)
      often.advance(START + s * 1000, motion)
    often.advance(START + 90 * MINUTE, motion)
    expect(JSON.stringify(often.deltas(0, true))).to.equal(
      JSON.stringify(once.deltas(0, true))
    )
    expect(once.scenarioMs).to.equal(START + 90 * MINUTE)
    expect(STEP_S).to.be.at.most(10)
  })

  it('drifts rather than jumps', () => {
    const drift = new Drift(new Rng(3, 'x'), 1, 600)
    let biggestStep = 0
    let previous = 0
    let sumSquares = 0
    const steps = 20000
    for (let i = 0; i < steps; i++) {
      const v = drift.step(2)
      biggestStep = Math.max(biggestStep, Math.abs(v - previous))
      previous = v
      sumSquares += v * v
    }
    expect(biggestStep).to.be.below(0.4)
    expect(Math.sqrt(sumSquares / steps)).to.be.within(0.7, 1.3)
  })
})

describe('Simulator systems in a run', () => {
  const profile = profiles.find((p) => p.id === 'motor-yacht-20m')!
  const route: Route = {
    name: 'test',
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
      { name: 'A', lat: 25.0, lon: -80.0, speedKn: 10 },
      { name: 'B', lat: 25.1, lon: -80.0 }
    ]
  }
  const scenario: Scenario = {
    sampleId: 'test',
    route,
    plannedRoute: route,
    legs: routeLegs(route),
    adjustments: [],
    profile,
    notes: []
  }

  const run = (seed: number) => {
    const emitted: Delta[] = []
    const sim = new Simulation(
      scenario,
      { timeMultiplier: 60, showTraffic: false, scenarioStartMs: START, seed },
      (d) => emitted.push(d),
      0
    )
    for (let wall = 0; wall <= 120000; wall += 1000) sim.tick(wall)
    return emitted.map((d) => JSON.stringify(d))
  }

  it('repeats under the controllable clock for one seed and not another', () => {
    const first = run(1)
    expect(run(1)).to.deep.equal(first)
    expect(run(2)).to.not.deep.equal(first)
    expect(
      first.some((d) => d.includes('propulsion.port.revolutions'))
    ).to.equal(true)
    expect(first.some((d) => d.includes('"displayName"'))).to.equal(true)
  })

  it('validates everything a run sends', () => {
    const problems = run(1)
      .map((d) => JSON.parse(d) as Delta)
      .flatMap(check)
    expect(problems).to.deep.equal([])
  })
})
