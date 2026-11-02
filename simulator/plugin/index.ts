import { existsSync, readFileSync, renameSync, writeFileSync } from 'fs'
import path from 'path'
import { routeResource, routeResourceId } from '../routes/resource'
import { nextPointIndex } from '../routes/route'
import {
  DEFAULT_MIN_DEPTH_UNDER_KEEL_M,
  DEFAULT_RECEIVER_ANTENNA_HEIGHT_M,
  Scenario,
  listSamples,
  loadScenario
} from '../engine/scenario'
import { Simulation } from '../engine/simulation'
import {
  Delta,
  IDENTITY_FIELDS,
  IdentityField,
  SERVER_KEPT_FIELDS,
  identityPathValue,
  identityValues,
  vesselIdentity
} from '../soak/deltas'
import { StaleStateError, SystemsState } from '../systems/model'

/**
 * The Signal K Simulator as a server plugin. Its settings are on the plugin's page in the
 * Admin UI (Server, Plugin Config, Signal K Simulator); saving them restarts the run with
 * the new settings, carrying on from the scenario time it had reached.
 *
 * The route the boat sails is published as a resource and made the server's active route
 * through the Course API, so `navigation.course.*` follows the passage: the next point
 * moves on in the tick the boat passes it, before that tick's position goes out.
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

/** the systems belong to the sample here, and to the profile and seed they carry */
interface SavedState {
  sample: string
  scenarioMs: number
  systems?: SystemsState
}

// The subset of the server's plugin API this plugin uses.
interface App {
  handleMessage(id: string, delta: Partial<Delta>): void
  setPluginStatus(message: string): void
  setPluginError(message: string): void
  getDataDirPath(): string
  error(message: string): void
  debug(...args: unknown[]): void
  resourcesApi: {
    setResource(
      type: string,
      id: string,
      data: Record<string, unknown>
    ): Promise<void>
  }
  activateRoute(route: { href: string; pointIndex: number }): Promise<void>
  clearDestination(): Promise<void>
  /**
   * The server's configuration. The plugin API has no reader for the owner's vessel
   * settings, so they are read where the server keeps them: the base deltas the Admin
   * UI's vessel page writes, and a `vessel` block in settings.json.
   */
  config?: {
    baseDeltaEditor?: {
      getSelfValue(path: string): unknown
      setSelfValue(path: string, value: unknown): void
      removeSelfValue(path: string): void
    }
    settings?: { vessel?: Record<string, unknown> }
  }
}

/** a short name for each identity field, for the status line */
const FIELD_LABELS: Record<IdentityField, string> = {
  name: 'name',
  mmsi: 'MMSI',
  'design.length': 'length',
  'design.beam': 'beam',
  'design.draft': 'draft',
  'design.airHeight': 'air height',
  'design.displacement': 'displacement',
  'design.aisShipType': 'ship type',
  'sensors.ais.fromBow': 'AIS antenna from bow',
  'sensors.ais.fromCenter': 'AIS antenna from centre'
}

const PLUGIN_ID = 'signalk-simulator'
const TICK_MS = 1000
const SAVE_EVERY_TICKS = 10
const TIME_MULTIPLIERS = [1, 2, 5, 10, 20, 24, 30, 60, 120, 300]
const DEFAULTS: Options = {
  sample: 'miami-icw-2024-03-16',
  startAtMinutes: 0,
  resume: true,
  timeMultiplier: 1,
  minDepthUnderKeelM: DEFAULT_MIN_DEPTH_UNDER_KEEL_M,
  showTraffic: true,
  receiverAntennaHeightM: DEFAULT_RECEIVER_ANTENNA_HEIGHT_M,
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
    if (!existsSync(stateFile())) return undefined
    try {
      const state = JSON.parse(readFileSync(stateFile(), 'utf8'))
      if (
        typeof state?.sample !== 'string' ||
        !Number.isFinite(state.scenarioMs)
      ) {
        throw new Error('no sample or scenario time')
      }
      return state
    } catch (error) {
      app.error(
        `ignoring the saved run in ${stateFile()}: ${(error as Error).message}`
      )
      return undefined
    }
  }

  function saveState(state: SavedState) {
    // written whole and then renamed, so a stop mid-write cannot leave half a file
    const temporary = stateFile() + '.tmp'
    writeFileSync(temporary, JSON.stringify(state))
    renameSync(temporary, stateFile())
  }

  /** the saved systems, when they belong to this run; otherwise the systems start fresh */
  function savedSystems(
    options: Options,
    scenario: Scenario,
    saved: SavedState | undefined
  ): SystemsState | undefined {
    const systems = saved?.systems
    if (!options.resume || saved?.sample !== options.sample || !systems)
      return undefined
    if (
      systems.profileId !== scenario.profile?.id ||
      systems.seed !== options.seed
    ) {
      app.debug(
        `systems start fresh: saved for ${systems.profileId} seed ${systems.seed}`
      )
      return undefined
    }
    return systems
  }

  /**
   * The identity fields the owner's own vessel settings already give, which the plugin
   * leaves alone: whatever the server's base deltas hold (the Admin UI's vessel page), and
   * a name or MMSI in settings.json's `vessel` block, which this server no longer reads
   * itself but which still says what the owner calls the boat.
   */
  function ownerFields(): IdentityField[] {
    const base = app.config?.baseDeltaEditor
    const legacy = app.config?.settings?.vessel ?? {}
    const given = (v: unknown) => v !== undefined && v !== null && v !== ''
    return IDENTITY_FIELDS.filter(
      (field) =>
        given(base?.getSelfValue(field)) ||
        ((field === 'name' || field === 'mmsi') && given(legacy[field]))
    )
  }

  /** the fields this plugin put into the server's vessel settings, in memory, with their values */
  const lent = new Map<IdentityField, unknown>()

  /**
   * Puts the sample's name, MMSI and the dimensions the server keeps for itself into the
   * server's vessel settings, in memory only (never saved), for each field the owner has
   * not set, and sends them as the server sends its own settings, sourced `defaults`. The
   * server drops these fields from any other source. Gives the fields it set.
   */
  function lendIdentity(scenario: Scenario, owned: IdentityField[]) {
    const base = app.config?.baseDeltaEditor
    if (!base) return []
    const values = identityValues(
      vesselIdentity(scenario.route.vessel, scenario.profile)
    )
    const fields = SERVER_KEPT_FIELDS.filter(
      (f) => !owned.includes(f) && values.has(f)
    )
    for (const field of fields) {
      base.setSelfValue(field, values.get(field))
      lent.set(field, values.get(field))
    }
    if (fields.length) {
      app.handleMessage(PLUGIN_ID, {
        context: 'vessels.self',
        updates: [
          {
            $source: 'defaults',
            values: fields.map((f) => identityPathValue(f, values.get(f)))
          }
        ]
      } as unknown as Partial<Delta>)
    }
    return fields
  }

  /** takes back what lendIdentity put in, where it is still what was put there */
  function returnIdentity() {
    const base = app.config?.baseDeltaEditor
    const taken: IdentityField[] = []
    for (const [field, value] of lent) {
      if (
        base &&
        JSON.stringify(base.getSelfValue(field)) === JSON.stringify(value)
      ) {
        base.removeSelfValue(field)
        taken.push(field)
      }
    }
    lent.clear()
    if (taken.length) {
      app.handleMessage(PLUGIN_ID, {
        context: 'vessels.self',
        updates: [
          {
            $source: 'defaults',
            values: taken.map((f) => identityPathValue(f, null))
          }
        ]
      } as unknown as Partial<Delta>)
    }
  }

  async function publishRoute(scenario: Scenario) {
    const route = scenario.route
    await app.resourcesApi.setResource(
      'routes',
      routeResourceId(route),
      routeResource(route) as unknown as Record<string, unknown>
    )
  }

  /**
   * Keeps the server's course on the route point the boat is heading for: activates the
   * published route at that point when it changes, and clears the course on arrival, as an
   * arrival does. Without the published route there is no course to follow, so any course
   * left from an earlier run is cleared rather than shown against this one.
   */
  function courseKeeper(scenario: Scenario, published: boolean) {
    const href = `/resources/routes/${routeResourceId(scenario.route)}`
    let current: number | undefined | null = null
    return {
      get pointIndex() {
        return current ?? undefined
      },
      async at(scenarioMs: number) {
        const index = published
          ? nextPointIndex(scenario.legs, scenarioMs)
          : undefined
        if (index === current) return
        current = index
        try {
          if (index === undefined) await app.clearDestination()
          else await app.activateRoute({ href, pointIndex: index })
        } catch (error) {
          app.error(`course: ${(error as Error).message}`)
        }
      }
    }
  }

  async function run(options: Options) {
    app.setPluginStatus(`Loading ${options.sample}`)
    const scenario = await loadScenario(samplesDir(), options.sample, {
      minDepthUnderKeelM: options.minDepthUnderKeelM,
      receiverAntennaHeightM: options.receiverAntennaHeightM
    })
    if (stopped) return
    let published = true
    try {
      await publishRoute(scenario)
    } catch (error) {
      published = false
      app.error(`could not publish the route: ${(error as Error).message}`)
    }

    const departure = scenario.legs[0].departMs
    const saved = readState()
    const scenarioStartMs =
      options.resume && saved?.sample === options.sample
        ? saved.scenarioMs
        : departure + options.startAtMinutes * 60000

    const start = (systemsState: SystemsState | undefined) =>
      new Simulation(
        scenario,
        {
          timeMultiplier: options.timeMultiplier,
          showTraffic: options.showTraffic,
          scenarioStartMs,
          seed: options.seed,
          systemsState,
          identityWithheld: [...owned, ...SERVER_KEPT_FIELDS]
        },
        (delta) => app.handleMessage(PLUGIN_ID, delta),
        Date.now()
      )
    const systemsState = savedSystems(options, scenario, saved)
    const owned = ownerFields()
    const lentFields = lendIdentity(scenario, owned)
    try {
      simulation = start(systemsState)
    } catch (error) {
      if (!(error instanceof StaleStateError)) throw error
      app.error(`systems start fresh: ${error.message}`)
      simulation = start(undefined)
    }
    const adjusted = scenario.adjustments.filter(
      (a) => a.resolved && a.added
    ).length
    const tightened = (scenario.turns ?? []).filter(
      (t) => t.clear && t.plannedRadiusM !== undefined
    ).length
    const labels = (fields: IdentityField[]) =>
      fields.map((f) => FIELD_LABELS[f]).join(', ')
    const unset = SERVER_KEPT_FIELDS.filter(
      (f) => !owned.includes(f) && !lentFields.includes(f)
    )
    const identity = [
      lentFields.length
        ? `set ${labels(lentFields)} in the server's vessel settings, until stopped`
        : '',
      simulation.identitySent.length
        ? `sent ${labels(simulation.identitySent)}`
        : '',
      owned.length ? `left the owner's ${labels(owned)}` : '',
      unset.length
        ? `could not set ${labels(unset)}: no access to the server's vessel settings`
        : ''
    ]
      .filter(Boolean)
      .join('; ')
    const notes = [
      identity,
      adjusted ? `${adjusted} legs moved for depth` : '',
      tightened ? `${tightened} turns tightened for depth` : '',
      ...scenario.notes
    ].filter(Boolean)

    // the course is set for where the boat is before its first position goes out
    const course = courseKeeper(scenario, published)
    await course.at(simulation.systems?.scenarioMs ?? scenarioStartMs)
    if (stopped) return

    let ticks = 0
    let busy = false
    // alongside after arrival the boat keeps sending, as a moored boat does
    let arrived = false
    timer = setInterval(async () => {
      if (!simulation || busy) return
      busy = true
      const now = Date.now()
      const sentMs = simulation.advance(now)
      await course.at(sentMs)
      if (!simulation) return
      const result = simulation.send(now)
      busy = false
      ticks++
      const arriving = result.finished && !arrived
      arrived = result.finished
      if (ticks % SAVE_EVERY_TICKS === 0 || arriving) {
        saveState({
          sample: options.sample,
          scenarioMs: result.scenarioMs,
          systems: simulation.systems?.save()
        })
      }
      const depth =
        result.depthM !== undefined
          ? `, depth ${result.depthM.toFixed(1)} m`
          : ''
      const traffic = options.showTraffic
        ? `, ${simulation.trafficCount} AIS targets heard`
        : ', traffic off'
      const legs = scenario.legs.length
      const next =
        course.pointIndex !== undefined
          ? `, next point ${course.pointIndex} of ${legs}`
          : ''
      const onBoard = simulation.systems?.summary()
      const systems = onBoard
        ? `, ${onBoard.enginesRunning} engines and ${onBoard.generatorsRunning} generators running`
        : ''
      app.setPluginStatus(
        `${result.finished ? 'Arrived' : 'Under way'}: ${fmtTime(result.scenarioMs)} ` +
          `at x${options.timeMultiplier}, ${result.position.sogKn.toFixed(1)} kn${next}${depth}${traffic}${systems}` +
          (notes.length ? ` (${notes.join('; ')})` : '')
      )
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
      returnIdentity()
      if (timer) clearInterval(timer)
      timer = undefined
      simulation = undefined
    }
  }
}
