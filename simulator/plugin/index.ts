import { existsSync, readFileSync, renameSync, writeFileSync } from 'fs'
import path from 'path'
import { routeResource, routeResourceId } from '../routes/resource'
import { bridgeHoldAt, bridgeWords, nextPointIndex } from '../routes/route'
import {
  DEFAULT_MIN_DEPTH_UNDER_KEEL_M,
  DEFAULT_RECEIVER_ANTENNA_HEIGHT_M,
  Scenario,
  listSamples,
  loadScenario
} from '../engine/scenario'
import { DroppedTargets } from '../engine/dropped'
import { ClaimsDelta, withoutArrivalClaims } from '../engine/claims'
import { Simulation } from '../engine/simulation'
import { FaultsState } from '../faults/faults'
import { AlarmsState } from '../alarms/panel'
import { DEFAULT_SHALLOW_M } from '../alarms/zones'
import { DEFAULT_COLLISION_LIMITS } from '../ais/collision'
import { Control, ControlError, controlRoutes } from './control'
import {
  Delta,
  IDENTITY_FIELDS,
  IdentityField,
  SERVER_KEPT_FIELDS,
  identityPathValue,
  identityValues,
  vesselIdentity
} from '../soak/deltas'
import { StaleStateError, SystemsState, SystemsSummary } from '../systems/model'
import {
  Autopilot,
  PilotError,
  PilotSaved,
  PilotUpdate
} from '../autopilot/pilot'
import { VesselProfile } from '../vessels/profile'
import {
  bankChannels,
  bankPath,
  switchList,
  switchPath,
  switchValue
} from '../switching/switches'

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
  shallowAlarmM: number
  collisionDistanceM: number
  collisionTimeMin: number
  anchorWatchRadiusM: number
  showTraffic: boolean
  receiverAntennaHeightM: number
  seed: number
  faultsPerDay: number
}

/** the systems belong to the sample here, and to the profile and seed they carry */
interface SavedState {
  sample: string
  scenarioMs: number
  systems?: SystemsState
  /** the faults on board, which belong to the systems saved with them */
  faults?: FaultsState
  /** the alarms raised, which belong to the systems saved with them */
  alarms?: AlarmsState
  /** the autopilot, which belongs to the systems saved with it */
  pilot?: PilotSaved
}

/** a delta as the server hands it to an input handler, as far as this plugin reads it */
type InputDelta = ClaimsDelta

/** the router the server gives a plugin's REST routes, as far as this plugin uses it */
type PluginRouter = Parameters<typeof controlRoutes>[0]

// The subset of the server's plugin API this plugin uses.
interface App {
  handleMessage(id: string, delta: Partial<Delta>): void
  /** the server drops the handler when the plugin stops */
  registerDeltaInputHandler(
    handler: (delta: InputDelta, next: (delta: InputDelta) => void) => void
  ): void
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
  /** the server's Autopilot API: the provider it calls, and the updates it sends on */
  registerAutopilotProvider?(provider: object, devices: string[]): void
  autopilotUpdate?(deviceId: string, apInfo: PilotUpdate): void
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
  /**
   * The server's full model and its delta cache. The server drops a vessel only after an
   * hour without data (`pruneContextsMinutes`), and the plugin API cannot drop one, so a
   * target the receiver has lost is dropped from both here, as soon as it is lost.
   */
  signalk?: { deleteContext(context: string): void }
  deltaCache?: { deleteContext(context: string): void }
  /** a PUT handler for a path, which the server marks `supportsPut` in its metadata */
  registerPutHandler?(
    context: string,
    path: string,
    handler: (
      context: string,
      path: string,
      value: unknown,
      callback: (result: ActionResult) => void
    ) => ActionResult,
    source?: string
  ): void
  /** the server's Notifications API, for the person overboard alarm */
  notifications?: {
    mob(message?: string): string
    clear(id: string): void
  }
  subscriptionmanager?: {
    subscribe(
      command: {
        context: string
        subscribe: { path: string; policy?: string }[]
      },
      unsubscribes: (() => void)[],
      errorCallback: (error: unknown) => void,
      callback: (delta: Delta) => void
    ): void
  }
}

/** a PUT handler's answer, as the server's ActionResult has it */
interface ActionResult {
  state: 'COMPLETED' | 'PENDING' | 'FAILED'
  statusCode?: number
  message?: string
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
  'sensors.ais.fromCenter': 'AIS antenna from centre',
  'sensors.ais.class': 'AIS class'
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
  shallowAlarmM: DEFAULT_SHALLOW_M,
  collisionDistanceM: DEFAULT_COLLISION_LIMITS.distanceM,
  collisionTimeMin: DEFAULT_COLLISION_LIMITS.timeS / 60,
  anchorWatchRadiusM: 0,
  showTraffic: true,
  receiverAntennaHeightM: DEFAULT_RECEIVER_ANTENNA_HEIGHT_M,
  seed: 1,
  faultsPerDay: 0
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

  /** lost targets, and the deltas from others held back for them (see DroppedTargets) */
  let dropped = new DroppedTargets()

  function holdBackDropped(
    delta: InputDelta,
    next: (delta: InputDelta) => void
  ) {
    if (dropped.holdsBack(delta.context)) return
    // lying at anchor she is not making for the next point (see claims.ts)
    next(
      simulation?.last?.position.anchored ? withoutArrivalClaims(delta) : delta
    )
  }

  function send(delta: Delta) {
    dropped.heard(delta.context)
    app.handleMessage(PLUGIN_ID, delta)
  }

  const heldBackNote = () =>
    dropped.heldBack
      ? `, ${dropped.heldBack} deltas for lost targets held back`
      : ''

  /** drops a lost target from the server, so vessels.* holds only what is heard */
  function forgetTarget(context: string) {
    dropped.forget(context)
    app.deltaCache?.deleteContext(context)
    app.signalk?.deleteContext(context)
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

  /** the run in progress, for the REST surface and the page */
  let current:
    | {
        options: Options
        scenario: Scenario
        /** a jump back starts the run again from that time, systems and faults fresh */
        restartAt(scenarioMs: number): Promise<void>
      }
    | undefined

  /** where a restarted run starts, and how its clock runs, in place of the saved run */
  interface Restart {
    scenarioMs: number
    rate: number
    paused: boolean
  }

  async function run(options: Options, restart?: Restart) {
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
    const saved = restart ? undefined : readState()
    const scenarioStartMs = restart
      ? restart.scenarioMs
      : options.resume && saved?.sample === options.sample
        ? saved.scenarioMs
        : departure + options.startAtMinutes * 60000

    const start = (systemsState: SystemsState | undefined) =>
      new Simulation(
        scenario,
        {
          timeMultiplier: restart?.rate ?? options.timeMultiplier,
          showTraffic: options.showTraffic,
          scenarioStartMs,
          seed: options.seed,
          systemsState,
          faultsPerDay: options.faultsPerDay,
          faultsState: systemsState ? saved?.faults : undefined,
          shallowM: options.shallowAlarmM,
          alarmsState: systemsState ? saved?.alarms : undefined,
          pilotState: systemsState ? saved?.pilot : undefined,
          autopilotUpdate: (u) => app.autopilotUpdate?.(PILOT_ID, u),
          mob: mobAlarm(),
          collision: {
            distanceM: options.collisionDistanceM,
            timeS: options.collisionTimeMin * 60
          },
          anchorWatchRadiusM: options.anchorWatchRadiusM,
          identityWithheld: [...owned, ...SERVER_KEPT_FIELDS],
          forget: forgetTarget
        },
        send,
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
    if (restart?.paused) simulation.retime(Date.now(), { paused: true })
    for (const [key, value] of heardMobs) simulation.heardMob(key, value)
    if (scenario.profile) registerSwitches(scenario.profile)
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
    await course.at(
      simulation.routeMs(simulation.systems?.scenarioMs ?? scenarioStartMs)
    )
    if (simulation.pilot) {
      registerPilot()
      simulation.pilot.announce()
    }
    if (stopped) return

    let ticks = 0
    let busy = false
    // alongside after arrival the boat keeps sending, as a moored boat does
    let arrived = false
    const save = (scenarioMs: number) =>
      saveState({
        sample: options.sample,
        scenarioMs,
        systems: simulation?.systems?.save(),
        faults: simulation?.faults?.save(),
        alarms: simulation?.alarms?.save(),
        pilot: simulation?.pilot?.save()
      })
    current = {
      options,
      scenario,
      async restartAt(scenarioMs: number) {
        const from = simulation!
        stopRun()
        await run(options, {
          scenarioMs,
          rate: from.timeMultiplier,
          paused: from.isPaused
        })
      }
    }
    timer = setInterval(async () => {
      if (!simulation || busy) return
      busy = true
      const now = Date.now()
      const sentMs = simulation.advance(now)
      await course.at(simulation.routeMs(sentMs))
      if (!simulation) return
      const result = simulation.send(now)
      busy = false
      ticks++
      const arriving = result.finished && !arrived
      arrived = result.finished
      if (ticks % SAVE_EVERY_TICKS === 0 || arriving) save(result.scenarioMs)
      const depth =
        result.depthM !== undefined
          ? `, depth ${result.depthM.toFixed(1)} m`
          : ''
      const traffic = options.showTraffic
        ? `, ${simulation.trafficCount} AIS targets in range${heldBackNote()}`
        : ', traffic off'
      const legs = scenario.legs.length
      const hold = scenario.profile
        ? bridgeHoldAt(
            scenario.plannedRoute,
            scenario.legs,
            simulation.routeMs(result.scenarioMs),
            scenario.profile.airHeightM
          )
        : undefined
      const next =
        (course.pointIndex !== undefined
          ? `, next point ${course.pointIndex} of ${legs}`
          : '') + (hold ? `, ${bridgeWords(hold)}` : '')
      const onBoard = simulation.systems?.summary()
      const systems = onBoard
        ? `, ${onBoard.enginesRunning} engines and ${onBoard.generatorsRunning} generators running`
        : ''
      const w = onBoard?.weather
      const weather = w
        ? `, wind ${w.windKn.toFixed(0)} kn from ${w.windDeg.toFixed(0)}°, ${(w.pressurePa / 100).toFixed(0)} hPa, air ${w.airC.toFixed(1)} °C, water ${w.waterC.toFixed(1)} °C` +
          (w.tideM === undefined ? '' : `, tide ${w.tideM.toFixed(2)} m`)
        : ''
      const faults = simulation.faults?.active() ?? []
      const faulty = faults.length
        ? `, faults: ${faults.map((f) => f.id).join(', ')}`
        : ''
      const alarms = [
        ...(simulation.alarms?.active() ?? []),
        ...simulation.collisions.active().map((c) => c.value)
      ]
      const anchor = simulation.systems?.anchor
      const anchored = anchor
        ? `, at anchor on ${onBoard?.deck.chainM.toFixed(0)} m of chain in ${anchor.depthM.toFixed(1)} m, ${anchor.currentRadiusM.toFixed(0)} m from it, swinging in ${anchor.maxRadiusM.toFixed(0)} m, watch ${anchor.watchRadiusM.toFixed(0)} m`
        : ''
      const pilot = simulation.pilot
      const piloted = pilot ? pilotWords(pilot) : ''
      const water = onBoard
        ? waterWords(onBoard, !result.finished && !result.position.anchored)
        : ''
      const lights =
        onBoard?.deck.night && onBoard.deck.lights !== 'off'
          ? `, lights: ${onBoard.deck.lights}`
          : ''
      const overboard = simulation
        .mobs()
        .map((m) => (m.words ? `, ${m.words}` : ''))
        .join('')
      const alarmed = alarms.length
        ? `, alarms: ${alarms.map((a) => `${a.message} (${a.state})`).join(', ')}`
        : ''
      const state = simulation.isPaused
        ? 'Paused'
        : result.finished
          ? 'Arrived'
          : result.position.anchored
            ? 'At anchor'
            : 'Under way'
      app.setPluginStatus(
        `${state}: ${fmtTime(result.scenarioMs)} ` +
          `at x${simulation.timeMultiplier}, ${result.position.sogKn.toFixed(1)} kn${overboard}${water}${lights}${piloted}${next}${anchored}${depth}${weather}${traffic}${systems}${faulty}${alarmed}` +
          (notes.length ? ` (${notes.join('; ')})` : '')
      )
    }, TICK_MS)
  }

  /** stops the clock and lets go of the targets, leaving the server's vessel settings */
  function stopRun() {
    if (timer) clearInterval(timer)
    timer = undefined
    simulation?.forgetAll()
    simulation = undefined
  }

  /**
   * The run's autopilot to the server's Autopilot API, as one device, `simulator`. The API
   * reports a provider's error with its `statusCode` and `message`.
   */
  let pilotRegistered = false
  function registerPilot() {
    if (pilotRegistered || !app.registerAutopilotProvider) return
    const pilot = (): Autopilot => {
      const p = simulation?.pilot
      if (!p)
        throw refused('this boat has no autopilot, or the run has not started')
      return p
    }
    const act = async <T>(fn: (p: Autopilot) => T): Promise<T> => {
      try {
        return fn(pilot())
      } catch (error) {
        throw error instanceof PilotError ? refused(error.message) : error
      }
    }
    const provider = {
      getData: () => act((p) => p.data()),
      getState: () => act((p) => p.state),
      setState: (state: string) => act((p) => p.setState(state)),
      getMode: () => act((p) => p.mode),
      setMode: (mode: string) => act((p) => p.setMode(mode)),
      getTarget: () => act((p) => p.target),
      setTarget: (value: number) => act((p) => p.setTarget(value)),
      adjustTarget: (value: number) => act((p) => p.adjustTarget(value)),
      engage: () => act((p) => p.engage()),
      disengage: () => act((p) => p.disengage()),
      courseCurrentPoint: () => act((p) => p.courseCurrentPoint()),
      courseNextPoint: () => act((p) => p.courseNextPoint()),
      tack: (direction: 'port' | 'starboard') => act((p) => p.tack(direction)),
      gybe: (direction: 'port' | 'starboard') => act((p) => p.gybe(direction)),
      dodge: (value: number | null) => act((p) => p.dodge(value))
    }
    try {
      app.registerAutopilotProvider(provider, [PILOT_ID])
      pilotRegistered = true
    } catch (error) {
      app.error(`autopilot: ${(error as Error).message}`)
    }
  }

  /**
   * A PUT handler for every switch the boat sends, by its name and on its switch bank
   * channel, as KIP and the NMEA 2000 switch displays PUT to them. A handler stays with
   * the server until the plugin stops, so one for a switch this boat lacks says so.
   */
  const putPaths = new Set<string>()
  function registerSwitches(profile: VesselProfile) {
    if (!app.registerPutHandler) return
    const channels = bankChannels(profile)
    for (const s of switchList(profile)) {
      const channel = channels.get(s.id)
      const paths = [switchPath(s.id)]
      if (channel !== undefined) paths.push(bankPath(channel))
      for (const p of paths) {
        if (putPaths.has(p)) continue
        putPaths.add(p)
        app.registerPutHandler(
          'vessels.self',
          p,
          (_context, putPath, value) => throwSwitch(putPath, value),
          PLUGIN_ID
        )
      }
    }
  }

  /** a PUT to a switch, by its own path or its bank channel's */
  function throwSwitch(putPath: string, value: unknown): ActionResult {
    const refuse = (message: string): ActionResult => ({
      state: 'COMPLETED',
      statusCode: 400,
      message
    })
    const systems = simulation?.systems
    if (!systems) return refuse('the run has not started')
    const profile = systems.profile
    const channels = bankChannels(profile)
    const id = switchList(profile).find(
      (s) =>
        switchPath(s.id) === putPath ||
        (channels.has(s.id) && bankPath(channels.get(s.id)!) === putPath)
    )?.id
    if (!id) return refuse(`this boat has no switch at ${putPath}`)
    const on = switchValue(value)
    if (on === undefined)
      return refuse('a switch takes 1 or 0, true or false, "on" or "off"')
    const answer = systems.putSwitch(id, on)
    return answer.ok
      ? { state: 'COMPLETED', statusCode: 200, message: answer.message }
      : refuse(answer.message)
  }

  /**
   * The person overboard alarm through the server's Notifications API: raised at
   * emergency on `notifications.mob.<id>`, and resolved as the person is recovered. With
   * the server's notification management off it cannot clear one, so the plugin sends the
   * notification back to normal itself.
   */
  const mobAlarm = () => {
    const api = app.notifications
    if (!api) return undefined
    return {
      raise: (message: string) => api.mob(message),
      resolve: (id: string) => {
        try {
          api.clear(id)
        } catch {
          app.handleMessage(PLUGIN_ID, {
            context: 'vessels.self',
            updates: [
              {
                values: [
                  {
                    path: `notifications.mob.${id}`,
                    value: {
                      state: 'normal',
                      method: [],
                      message: 'Person recovered'
                    }
                  }
                ]
              }
            ]
          } as unknown as Partial<Delta>)
        }
      }
    }
  }

  /** MOB alarms on the server from anyone, by notification id, as last heard */
  const heardMobs = new Map<string, unknown>()
  let unsubscribes: (() => void)[] = []
  function listenForMob() {
    app.subscriptionmanager?.subscribe(
      {
        context: 'vessels.self',
        subscribe: [
          { path: 'notifications.mob', policy: 'instant' },
          { path: 'notifications.mob.*', policy: 'instant' }
        ]
      },
      unsubscribes,
      (error) => app.error(`MOB subscription: ${String(error)}`),
      (delta) => {
        for (const update of delta.updates ?? []) {
          for (const v of update.values ?? []) {
            if (!v.path.startsWith('notifications.mob')) continue
            const key = v.path.replace(/^notifications\.mob\.?/, '') || v.path
            heardMobs.set(key, v.value)
            simulation?.heardMob(key, v.value)
          }
        }
      }
    )
  }

  /** what the REST surface and the page can read and do */
  const control: Control = {
    run() {
      if (!current || !simulation) throw new ControlError(503, 'not running')
      return { ...current, simulation }
    },
    async setRun(change) {
      const { simulation: sim, scenario } = control.run()
      const now = Date.now()
      if (change.paused !== undefined || change.timeMultiplier !== undefined) {
        sim.retime(now, {
          paused: change.paused,
          rate: change.timeMultiplier
        })
      }
      if (change.scenarioMs === undefined) return
      const legs = scenario.legs
      const from = legs[0].departMs
      const to = legs[legs.length - 1].arriveMs
      if (change.scenarioMs < from || change.scenarioMs > to) {
        throw new ControlError(
          400,
          `the route runs from ${new Date(from).toISOString()} to ${new Date(to).toISOString()}`
        )
      }
      const reached = sim.systems?.scenarioMs ?? sim.last?.scenarioMs
      if (reached !== undefined && change.scenarioMs >= reached) {
        sim.jump(now, change.scenarioMs)
      } else {
        await current?.restartAt(change.scenarioMs)
      }
    },
    faults() {
      const faults = control.run().simulation.faults
      if (!faults) throw new ControlError(409, 'this run has no boat systems')
      return faults
    }
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
          shallowAlarmM: {
            type: 'number',
            title: 'Shallow water alarm (m under the keel)',
            description:
              "The depth sounder's shallow alarm: raised below this depth under the keel, cleared 0.3 m deeper",
            minimum: 0,
            default: DEFAULTS.shallowAlarmM
          },
          collisionDistanceM: {
            type: 'number',
            title: 'Collision alarm: closest approach (m)',
            description:
              'A moving target whose closest approach comes inside this, within the time below, raises a warning, and an alarm within half that time',
            minimum: 0,
            default: DEFAULTS.collisionDistanceM
          },
          collisionTimeMin: {
            type: 'number',
            title: 'Collision alarm: time to closest approach (min)',
            minimum: 0,
            default: DEFAULTS.collisionTimeMin
          },
          anchorWatchRadiusM: {
            type: 'number',
            title: 'Anchor watch radius (m)',
            description:
              'The anchor alarm is raised once the boat is further than this from her anchor, and cleared 5 m inside it; 0 for the radius her scope gives plus 10 m',
            minimum: 0,
            default: DEFAULTS.anchorWatchRadiusM
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
          faultsPerDay: {
            type: 'number',
            title: 'Faults a day',
            description:
              'Faults the seed throws on its own, on average, per day of scenario time; 0 for none. Faults can always be raised by hand.',
            minimum: 0,
            default: DEFAULTS.faultsPerDay
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
      dropped = new DroppedTargets()
      app.registerDeltaInputHandler(holdBackDropped)
      listenForMob()
      const options = { ...DEFAULTS, ...settings }
      run(options).catch((error: Error) => {
        app.setPluginError(error.message)
      })
    },

    registerWithRouter(router: PluginRouter) {
      controlRoutes(router, control)
    },

    stop() {
      stopped = true
      pilotRegistered = false
      putPaths.clear()
      for (const unsubscribe of unsubscribes) unsubscribe()
      unsubscribes = []
      heardMobs.clear()
      returnIdentity()
      stopRun()
      current = undefined
      // the server sets the status to a bare "Stopped" after this, so the count goes to the log
      console.log(
        `${PLUGIN_ID}: stopped, ${dropped.heldBack} deltas for lost targets held back`
      )
    }
  }
}

/** the device the run's autopilot is to the server's Autopilot API */
const PILOT_ID = 'simulator'

/** an error the Autopilot API answers with a 400 and its message */
function refused(
  message: string
): Error & { statusCode: number; state: string } {
  return Object.assign(new Error(message), { statusCode: 400, state: 'FAILED' })
}

/**
 * What the status line says of the water: under sail or motor-sailing and with which sails
 * on a sailing boat, her speed through the water under way, and the current
 */
function waterWords(s: SystemsSummary, underWay: boolean): string {
  const w = s.water
  const current = `, current ${w.currentKn.toFixed(1)} kn setting ${String(Math.round(w.currentToDeg) % 360).padStart(3, '0')}°`
  if (!underWay) return current
  const sails = s.sails
  const set = sails?.set.map((x) => x.name.toLowerCase()) ?? []
  const named = set.length
    ? `, ${set.length > 1 ? set.slice(0, -1).join(', ') + ' and ' + set[set.length - 1] : set[0]}`
    : ''
  const how =
    sails?.propulsion === 'sailing'
      ? `, under sail${named}`
      : sails?.propulsion === 'motor-sailing'
        ? `, motor-sailing${named}`
        : sails?.propulsion === 'motoring'
          ? ', motoring'
          : ''
  return `${how}, ${w.stwKn.toFixed(1)} kn through the water${current}`
}

/** what the status line says of the pilot */
function pilotWords(p: Autopilot): string {
  const deg = (x: number) =>
    String(Math.round(((x % 360) + 360) % 360)).padStart(3, '0')
  const held = p.heldTargetDeg
  let words = ''
  if (p.engaged) {
    words =
      p.mode === 'route'
        ? ', on autopilot, route'
        : p.mode === 'compass'
          ? `, on autopilot, holding ${deg(held.headingDeg!)}°`
          : p.mode === 'wind'
            ? `, on autopilot, wind ${Math.abs(Math.round(held.awaDeg!))}° ${held.awaDeg! < 0 ? 'to port' : 'to starboard'}`
            : `, on autopilot, dodging ${Math.abs(Math.round(held.rudderDeg!))}° ${held.rudderDeg! < 0 ? 'to port' : 'to starboard'}`
  }
  const rejoin = p.rejoin
  if (rejoin)
    words += `, rejoining the route ${(rejoin.distanceM / 1852).toFixed(2)} nm ahead`
  else if (!p.onRoute) words += ', off the route'
  return words
}
