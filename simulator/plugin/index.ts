import { existsSync, readFileSync, writeFileSync } from 'fs'
import path from 'path'
import { routeResource, routeResourceId } from '../routes/resource'
import { Scenario, listSamples, loadScenario } from '../engine/scenario'
import { Simulation } from '../engine/simulation'
import { Delta } from '../soak/deltas'

/**
 * The Signal K Simulator as a server plugin. Its settings are on the plugin's page in the
 * Admin UI (Server, Plugin Config, Signal K Simulator); saving them restarts the run with
 * the new settings, carrying on from the scenario time it had reached.
 */
interface Options {
  sample: string
  startAtMinutes: number
  resume: boolean
  timeMultiplier: number
  minDepthUnderKeelM: number
  showTraffic: boolean
  receiverAntennaHeightM: number
  seed: number
}

interface SavedState {
  sample: string
  scenarioMs: number
}

// The subset of the server's plugin API this plugin uses.
interface App {
  handleMessage(id: string, delta: Partial<Delta>): void
  setPluginStatus(message: string): void
  setPluginError(message: string): void
  getDataDirPath(): string
  debug(...args: unknown[]): void
  resourcesApi: {
    setResource(
      type: string,
      id: string,
      data: Record<string, unknown>
    ): Promise<void>
  }
}

const PLUGIN_ID = 'signalk-simulator'
const TICK_MS = 1000
const SAVE_EVERY_TICKS = 10
const TIME_MULTIPLIERS = [1, 2, 5, 10, 20, 30, 60, 120, 300]
const DEFAULTS: Options = {
  sample: 'miami-icw-2024-03-16',
  startAtMinutes: 0,
  resume: true,
  timeMultiplier: 1,
  minDepthUnderKeelM: 1,
  showTraffic: true,
  receiverAntennaHeightM: 10,
  seed: 1
}

function samplesDir(): string {
  return (
    process.env.SIGNALK_SIMULATOR_SAMPLES ??
    path.resolve(__dirname, '..', '..', '..', 'samples')
  )
}

function fmtTime(ms: number): string {
  return new Date(ms).toISOString().replace('T', ' ').slice(0, 16) + 'Z'
}

export = function simulatorPlugin(app: App) {
  let timer: NodeJS.Timeout | undefined
  let simulation: Simulation | undefined
  let stopped = false

  const stateFile = () => path.join(app.getDataDirPath(), 'state.json')

  function readState(): SavedState | undefined {
    try {
      return existsSync(stateFile())
        ? JSON.parse(readFileSync(stateFile(), 'utf8'))
        : undefined
    } catch {
      return undefined
    }
  }

  function saveState(state: SavedState) {
    writeFileSync(stateFile(), JSON.stringify(state))
  }

  async function publishRoute(scenario: Scenario) {
    const route = scenario.route
    await app.resourcesApi.setResource(
      'routes',
      routeResourceId(route),
      routeResource(route) as unknown as Record<string, unknown>
    )
  }

  async function run(options: Options) {
    app.setPluginStatus(`Loading ${options.sample}`)
    const scenario = await loadScenario(samplesDir(), options.sample, {
      minDepthUnderKeelM: options.minDepthUnderKeelM,
      receiverAntennaHeightM: options.receiverAntennaHeightM
    })
    if (stopped) return
    try {
      await publishRoute(scenario)
    } catch (error) {
      app.debug('could not publish the route', error)
    }

    const departure = scenario.legs[0].departMs
    const saved = readState()
    const scenarioStartMs =
      options.resume && saved?.sample === options.sample
        ? saved.scenarioMs
        : departure + options.startAtMinutes * 60000

    simulation = new Simulation(
      scenario,
      {
        timeMultiplier: options.timeMultiplier,
        showTraffic: options.showTraffic,
        scenarioStartMs,
        seed: options.seed
      },
      (delta) => app.handleMessage(PLUGIN_ID, delta),
      Date.now()
    )
    const adjusted = scenario.adjustments.filter(
      (a) => a.resolved && a.added
    ).length
    const notes = [
      adjusted ? `${adjusted} legs moved for depth` : '',
      ...scenario.notes
    ].filter(Boolean)

    let ticks = 0
    timer = setInterval(() => {
      if (!simulation) return
      const result = simulation.tick(Date.now())
      ticks++
      if (ticks % SAVE_EVERY_TICKS === 0 || result.finished) {
        saveState({ sample: options.sample, scenarioMs: result.scenarioMs })
      }
      const depth =
        result.depthM !== undefined
          ? `, depth ${result.depthM.toFixed(1)} m`
          : ''
      const traffic = options.showTraffic
        ? `, ${simulation.trafficCount} AIS targets heard`
        : ', traffic off'
      const onBoard = simulation.systems?.summary()
      const systems = onBoard
        ? `, ${onBoard.enginesRunning} engines and ${onBoard.generatorsRunning} generators running`
        : ''
      app.setPluginStatus(
        `${result.finished ? 'Arrived' : 'Under way'}: ${fmtTime(result.scenarioMs)} ` +
          `at x${options.timeMultiplier}, ${result.position.sogKn} kn${depth}${traffic}${systems}` +
          (notes.length ? ` (${notes.join('; ')})` : '')
      )
      if (result.finished && timer) {
        clearInterval(timer)
        timer = undefined
      }
    }, TICK_MS)
  }

  return {
    id: PLUGIN_ID,
    name: 'Signal K Simulator',
    description:
      'Sails a sample scenario: own boat on its route with its systems, depth under the keel, and the AIS traffic it would hear',

    schema: () => {
      const samples = listSamples(samplesDir())
      return {
        type: 'object',
        properties: {
          sample: {
            type: 'string',
            title: 'Sample',
            enum: samples.length ? samples : [DEFAULTS.sample],
            default: DEFAULTS.sample
          },
          timeMultiplier: {
            type: 'number',
            title: 'Time multiplier',
            description: 'Scenario seconds per real second',
            enum: TIME_MULTIPLIERS,
            default: DEFAULTS.timeMultiplier
          },
          minDepthUnderKeelM: {
            type: 'number',
            title: 'Minimum depth under keel (m)',
            description:
              'The route is moved out of water shallower than the draft plus this; marinas are exempt',
            minimum: 0,
            default: DEFAULTS.minDepthUnderKeelM
          },
          showTraffic: {
            type: 'boolean',
            title: 'Show traffic',
            description: 'Send the AIS targets the boat would hear',
            default: DEFAULTS.showTraffic
          },
          seed: {
            type: 'integer',
            title: 'Seed',
            description:
              'Seed for the boat systems: the same seed and start repeat a run exactly',
            default: DEFAULTS.seed
          },
          receiverAntennaHeightM: {
            type: 'number',
            title: 'Own AIS antenna height (m)',
            minimum: 1,
            default: DEFAULTS.receiverAntennaHeightM
          },
          startAtMinutes: {
            type: 'number',
            title: 'Start this many minutes into the route',
            description: 'Used when not resuming, or after changing the sample',
            minimum: 0,
            default: DEFAULTS.startAtMinutes
          },
          resume: {
            type: 'boolean',
            title: 'Resume where the last run reached',
            default: DEFAULTS.resume
          }
        }
      }
    },

    start(settings: Partial<Options>) {
      stopped = false
      const options = { ...DEFAULTS, ...settings }
      run(options).catch((error: Error) => {
        app.setPluginError(error.message)
      })
    },

    stop() {
      stopped = true
      if (timer) clearInterval(timer)
      timer = undefined
      simulation = undefined
    }
  }
}
