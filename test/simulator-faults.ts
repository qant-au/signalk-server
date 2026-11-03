import { expect } from 'chai'
import path from 'path'
import { FaultError } from '../simulator/faults/faults'
import { Scenario } from '../simulator/engine/scenario'
import { Simulation, SimulationOptions } from '../simulator/engine/simulation'
import { Route, routeLegs } from '../simulator/routes/route'
import { Delta } from '../simulator/soak/deltas'
import { loadProfile } from '../simulator/vessels/profile'
import { Motion, SystemFaults, SystemsModel } from '../simulator/systems/model'

// The server pins signalk-schema 1.0; free names under environment.inside need 1.1 or
// later, so the deltas are validated against the newer copy the streams package uses.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const schema = require(
  require.resolve('@signalk/signalk-schema', {
    paths: [path.join(__dirname, '..', 'packages', 'streams')]
  })
)

const VESSELS = path.join(__dirname, '..', 'simulator', 'vessels')
const START = Date.parse('2024-03-16T14:00:00Z')
const MINUTE = 60000
const KELVIN = 273.15

/** away from the berth for nine hours; `anchorHours` puts an anchorage half an hour out */
function scenarioFor(profileId: string, anchorHours = 0): Scenario {
  const profile = loadProfile(profileId, VESSELS)
  const route: Route = {
    name: 'test',
    departure: new Date(START + 10 * MINUTE).toISOString(),
    vessel: {
      description: profile.name,
      lengthM: profile.lengthM,
      draftM: profile.draftM,
      typeCode: profile.typeCode,
      profile: profile.id
    },
    source: 'test',
    waypoints: anchorHours
      ? [
          { name: 'A', lat: 25.0, lon: -80.0, speedKn: 10 },
          {
            name: 'Anchorage',
            lat: 25.08,
            lon: -80.0,
            speedKn: 10,
            anchor: true,
            holdS: anchorHours * 3600
          },
          { name: 'B', lat: 26.5, lon: -80.0 }
        ]
      : [
          { name: 'A', lat: 25.0, lon: -80.0, speedKn: 10 },
          { name: 'B', lat: 26.5, lon: -80.0 }
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
    notes: []
  }
}

/** a run on the controllable clock: one wall second a tick, `rate` scenario seconds each */
class Run {
  readonly sim: Simulation
  readonly sent: Delta[] = []
  wallMs = 0

  constructor(
    scenario: Scenario,
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
      (d) => this.sent.push(d),
      0
    )
  }

  get faults() {
    return this.sim.faults!
  }

  /** runs on for this many scenario minutes, giving what was sent in them */
  minutes(n: number): Delta[] {
    const from = this.sent.length
    const ticks = Math.round((n * 60) / this.rate)
    for (let i = 0; i < ticks; i++) {
      this.wallMs += 1000
      this.sim.tick(this.wallMs)
    }
    return this.sent.slice(from)
  }

  /** runs until the scenario reaches this many minutes after START */
  until(minutesAfterStart: number): Delta[] {
    const now = (this.sim.systems!.scenarioMs - START) / MINUTE
    return this.minutes(minutesAfterStart - now)
  }
}

function values(deltas: Delta[], p: string): unknown[] {
  return deltas.flatMap((d) =>
    d.updates.flatMap((u) =>
      u.values.filter((v) => v.path === p).map((v) => v.value)
    )
  )
}

const last = (deltas: Delta[], p: string) => values(deltas, p).at(-1)

interface Note {
  state: string
  method: string[]
  message: string
}

const notes = (deltas: Delta[], p: string) =>
  values(deltas, `notifications.${p}`) as Note[]

/** the specification has no bilge: its switches are named as a switch bank names them */
const BILGE = /^(notifications\.)?electrical\.switches\./

function schemaProblems(delta: Delta): string[] {
  const updates = delta.updates
    .map((u) => ({ ...u, values: u.values.filter((v) => !BILGE.test(v.path)) }))
    .filter((u) => u.values.length)
  if (!updates.length) return []
  const d = { ...delta, updates, context: 'vessels.urn:mrn:imo:mmsi:230099999' }
  const problems: string[] = []
  if (!schema.validateDelta(d).valid) problems.push('delta envelope')
  const full = schema.validateFull(schema.deltaToFull(d))
  if (!full.valid) {
    const errors = (full.errors ?? [])
      .map(
        (e: { dataPath: string; message: string }) =>
          `${e.dataPath} ${e.message}`
      )
      .filter((m: string) => !/url|uuid|aircraft|aton|sar\b/i.test(m))
    if (errors.length) problems.push(errors.join('; '))
  }
  return problems
}

describe('Simulator faults', () => {
  it('lists the faults this boat can have, with their targets', () => {
    const run = new Run(scenarioFor('motor-yacht-20m'))
    const kinds = Object.fromEntries(
      run.faults.available().map((k) => [k.kind, k.targets])
    )
    expect(kinds.engineOverheat).to.deep.equal(['port', 'starboard'])
    expect(kinds.generatorNoStart).to.deep.equal(['generator1'])
    expect(kinds.batteryCellFailure).to.include('house')
    expect(kinds.chargerFailure).to.not.include('start')
    expect(kinds.gnssLost).to.deep.equal(['gnss'])
    expect(kinds.windInstrumentFrozen).to.deep.equal(['wind'])
    expect(kinds.staleSensor).to.include('environment.outside.temperature')
    // the electric launch has no combustion engine to overheat and no generator
    const launch = new Run(scenarioFor('electric-launch-7m'))
    const launchKinds = launch.faults.available().map((k) => k.kind)
    expect(launchKinds).to.not.include('engineOverheat')
    expect(launchKinds).to.not.include('generatorNoStart')
  })

  it('refuses an unknown fault, a target the boat lacks, and one already on', () => {
    const run = new Run(scenarioFor('motor-yacht-20m'))
    expect(() => run.faults.raise('lightning')).to.throw(FaultError)
    expect(() => run.faults.raise('engineOverheat', 'centre')).to.throw(
      FaultError
    )
    run.faults.raise('engineOverheat', 'port')
    expect(() => run.faults.raise('engineOverheat', 'port')).to.throw(
      FaultError
    )
    expect(() => run.faults.clear('gnssLost', 'gnss')).to.throw(FaultError)
  })

  it('overheats an engine: coolant climbs past its alarm, oil pressure falls run on, and it clears', () => {
    const run = new Run(scenarioFor('motor-yacht-20m'))
    run.until(40)
    const normal = last(run.minutes(1), 'propulsion.port.coolantTemperature')
    expect((normal as number) - KELVIN).to.be.within(80, 90)
    run.faults.raise('engineOverheat', 'port')

    const first = run.minutes(3)
    const coolant = values(first, 'propulsion.port.coolantTemperature').map(
      (k) => (k as number) - KELVIN
    )
    expect(coolant.at(-1)).to.be.above(94)
    const warn = notes(first, 'propulsion.port.coolantTemperature')
    expect(warn[0]).to.include({ state: 'warn' })
    expect(warn[0].method).to.deep.equal(['visual'])

    const later = run.minutes(15)
    const alarm = notes(later, 'propulsion.port.coolantTemperature').at(-1)!
    expect(alarm.state).to.equal('alarm')
    expect(alarm.method).to.deep.equal(['visual', 'sound'])
    expect(alarm.message).to.match(/overheating/)
    const oil = values(later, 'propulsion.port.oilPressure') as number[]
    expect(oil.at(-1)!).to.be.below(oil[0])
    // raised once and held, however the pressure wanders about the threshold
    expect(
      notes(later, 'propulsion.port.oilPressure').map((n) => n.state)
    ).to.deep.equal(['alarm'])
    // the other engine is untouched
    expect(
      (last(later, 'propulsion.starboard.coolantTemperature') as number) -
        KELVIN
    ).to.be.below(90)

    run.faults.clear('engineOverheat', 'port')
    expect(run.faults.active()[0].phase).to.equal('clearing')
    const after = run.minutes(30)
    expect(
      notes(after, 'propulsion.port.coolantTemperature').at(-1)
    ).to.include({ state: 'normal' })
    expect(notes(after, 'propulsion.port.oilPressure').at(-1)).to.include({
      state: 'normal'
    })
    expect(run.faults.active()).to.deep.equal([])
  })

  it('clears an overheat on its own when the crew clears the intake', () => {
    const run = new Run(scenarioFor('motor-yacht-20m'), {}, 60)
    run.until(40)
    const fault = run.faults.raise('engineOverheat', 'port')
    expect(fault.clearsMs).to.be.a('number')
    run.minutes((fault.clearsMs! - fault.raisedMs) / MINUTE + 40)
    expect(run.faults.active()).to.deep.equal([])
  })

  it('tells the same story at any time multiplier', () => {
    const at = (rate: number) => {
      const run = new Run(scenarioFor('motor-yacht-20m'), {}, rate)
      run.until(40)
      run.faults.raise('engineOverheat', 'port')
      run.faults.raise('bilgeFlooding')
      run.until(60)
      return [
        last(run.sent, 'propulsion.port.coolantTemperature'),
        run.faults.active().map((f) => f.course)
      ]
    }
    expect(at(60)).to.deep.equal(at(10))
  })

  it('loses the GNSS fix and regains it, quality and satellites to match', () => {
    const run = new Run(scenarioFor('motor-yacht-20m'), {}, 1)
    run.until(40)
    const before = run.minutes(1)
    const satellites = last(before, 'navigation.gnss.satellites') as number
    run.faults.raise('gnssLost')

    const lost = run.minutes(1)
    expect(values(lost, 'navigation.position').length).to.be.at.most(1)
    const lastSecond = lost.slice(-10)
    expect(values(lastSecond, 'navigation.position')).to.deep.equal([])
    expect(values(lastSecond, 'navigation.speedOverGround')).to.deep.equal([])
    expect(values(lastSecond, 'navigation.datetime')).to.deep.equal([])
    expect(last(lastSecond, 'navigation.gnss.methodQuality')).to.equal('no GPS')
    expect(last(lastSecond, 'navigation.gnss.satellites')).to.equal(2)
    // the compass carries on
    expect(values(lastSecond, 'navigation.headingTrue')).to.not.deep.equal([])
    expect(notes(lost, 'navigation.position')[0]).to.include({
      state: 'alarm'
    })

    run.faults.clear('gnssLost', 'gnss')
    const acquiring = run.minutes(1 / 6)
    expect(values(acquiring, 'navigation.position')).to.deep.equal([])
    const fixed = run.minutes(1 / 6)
    expect(last(fixed, 'navigation.gnss.methodQuality')).to.equal('GNSS Fix')
    expect(values(fixed, 'navigation.position')).to.not.deep.equal([])
    expect(last(fixed, 'navigation.gnss.satellites')).to.be.below(satellites)
    expect(notes(fixed, 'navigation.position').at(-1)).to.include({
      state: 'normal'
    })
    // more satellites come in one by one as it settles
    const settling = values(
      run.minutes(2 / 3),
      'navigation.gnss.satellites'
    ) as number[]
    for (let i = 1; i < settling.length; i++) {
      expect(settling[i] - settling[i - 1]).to.be.at.most(1)
    }
    expect(Math.abs(settling.at(-1)! - satellites)).to.be.at.most(2)
    expect(run.faults.active()).to.deep.equal([])
  })

  it('stops a generator starting, with the alarm when a start fails', () => {
    // a yacht of this size runs a generator whenever she is away from the berth
    const run = new Run(scenarioFor('motor-yacht-34m'), {}, 60)
    run.faults.raise('generatorNoStart', 'generator1')
    const sent = run.until(35)
    expect(values(sent, 'propulsion.generator1.state')).to.not.include(
      'started'
    )
    expect(notes(sent, 'propulsion.generator1.state')[0]).to.include({
      state: 'alarm',
      message: 'Generator 1 (port) failed to start'
    })
    run.faults.clear('generatorNoStart', 'generator1')
    const after = run.minutes(5)
    expect(last(after, 'propulsion.generator1.state')).to.equal('started')
    expect(notes(after, 'propulsion.generator1.state').at(-1)).to.include({
      state: 'normal'
    })
  })

  it('fails a cell: the bank sags under load and loses charge faster', () => {
    // at anchor with no generator, nothing charges the house bank: it only discharges
    const profile = loadProfile('sailing-yacht-9m', VESSELS)
    const anchored: Motion = {
      lat: 25,
      lon: -80,
      sogKn: 0,
      cogDeg: 0,
      atBerth: false,
      anchored: true
    }
    const night = Date.parse('2024-03-16T02:00:00Z')
    const after = (failed: number) => {
      const faults: SystemFaults = {
        step: () => {},
        intakeBlocked: () => false,
        refusesStart: () => false,
        cellFailure: (id) => (id === 'house' ? failed : 0),
        alternatorFailed: () => false,
        chargerFailed: () => false,
        bilgePumpW: () => 0
      }
      const model = new SystemsModel(profile, {
        seed: 1,
        startMs: night,
        faults
      })
      const startSoc = model.summary().houseSoc!
      model.advance(night + 3 * 60 * MINUTE, () => anchored)
      const sent = model.deltas(0, true)
      return {
        used: startSoc - model.summary().houseSoc!,
        voltage: last(sent, 'electrical.batteries.house.voltage') as number
      }
    }
    const healthy = after(0)
    const failing = after(1)
    // half the capacity, and more current for the same load at a lower voltage
    expect(failing.used).to.be.above(2 * healthy.used)
    expect(healthy.voltage - failing.voltage).to.be.above(1.9)
  })

  it('raises the low voltage alarm as a cell fails', () => {
    // at anchor, where no charger holds the voltage up
    const run = new Run(scenarioFor('sailing-yacht-9m', 3), {}, 60)
    run.until(30)
    run.faults.raise('batteryCellFailure', 'house')
    const sent = run.minutes(60)
    const raised = notes(sent, 'electrical.batteries.house.voltage')
    expect(raised[0]).to.include({ state: 'warn' })
    expect(raised.at(-1)).to.include({ state: 'alarm' })
    run.faults.clear('batteryCellFailure', 'house')
    const after = run.minutes(5)
    expect(
      notes(after, 'electrical.batteries.house.voltage').at(-1)
    ).to.include({ state: 'normal' })
  })

  it('trips a charger at the berth', () => {
    const run = new Run(scenarioFor('motor-yacht-20m'))
    run.faults.raise('chargerFailure', 'house')
    const sent = run.minutes(5)
    expect(last(sent, 'electrical.chargers.house.chargingMode')).to.equal(
      'other'
    )
    expect(last(sent, 'electrical.chargers.house.current')).to.equal(0)
    expect(notes(sent, 'electrical.chargers.house.chargingMode')[0]).to.include(
      { state: 'warn' }
    )
  })

  it("drops out an alternator: the engine's bank is not charged by it", () => {
    const run = new Run(scenarioFor('motor-yacht-20m'), {}, 60)
    run.until(40)
    run.faults.raise('alternatorFailure', 'port')
    run.faults.raise('alternatorFailure', 'starboard')
    const sent = run.minutes(10)
    expect(last(sent, 'electrical.batteries.start.current')).to.be.below(0)
    expect(notes(sent, 'propulsion.port.alternatorVoltage')[0]).to.include({
      state: 'warn'
    })
  })

  it('floods the bilge: the pump runs, the water rises, and it clears when the leak is stopped', () => {
    const run = new Run(scenarioFor('motor-yacht-20m'), {}, 10)
    run.until(40)
    const fault = run.faults.raise('bilgeFlooding')
    const rising = run.minutes(10)
    expect(values(rising, 'electrical.switches.bilgePump.state')).to.include(1)
    expect(last(rising, 'electrical.switches.bilgeHighWater.state')).to.equal(1)
    expect(
      notes(rising, 'electrical.switches.bilgeHighWater.state')[0]
    ).to.include({ state: 'alarm', message: 'Bilge high water' })
    expect(notes(rising, 'electrical.switches.bilgePump.state')[0]).to.include({
      state: 'warn'
    })
    const after = run.minutes(
      (fault.clearsMs! - run.sim.systems!.scenarioMs) / MINUTE + 10
    )
    expect(last(after, 'electrical.switches.bilgePump.state')).to.equal(0)
    expect(
      notes(after, 'electrical.switches.bilgeHighWater.state').at(-1)
    ).to.include({ state: 'normal' })
    expect(run.faults.active()).to.deep.equal([])
  })

  it('sticks a fuel gauge while the fuel goes on being used', () => {
    const run = new Run(scenarioFor('motor-yacht-20m'), {}, 60)
    run.until(40)
    const tank = run.faults
      .available()
      .find((k) => k.kind === 'fuelGaugeStuck')!.targets[0]
    run.faults.raise('fuelGaugeStuck', tank)
    const fuelBefore = run.sim.systems!.summary().fuelL
    const sent = run.minutes(120)
    const levels = values(sent, `tanks.fuel.${tank}.currentLevel`)
    expect(new Set(levels).size).to.equal(1)
    expect(run.sim.systems!.summary().fuelL).to.be.below(fuelBefore - 30)
  })

  it('silences a depth sounder, and it comes back', () => {
    const run = new Run(scenarioFor('motor-yacht-20m'), {}, 60)
    run.until(40)
    const fault = run.faults.raise('depthSounderSilent', 'sounder')
    const quiet = run.minutes(3)
    expect(values(quiet, 'environment.depth.belowTransducer')).to.deep.equal([])
    expect(notes(quiet, 'environment.depth.belowTransducer')[0]).to.include({
      state: 'warn'
    })
    run.minutes((fault.clearsMs! - run.sim.systems!.scenarioMs) / MINUTE)
    const back = run.minutes(2)
    expect(values(back, 'environment.depth.belowTransducer')).to.not.deep.equal(
      []
    )
  })

  it('freezes the wind instrument', () => {
    const run = new Run(scenarioFor('motor-yacht-20m'), {}, 60)
    run.until(40)
    run.faults.raise('windInstrumentFrozen')
    const sent = run.minutes(30).slice(3)
    expect(
      new Set(values(sent, 'environment.wind.speedApparent')).size
    ).to.equal(1)
    expect(
      new Set(values(sent, 'environment.wind.angleApparent')).size
    ).to.equal(1)
  })

  it('sends a stale value at the time it was read', () => {
    const run = new Run(scenarioFor('motor-yacht-20m'), {}, 60)
    run.until(40)
    run.faults.raise('staleSensor', 'environment.outside.temperature')
    const sent = run.minutes(15)
    const stamped = sent.flatMap((d) =>
      d.updates
        .filter((u) =>
          u.values.some((v) => v.path === 'environment.outside.temperature')
        )
        .map((u) => [u.timestamp, u.values.length])
    )
    expect(new Set(stamped.map((s) => s[0])).size).to.equal(1)
    expect(stamped.every((s) => s[1] === 1)).to.equal(true)
    expect(
      new Set(values(sent, 'environment.outside.temperature')).size
    ).to.equal(1)
  })

  it('resumes faults with the run exactly where they had reached', () => {
    const scenario = scenarioFor('motor-yacht-20m')
    const whole = new Run(scenario, {}, 60)
    whole.until(40)
    whole.faults.raise('engineOverheat', 'port')
    whole.faults.raise('bilgeFlooding')
    whole.until(50)
    const savedSystems = whole.sim.systems!.save()
    const savedFaults = whole.faults.save()
    const savedAlarms = whole.sim.alarms!.save()
    const notified = Object.keys(savedAlarms.notified)
    expect(notified.length).to.be.above(0)
    const tail = whole.minutes(10)

    const resumed = new Run(
      scenario,
      {
        scenarioStartMs: savedSystems.nowMs,
        systemsState: JSON.parse(JSON.stringify(savedSystems)),
        faultsState: JSON.parse(JSON.stringify(savedFaults)),
        alarmsState: JSON.parse(JSON.stringify(savedAlarms))
      },
      60
    )
    const again = resumed.minutes(10)
    expect(resumed.faults.active().map((f) => f.id)).to.deep.equal(
      whole.faults.active().map((f) => f.id)
    )
    expect(last(again, 'propulsion.port.coolantTemperature')).to.equal(
      last(tail, 'propulsion.port.coolantTemperature')
    )
    // a restart sends every notification still raised, for a server that lost them
    expect(
      notes(again.slice(0, 10), 'propulsion.port.coolantTemperature')
    ).to.not.deep.equal([])
  })

  it('resumes a fault that was winding down, until it has', () => {
    const scenario = scenarioFor('motor-yacht-20m')
    const whole = new Run(scenario, {}, 60)
    whole.until(40)
    whole.faults.raise('engineOverheat', 'port')
    whole.until(55)
    whole.faults.clear('engineOverheat', 'port')
    whole.minutes(1)
    expect(whole.faults.active()[0].phase).to.equal('clearing')
    const resumed = new Run(
      scenario,
      {
        scenarioStartMs: whole.sim.systems!.scenarioMs,
        systemsState: whole.sim.systems!.save(),
        faultsState: whole.faults.save()
      },
      60
    )
    resumed.minutes(1)
    expect(resumed.faults.active().map((f) => f.phase)).to.deep.equal([
      'clearing'
    ])
    resumed.minutes(30)
    expect(resumed.faults.active()).to.deep.equal([])
  })

  it('throws faults from the seed at the rate set, and none by default', () => {
    const thrown = (perDay: number | undefined, seed = 1) => {
      const run = new Run(
        scenarioFor('motor-yacht-20m'),
        { faultsPerDay: perDay, seed },
        60
      )
      const seen = new Set<string>()
      for (let m = 0; m < 9 * 60; m += 10) {
        run.minutes(10)
        for (const f of run.faults.active()) seen.add(`${f.id}@${f.raisedMs}`)
      }
      return [...seen]
    }
    expect(thrown(undefined)).to.deep.equal([])
    const first = thrown(12)
    expect(first.length).to.be.at.least(2)
    expect(thrown(12)).to.deep.equal(first)
    expect(thrown(12, 2)).to.not.deep.equal(first)
  })

  it('validates everything a run with faults sends', () => {
    const run = new Run(scenarioFor('motor-yacht-20m'), {}, 30)
    run.until(40)
    for (const k of run.faults.available()) run.faults.raise(k.kind)
    const sent = run.minutes(60)
    expect(sent.flatMap(schemaProblems)).to.deep.equal([])
  })
})

describe('Simulator run control', () => {
  it('pauses, changes multiplier and jumps forward, the scenario clock following', () => {
    const run = new Run(scenarioFor('motor-yacht-20m'), {}, 10)
    run.minutes(1)
    const at = () => run.sim.systems!.scenarioMs
    const t0 = at()
    run.sim.retime(run.wallMs, { paused: true })
    run.minutes(1)
    expect(at() - t0).to.be.at.most(2000)
    const paused = at()
    run.sim.retime(run.wallMs, { paused: false, rate: 60 })
    run.wallMs += 10000
    run.sim.tick(run.wallMs)
    expect(at() - paused).to.be.within(598000, 600000)
    expect(run.sim.timeMultiplier).to.equal(60)

    const target = START + 120 * MINUTE
    run.sim.jump(run.wallMs, target)
    run.wallMs += 1000
    run.sim.tick(run.wallMs)
    expect(at()).to.be.within(target, target + 62000)
    expect(() => run.sim.jump(run.wallMs, START)).to.throw(RangeError)
  })
})
