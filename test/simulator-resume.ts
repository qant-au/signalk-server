import { expect } from 'chai'
import { copyFileSync, mkdirSync, mkdtempSync, writeFileSync } from 'fs'
import { rm } from 'fs/promises'
import os from 'os'
import path from 'path'
import { Scenario } from '../simulator/engine/scenario'
import { Simulation } from '../simulator/engine/simulation'
import simulatorPlugin from '../simulator/plugin/index'
import { Route, routeLegs } from '../simulator/routes/route'
import { Delta } from '../simulator/soak/deltas'
import {
  STEP_S,
  StaleStateError,
  SystemsState
} from '../simulator/systems/model'
import {
  VesselProfile,
  listProfiles,
  loadProfile
} from '../simulator/vessels/profile'

const VESSELS = path.join(__dirname, '..', 'simulator', 'vessels')
const START = Date.parse('2024-07-13T09:00:00Z')
const MINUTE = 60000
const HOUR = 60 * MINUTE
const TICK_MS = 10000

const profiles = listProfiles(VESSELS).map((id) => loadProfile(id, VESSELS))

/** half an hour at the berth, about two and a half hours under way, then alongside again */
function scenarioFor(profile: VesselProfile): Scenario {
  const speedKn = 0.7 * profile.maxSpeedKn
  const route: Route = {
    name: 'test',
    departure: new Date(START + 30 * MINUTE).toISOString(),
    vessel: {
      description: profile.name,
      lengthM: profile.lengthM,
      draftM: profile.draftM,
      typeCode: profile.typeCode,
      profile: profile.id
    },
    source: 'test',
    waypoints: [
      { name: 'A', lat: -27.45, lon: 153.2, speedKn },
      { name: 'B', lat: -27.45 + (speedKn * 2.5) / 60, lon: 153.2 }
    ]
  }
  return {
    sampleId: 'test',
    route,
    plannedRoute: route,
    legs: routeLegs(route),
    adjustments: [],
    profile,
    notes: []
  }
}

interface Run {
  sim: Simulation
  /** deltas sent by ticks, without the ones sent when the run starts */
  ticked: Delta[]
}

function startRun(
  scenario: Scenario,
  scenarioStartMs: number,
  wallStartMs: number,
  timeMultiplier = 1,
  systemsState?: SystemsState
): Run {
  const run: Run = { sim: undefined as unknown as Simulation, ticked: [] }
  let started = false
  run.sim = new Simulation(
    scenario,
    {
      timeMultiplier,
      showTraffic: false,
      scenarioStartMs,
      seed: 7,
      systemsState
    },
    (d) => started && run.ticked.push(d),
    wallStartMs
  )
  started = true
  return run
}

function tickTo(
  run: Run,
  fromWallMs: number,
  toWallMs: number,
  stepMs = TICK_MS
) {
  for (let wall = fromWallMs + stepMs; wall <= toWallMs; wall += stepMs)
    run.sim.tick(wall)
}

/** through JSON, as the plugin's saved file carries it */
function saved(run: Run): SystemsState {
  return JSON.parse(JSON.stringify(run.sim.systems!.save()))
}

describe('Simulator resume', () => {
  for (const profile of profiles) {
    it(`carries ${profile.id} on as the same run after a restart`, () => {
      const scenario = scenarioFor(profile)
      const unbroken = startRun(scenario, START, 0)
      tickTo(unbroken, 0, 2 * HOUR)
      const afterTwoHours = unbroken.ticked.length
      tickTo(unbroken, 2 * HOUR, 4 * HOUR)

      const first = startRun(scenario, START, 0)
      tickTo(first, 0, 2 * HOUR)
      const state = saved(first)
      const resumed = startRun(scenario, START + 2 * HOUR, 2 * HOUR, 1, state)
      tickTo(resumed, 2 * HOUR, 4 * HOUR)

      expect(resumed.sim.systems!.save()).to.deep.equal(
        unbroken.sim.systems!.save()
      )
      expect(resumed.ticked).to.deep.equal(unbroken.ticked.slice(afterTwoHours))
    })
  }

  const yacht = profiles.find((p) => p.id === 'motor-yacht-20m')!

  it('keeps the systems through a change of time multiplier', () => {
    const scenario = scenarioFor(yacht)
    const unbroken = startRun(scenario, START, 0)
    tickTo(unbroken, 0, 4 * HOUR)

    const first = startRun(scenario, START, 0)
    tickTo(first, 0, 2 * HOUR)
    // two scenario hours at x60 take two real minutes, ticked every real second
    const faster = startRun(scenario, START + 2 * HOUR, 0, 60, saved(first))
    tickTo(faster, 0, 2 * MINUTE, 1000)

    expect(faster.sim.systems!.save()).to.deep.equal(
      unbroken.sim.systems!.save()
    )
  })

  it('counts engine hours at the scenario rate, not the wall clock rate', () => {
    const scenario = scenarioFor(yacht)
    const first = startRun(scenario, START, 0)
    tickTo(first, 0, HOUR)
    const runS = (s: SystemsState) =>
      s.engines.find((e) => e.id === 'port')!.values.runS as number
    const before = saved(first)
    // an hour under way at x60 is one real minute
    const faster = startRun(scenario, START + HOUR, 0, 60, before)
    tickTo(faster, 0, MINUTE, 1000)
    const ran = runS(saved(faster)) - runS(before)
    expect(ran).to.be.within(3600 - STEP_S, 3600)
  })

  it('refuses a saved state for another profile, seed or format', () => {
    const scenario = scenarioFor(yacht)
    const first = startRun(scenario, START, 0)
    tickTo(first, 0, 10 * MINUTE)
    const state = saved(first)
    const resume = (s: SystemsState) => () =>
      startRun(scenario, START + 10 * MINUTE, 0, 1, s)
    expect(resume(state)).to.not.throw()
    expect(resume({ ...state, profileId: 'yacht-12m' })).to.throw(
      StaleStateError
    )
    expect(resume({ ...state, seed: 8 })).to.throw(StaleStateError)
    expect(resume({ ...state, version: 0 })).to.throw(StaleStateError)
    expect(resume({ ...state, tanks: state.tanks.slice(1) })).to.throw(
      StaleStateError
    )
    const banks = structuredClone(state.banks)
    banks[0].values.soc = 'full'
    expect(resume({ ...state, banks })).to.throw(StaleStateError)
  })
})

describe('Simulator plugin resume', () => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), 'simulator-resume-'))
  const samples = path.join(tmp, 'samples')
  const dataDir = path.join(tmp, 'data')
  const stateFile = path.join(dataDir, 'state.json')
  const scenario = scenarioFor(yacht())

  function yacht(): VesselProfile {
    return loadProfile('motor-yacht-20m', VESSELS)
  }

  before(() => {
    mkdirSync(path.join(samples, 'test'), { recursive: true })
    mkdirSync(path.join(tmp, 'vessels'))
    mkdirSync(dataDir)
    copyFileSync(
      path.join(VESSELS, 'motor-yacht-20m.json'),
      path.join(tmp, 'vessels', 'motor-yacht-20m.json')
    )
    writeFileSync(
      path.join(samples, 'test', 'sample.json'),
      JSON.stringify({ id: 'test' })
    )
    writeFileSync(
      path.join(samples, 'test', 'route.json'),
      JSON.stringify(scenario.route)
    )
    process.env.SIGNALK_SIMULATOR_SAMPLES = samples
  })

  after(async () => {
    delete process.env.SIGNALK_SIMULATOR_SAMPLES
    await rm(tmp, { recursive: true, force: true })
  })

  /** starts the plugin, waits for its first tick, and gives back what it logged and sent */
  async function startPlugin(settings: Record<string, unknown>) {
    const errors: string[] = []
    const deltas: Partial<Delta>[] = []
    const plugin = simulatorPlugin({
      handleMessage: (_id: string, delta: Partial<Delta>) => deltas.push(delta),
      setPluginStatus: () => undefined,
      setPluginError: (message: string) =>
        errors.push(`plugin error: ${message}`),
      getDataDirPath: () => dataDir,
      error: (message: string) => errors.push(message),
      debug: () => undefined,
      resourcesApi: { setResource: async () => undefined },
      activateRoute: async () => undefined,
      clearDestination: async () => undefined
    })
    plugin.start({ sample: 'test', seed: 7, ...settings })
    const deadline = Date.now() + 5000
    const runTimes = () =>
      deltas.flatMap((d) =>
        (d.updates ?? []).flatMap((u) =>
          u.values
            .filter((v) => v.path === 'propulsion.port.runTime')
            .map((v) => v.value as number)
        )
      )
    while (!runTimes().length && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
    plugin.stop()
    return { errors, portRunTime: runTimes()[0] }
  }

  function writeSaved(systems: SystemsState | undefined, sample = 'test') {
    writeFileSync(
      stateFile,
      JSON.stringify({ sample, scenarioMs: START + HOUR, systems })
    )
  }

  function savedAfterAnHour(): SystemsState {
    const run = startRun(scenario, START, 0)
    tickTo(run, 0, HOUR)
    const state = saved(run)
    // a run-time no fresh start could give, so a restored one is plain to see
    state.engines[0].values.runS = 12345678
    return state
  }

  it('restores the saved systems', async () => {
    writeSaved(savedAfterAnHour())
    const { errors, portRunTime } = await startPlugin({})
    expect(errors).to.deep.equal([])
    expect(portRunTime).to.be.within(12345678, 12345678 + 2 * STEP_S)
  })

  it('starts the systems fresh for another seed, or with resume off', async () => {
    writeSaved(savedAfterAnHour())
    for (const settings of [{ seed: 8 }, { resume: false }]) {
      const { errors, portRunTime } = await startPlugin(settings)
      expect(errors).to.deep.equal([])
      expect(portRunTime).to.be.below(12345678)
    }
  })

  it('logs and ignores a stale saved state', async () => {
    writeSaved({ ...savedAfterAnHour(), version: 0 })
    const { errors, portRunTime } = await startPlugin({})
    expect(errors).to.have.length(1)
    expect(errors[0]).to.match(/systems start fresh: .*format 0/)
    expect(portRunTime).to.be.below(12345678)
  })

  it('logs and ignores an unreadable saved file', async () => {
    writeFileSync(stateFile, '{"sample": "test", "scenarioMs"')
    const { errors, portRunTime } = await startPlugin({})
    expect(errors).to.have.length(1)
    expect(errors[0]).to.match(/ignoring the saved run/)
    expect(portRunTime).to.be.a('number')
  })
})
