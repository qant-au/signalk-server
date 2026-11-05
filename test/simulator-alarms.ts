import { expect } from 'chai'
import path from 'path'
import { AlarmPanel } from '../simulator/alarms/panel'
import { DEFAULT_SHALLOW_M, alarmBands } from '../simulator/alarms/zones'
import { Scenario } from '../simulator/engine/scenario'
import { Simulation } from '../simulator/engine/simulation'
import { Route, routeLegs } from '../simulator/routes/route'
import { Delta, SOURCE } from '../simulator/soak/deltas'
import {
  ProfileFile,
  loadProfile,
  resolveProfile
} from '../simulator/vessels/profile'

const VESSELS = path.join(__dirname, '..', 'simulator', 'vessels')
const START = Date.parse('2024-03-16T14:00:00Z')
const MINUTE = 60000
const KELVIN = 273.15

/** under way from ten minutes in, over water as deep as `depth` says */
function scenarioFor(profileId: string, depth: () => number): Scenario {
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
    waypoints: [
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
    depth: { depth } as unknown as Scenario['depth'],
    notes: []
  }
}

interface Note {
  state: string
  method: string[]
  message: string
}

function notes(deltas: Delta[], p: string): Note[] {
  return deltas.flatMap((d) =>
    d.updates.flatMap((u) =>
      u.values
        .filter((v) => v.path === `notifications.${p}`)
        .map((v) => v.value as Note)
    )
  )
}

const delta = (values: { path: string; value: unknown }[]): Delta => ({
  context: 'vessels.self',
  updates: [{ source: SOURCE, timestamp: new Date(0).toISOString(), values }]
})

describe('Simulator alarms', () => {
  it('gives every watched value its zones, by the kind of thing and its size', () => {
    const p = loadProfile('motor-yacht-45m', VESSELS)
    const bands = alarmBands(p, DEFAULT_SHALLOW_M)
    const coolant = bands.get('propulsion.port.coolantTemperature')!
    expect(coolant.zones.map((z) => [z.lower, z.state])).to.deep.equal([
      [95 + KELVIN, 'warn'],
      [100 + KELVIN, 'alarm']
    ])
    // a generator's coolant and oil are watched as a main engine's are
    expect(bands.has('propulsion.generator1.oilPressure')).to.equal(true)
    expect(bands.get('propulsion.port.oilPressure')!.whileStarted).to.equal(
      'propulsion.port.state'
    )
    // a lithium house bank and a lead-acid start bank, both 24 V, sag to different alarms
    const house = p.banks.find((b) => b.id === 'house')!
    const start = p.banks.find((b) => b.id === 'start')!
    expect([house.chemistry, start.chemistry]).to.deep.equal(['LiFePO4', 'AGM'])
    const lowAlarm = (id: string) =>
      bands
        .get(`electrical.batteries.${id}.voltage`)!
        .zones.find((z) => z.state === 'alarm' && z.lower === undefined)!.upper
    expect(lowAlarm('house')).to.be.closeTo(23.2, 1e-9)
    expect(lowAlarm('start')).to.be.closeTo(22.0, 1e-9)
    // fuel and water warn low, the holding tanks high
    const fuel = bands.get(`tanks.fuel.${p.tanks.fuel[0].id}.currentLevel`)!
    expect(fuel.zones.every((z) => z.upper !== undefined)).to.equal(true)
    const black = bands.get(
      `tanks.blackWater.${p.tanks.blackWater[0].id}.currentLevel`
    )!
    expect(black.zones.every((z) => z.lower !== undefined)).to.equal(true)
    // a fridge and a freezer warn by their own setpoints
    const fridge = p.zones.find((z) => z.kind === 'fridge')!
    expect(
      bands.get(`environment.inside.${fridge.id}.temperature`)!.zones[0].lower
    ).to.be.closeTo(fridge.setpointC + 4 + KELVIN, 1e-9)
    expect(bands.get('environment.depth.belowKeel')!.zones).to.deep.equal([
      { upper: DEFAULT_SHALLOW_M, state: 'alarm', message: 'Shallow water' }
    ])
    // the wind warning grows with the boat, and a small boat with no wind instrument has none
    const windWarn = (id: string) =>
      alarmBands(loadProfile(id, VESSELS), 1).get('environment.wind.speedTrue')
        ?.zones[0].lower
    expect(windWarn('motor-yacht-45m')!).to.be.above(windWarn('yacht-12m')!)
    expect(windWarn('boat-4m')).to.equal(undefined)
  })

  it("takes a profile's own zones in place of the defaults, and refuses bad ones", () => {
    const file: ProfileFile = {
      id: 'test',
      name: 'test',
      lengthM: 12,
      alarmZones: {
        'propulsion.port.coolantTemperature': [
          { lower: 90 + KELVIN, state: 'alarm', message: 'Port engine hot' }
        ]
      }
    }
    const bands = alarmBands(resolveProfile(file), 1)
    expect(
      bands.get('propulsion.port.coolantTemperature')!.zones
    ).to.deep.equal([
      { lower: 90 + KELVIN, state: 'alarm', message: 'Port engine hot' }
    ])
    // the margin is the default's
    expect(bands.get('propulsion.port.coolantTemperature')!.margin).to.equal(2)
    expect(() =>
      resolveProfile({
        ...file,
        alarmZones: { 'propulsion.centre.coolantTemperature': [] }
      })
    ).to.throw(/no alarm on propulsion.centre/)
    expect(() =>
      resolveProfile({
        ...file,
        alarmZones: {
          'propulsion.port.coolantTemperature': [
            { lower: 2, upper: 1, state: 'alarm', message: 'x' }
          ]
        }
      })
    ).to.throw(/lower 2 is not below upper 1/)
    expect(() =>
      resolveProfile({
        ...file,
        alarmZones: {
          'propulsion.port.coolantTemperature': [
            { lower: 2, state: 'danger' as 'alarm', message: 'x' }
          ]
        }
      })
    ).to.throw(/state danger/)
  })

  it('raises from the zone, holds to the margin, and clears with normal', () => {
    const p = loadProfile('motor-yacht-20m', VESSELS)
    const panel = new AlarmPanel(alarmBands(p, 1.5))
    const path = 'propulsion.port.coolantTemperature'
    const step = (c: number) => {
      panel.record(delta([{ path, value: c + KELVIN }]))
      return notes(
        [panel.notifications(0, SOURCE, new Map()) ?? delta([])],
        path
      )
    }
    expect(step(90)).to.deep.equal([])
    expect(step(96)).to.deep.equal([
      {
        state: 'warn',
        method: ['visual'],
        message: 'Port engine coolant temperature high'
      }
    ])
    expect(step(101)[0]).to.deep.include({
      state: 'alarm',
      method: ['visual', 'sound'],
      message: 'Port engine overheating'
    })
    // back below the alarm, but within its margin: held
    expect(step(99)).to.deep.equal([])
    expect(step(97.5)[0].state).to.equal('warn')
    expect(step(93.5)).to.deep.equal([])
    expect(step(92.5)[0]).to.include({ state: 'normal' })
    expect(panel.active()).to.deep.equal([])
  })

  it('watches oil pressure only while the engine runs, and stops reading a value that has gone quiet', () => {
    const p = loadProfile('motor-yacht-20m', VESSELS)
    const panel = new AlarmPanel(alarmBands(p, 1.5))
    const send = (values: { path: string; value: unknown }[]) => {
      panel.record(delta(values))
      return panel.notifications(0, SOURCE, new Map())
    }
    expect(
      send([
        { path: 'propulsion.port.state', value: 'stopped' },
        { path: 'propulsion.port.oilPressure', value: 0 }
      ])
    ).to.equal(undefined)
    const running = send([
      { path: 'propulsion.port.state', value: 'started' },
      { path: 'propulsion.port.oilPressure', value: 50000 }
    ])
    expect(notes([running!], 'propulsion.port.oilPressure')[0].state).to.equal(
      'alarm'
    )
    const shallow = send([{ path: 'environment.depth.belowKeel', value: 1 }])
    expect(notes([shallow!], 'environment.depth.belowKeel')[0].state).to.equal(
      'alarm'
    )
    // no depth is not shallow depth: once the sounder has gone quiet, the alarm clears
    let cleared: Note[] = []
    for (let i = 0; i < 20 && !cleared.length; i++) {
      cleared = notes([send([]) ?? delta([])], 'environment.depth.belowKeel')
    }
    expect(cleared[0]).to.include({ state: 'normal', message: 'Shallow water' })
  })

  it('sends the zones in the metadata, and raises and clears the shallow alarm with the depth', () => {
    let depthM = 20
    const scenario = scenarioFor('motor-yacht-20m', () => depthM)
    const draft = scenario.profile!.draftM
    const sent: Delta[] = []
    const sim = new Simulation(
      scenario,
      {
        timeMultiplier: 10,
        showTraffic: false,
        scenarioStartMs: START + 20 * MINUTE,
        seed: 1,
        shallowM: 2
      },
      (d) => sent.push(d),
      0
    )
    const meta = sent.flatMap((d) => d.updates.flatMap((u) => u.meta ?? []))
    const keel = meta.find((m) => m.path === 'environment.depth.belowKeel')!
    expect(keel.value.zones).to.deep.equal([
      { upper: 2, state: 'alarm', message: 'Shallow water' }
    ])
    expect(keel.value.description).to.be.a('string')
    expect(keel.value.alarmMethod).to.deep.equal(['visual', 'sound'])
    expect(keel.value.warnMethod).to.deep.equal(['visual'])
    // the panel raises these zones' notifications, so the server raises none of its own
    const zoned = meta.filter((m) => m.value.zones)
    expect(zoned.length).to.be.above(20)
    expect(
      zoned.every((m) => m.value.zonesNotifiedBy === 'simulator')
    ).to.equal(true)
    expect(meta.some((m) => m.path.endsWith('.oilPressure'))).to.equal(true)
    let wall = 0
    const run = (seconds: number) => {
      const from = sent.length
      for (let i = 0; i < seconds / 10; i++) sim.tick((wall += 1000))
      return sent.slice(from)
    }
    run(60)
    depthM = draft + 1.5
    const shallow = notes(run(30), 'environment.depth.belowKeel')
    expect(shallow).to.have.length(1)
    expect(shallow[0]).to.deep.equal({
      state: 'alarm',
      method: ['visual', 'sound'],
      message: 'Shallow water'
    })
    // deeper, but not by the margin: held
    depthM = draft + 2.2
    expect(notes(run(60), 'environment.depth.belowKeel')).to.deep.equal([])
    depthM = draft + 2.4
    expect(notes(run(30), 'environment.depth.belowKeel')[0]).to.include({
      state: 'normal'
    })

    // a silent sounder over shallow water raises no shallow alarm
    sim.faults!.raise('depthSounderSilent', 'sounder')
    depthM = draft + 0.5
    const silent = run(120)
    expect(notes(silent, 'environment.depth.belowKeel')).to.deep.equal([])
    expect(notes(silent, 'environment.depth.belowTransducer')[0]).to.include({
      state: 'warn'
    })
  })

  it('raises nothing on a boat going about her day with the defaults', () => {
    const scenario = scenarioFor('motor-yacht-20m', () => 20)
    const sent: Delta[] = []
    const sim = new Simulation(
      scenario,
      {
        timeMultiplier: 60,
        showTraffic: false,
        scenarioStartMs: START,
        seed: 1
      },
      (d) => sent.push(d),
      0
    )
    for (let i = 1; i <= 180; i++) sim.tick(i * 1000)
    const raised = sent.flatMap((d) =>
      d.updates.flatMap((u) =>
        u.values.filter((v) => v.path.startsWith('notifications.'))
      )
    )
    expect(raised).to.deep.equal([])
  })
})
