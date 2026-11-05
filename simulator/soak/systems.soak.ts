/**
 * The systems soak: every vessel profile run for days of scenario time on the
 * controllable clock, checking that what the boat sends stays believable. It is not part
 * of `npm test`; run it with `npm run test:simulator-soak`. See README.md.
 */
import { expect } from 'chai'
import path from 'path'
import { DepthModel } from '../depth/depth'
import { Simulation } from '../engine/simulation'
import {
  DEFAULT_MIN_DEPTH_UNDER_KEEL_M,
  DEFAULT_RECEIVER_ANTENNA_HEIGHT_M,
  Scenario,
  listSamples,
  loadScenario
} from '../engine/scenario'
import {
  DEAD_SLOW_KN,
  countWords,
  resourceCounts,
  sampleResources
} from '../routes/resources'
import {
  Route,
  Waypoint,
  berthApproachM,
  loadRoute,
  positionAt,
  routeLegs
} from '../routes/route'
import { VariationGrid, loadVariation } from '../systems/magnetic'
import { Environment, loadEnvironment } from '../weather/environment'
import { PilotUpdate } from '../autopilot/pilot'
import {
  EnergyBooks,
  STEP_S,
  SystemsState,
  SystemsSummary
} from '../systems/model'
import { solarHour, sunElevation } from '../systems/sun'
import { VesselProfile, listProfiles, loadProfile } from '../vessels/profile'
import { Delta, forSchema } from './deltas'
import { NotificationValue } from '../alarms/panel'
import { AlarmBand } from '../alarms/zones'
import { FaultError } from '../faults/faults'
import { SCOPE } from '../systems/anchor'
import {
  bankChannels,
  bankPath,
  switchList,
  switchPath
} from '../switching/switches'
import { hasInverter } from '../switching/inverters'
import { NotificationManager } from '../../src/api/notifications/notificationManager'
import type { NotificationApplication } from '../../src/api/notifications'
import {
  OWN_CONTEXT,
  RECORD_ROWS,
  RECORD_STEP_MS,
  RunRecord,
  recordBoundBytes
} from '../history/record'
import { RecordHistory } from '../history/provider'
import { STRONG_WIND_KN, SampleWeather } from '../weather/provider'

// The server pins signalk-schema 1.0; free names under environment.inside need 1.1 or
// later, so the deltas are validated against the newer copy the streams package uses.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const schema = require(
  require.resolve('@signalk/signalk-schema', {
    paths: [path.join(__dirname, '..', '..', 'packages', 'streams')]
  })
)

const SIMULATOR = path.join(__dirname, '..')
const SAMPLES = path.join(SIMULATOR, 'samples')
/** metres in a degree of latitude, on the sphere the route legs are measured on */
const METRES_PER_DEG = (6371000 * Math.PI) / 180
/** a resource's place */
type Point = { lat: number; lon: number }
const VESSELS = path.join(SIMULATOR, 'vessels')
const HOUR_MS = 3600000
const DAY_MS = 24 * HOUR_MS
/** scenario seconds per tick: each tick is one real second at a multiplier of 60 */
const TIME_MULTIPLIER = 60
const TICK_MS = 1000
const SEED = 1
/** the context a delta is validated under: the boat's own MMSI, as the server would hold it */
const FALLBACK_MMSI = '230099999'
const KELVIN = 273.15
const KNOT_MS = 1852 / 3600
const RAD = Math.PI / 180

interface SoakCase {
  name: string
  profile: VesselProfile
  route: Route
  startMs: number
  hours: number
  /** the sample's magnetic variation, which the day out from its berth shares */
  variation?: VariationGrid
  /** the sample's weather and water level, which the day out from its berth shares too */
  environment?: Environment
  /** the sample it sails in */
  sample: string
  /** a passage is sailed on the autopilot in route mode; a day out by the helm */
  pilot: 'route' | 'standby'
}

interface Tick {
  ms: number
  lat: number
  lon: number
  sogKn: number
  sunDeg: number
  hour: number
  atBerth: boolean
  summary: SystemsSummary
  values: Map<string, unknown>
  main?: Set<string>
  slow: boolean
  /** the navigation lights have failed */
  lightsFault: boolean
}

interface CaseResult {
  soak: SoakCase
  ticks: Tick[]
  deltas: number
  invalid: string[]
  books: EnergyBooks
  /** the fuel rates sent, integrated over the run, litres */
  sentFuelL: number
  /** every notification sent, with the value of its path as last sent before it */
  notes: Note[]
  bands: Map<string, AlarmBand>
  /** the anchor dragged at some point in the run, the only cause of an anchor alarm */
  dragged: boolean
  /** what the autopilot sent the Autopilot API, and the ticks under way it was engaged in */
  pilotUpdates: { ms: number; u: PilotUpdate }[]
  underWayTicks: number
  engagedTicks: number
  /** the sun's elevation, degrees, at each try at failing the lights, and whether it took */
  lightsTries: { sunDeg: number; raised: boolean }[]
  /** the metadata sent as the run started, by path */
  meta: Map<string, { displayName?: string }>
  /** the systems saved halfway, to carry on from as a restart would */
  half: { ms: number; systems: SystemsState }
  /** PUTs the boat must refuse, tried each tick: how many, and any she took */
  refusals: { tried: number; taken: string[] }
  /** what the boat sent, as the plugin records it for the History API */
  record: RunRecord
  /** the record saved halfway, as a stop would save it */
  recordHalf: Buffer
}

interface Note {
  ms: number
  path: string
  value: NotificationValue
  watched: unknown
}

/**
 * The alarms a day on board may raise on its own, with no fault: a tank running low or a
 * holding tank filling, a bank run down, shallow water. An engine overheating, a voltage
 * out of its band, a gale or a warm fridge would each be the model going wrong.
 */
const DAY_ALARMS = [
  /^tanks\.\w+\.\w+\.currentLevel$/,
  /^electrical\.batteries\.\w+\.capacity\.stateOfCharge$/,
  /^environment\.depth\.belowKeel$/
]
const SEVERE = new Set(['warn', 'alarm', 'alert', 'emergency'])
/** the anchor watch's notification, raised by the watch rather than from a zone */
const ANCHOR_ALARM = 'navigation.anchor'
/** the lights failure the soak raises itself, once it is dark */
const LIGHTS_ALARM = 'navigation.lights'
/** the sun's upper limb at the horizon, degrees; the lights follow it to within this */
const SUNSET_DEG = -0.833
const SUNSET_MARGIN_DEG = 0.25
/** five times a depth sent to the centimetre, and the chain sent to the centimetre */
const CHAIN_ROUNDING_M = 0.05

/** where each profile not named by a sample spends its day */
const DAY_AT: Record<string, string> = {
  'motor-yacht-45m': 'miami-icw-2024-03-16',
  'motor-yacht-34m': 'miami-icw-2024-03-16',
  'motor-yacht-20m': 'miami-icw-2024-03-16',
  'hybrid-catamaran-60ft': 'miami-icw-2024-03-16',
  'boat-4m': 'miami-icw-2024-03-16',
  'sailing-yacht-15m': 'saronic-gulf-2018-07-13',
  'sailing-yacht-9m': 'saronic-gulf-2018-07-13',
  'yacht-12m': 'saronic-gulf-2018-07-13',
  'electric-launch-7m': 'manly-hamilton-island-2026-08-21'
}
/** a sample route sailed by another profile than its own, and for how long */
const OTHER_PASSAGES: {
  sample: string
  profile: string
  hours: number
  leadHours: number
}[] = [
  {
    sample: 'manly-hamilton-island-2026-08-21',
    profile: 'hybrid-catamaran-60ft',
    hours: 72,
    leadHours: 2
  }
]
/** diesel's lower heating value, kWh a litre */
const DIESEL_KWH_PER_L = 9.94
/** the best a marine diesel generator turns its fuel into electricity */
const GENERATOR_MAX_EFFICIENCY = 0.38
/** the books must balance to this share of the energy through each bank */
const BOOKS_TOLERANCE = 0.01

/** sample routes sailed as they are, and for how long */
const PASSAGES: Record<string, { hours: number; leadHours: number }> = {
  'miami-icw-2024-03-16': { hours: 24, leadHours: 4 },
  'saronic-gulf-2018-07-13': { hours: 24, leadHours: 2 },
  'manly-hamilton-island-2026-08-21': { hours: 72, leadHours: 2 }
}

/** a point `distanceNm` from a start along a bearing, on a sphere */
function destination(
  lat: number,
  lon: number,
  bearingDeg: number,
  distanceNm: number
): { lat: number; lon: number } {
  const r = Math.PI / 180
  const d = distanceNm / 3440.065
  const lat2 = Math.asin(
    Math.sin(lat * r) * Math.cos(d) +
      Math.cos(lat * r) * Math.sin(d) * Math.cos(bearingDeg * r)
  )
  const lon2 =
    lon * r +
    Math.atan2(
      Math.sin(bearingDeg * r) * Math.sin(d) * Math.cos(lat * r),
      Math.cos(d) - Math.sin(lat * r) * Math.sin(lat2)
    )
  return { lat: lat2 / r, lon: lon2 / r }
}

function localMidnightMs(ms: number, lon: number): number {
  const offset = (lon / 15) * HOUR_MS
  return Math.floor((ms + offset) / DAY_MS) * DAY_MS - offset
}

/**
 * A day out from the sample's own berth, by local solar time: the night at anchor, out
 * at 07:30, cruising, a lunch stop at anchor, cruising back, alongside from 18:00.
 */
function dayOut(profile: VesselProfile, sampleRoute: Route): SoakCase['route'] {
  const berth = sampleRoute.waypoints[0]
  const slow = Math.max(2, 0.25 * profile.maxSpeedKn)
  const cruise = 0.6 * profile.maxSpeedKn
  const start = Date.parse(sampleRoute.departure)
  const midnight = localMidnightMs(start, berth.lon)
  const legs: [number, number, number][] = [
    // bearing, speed, hours
    [90, slow, 0.5],
    [90, cruise, 3.5],
    [270, cruise, 3],
    [270, slow, 0.5]
  ]
  const holds = [7.5 * 3600, 0, 3 * 3600, 0]
  const waypoints: Waypoint[] = []
  let at = { lat: berth.lat, lon: berth.lon }
  legs.forEach(([bearing, speedKn, hours], i) => {
    waypoints.push({
      name: `day ${i}`,
      ...at,
      speedKn,
      holdS: holds[i] || undefined,
      anchor: i === 0 || i === 2 ? true : undefined
    })
    at = destination(at.lat, at.lon, bearing, speedKn * hours)
  })
  waypoints.push({ name: 'berth', ...at })
  return {
    name: `${profile.id} day out`,
    departure: new Date(midnight).toISOString(),
    vessel: {
      description: profile.name,
      name: sampleRoute.vessel.name,
      mmsi: sampleRoute.vessel.mmsi,
      lengthM: profile.lengthM,
      draftM: profile.draftM,
      typeCode: profile.typeCode,
      profile: profile.id
    },
    source: 'systems soak',
    waypoints
  }
}

/** a seabed that rises and falls, so the sounders have something to read */
const SEABED = new DepthModel([
  {
    resolutionM: 30,
    elevation: (lat, lon) =>
      -(12 + 8 * Math.sin(lat * 300) * Math.cos(lon * 300))
  }
])

async function cases(): Promise<SoakCase[]> {
  const profiles = listProfiles(VESSELS).map((id) => loadProfile(id, VESSELS))
  const out: SoakCase[] = []
  for (const profile of profiles) {
    const sample = DAY_AT[profile.id]
    if (!sample) continue
    const route = dayOut(profile, await loadRoute(path.join(SAMPLES, sample)))
    out.push({
      name: route.name,
      profile,
      route,
      startMs: Date.parse(route.departure),
      hours: 24,
      variation: loadVariation(path.join(SAMPLES, sample)),
      environment: loadEnvironment(path.join(SAMPLES, sample)),
      sample,
      pilot: 'standby'
    })
  }
  for (const [sample, { hours, leadHours }] of Object.entries(PASSAGES)) {
    const route = await loadRoute(path.join(SAMPLES, sample))
    const profile = profiles.find((p) => p.id === route.vessel.profile)!
    out.push({
      name: `${profile.id} on ${sample}`,
      profile,
      route,
      startMs: Date.parse(route.departure) - leadHours * HOUR_MS,
      hours,
      variation: loadVariation(path.join(SAMPLES, sample)),
      environment: loadEnvironment(path.join(SAMPLES, sample)),
      sample,
      pilot: 'route'
    })
  }
  for (const other of OTHER_PASSAGES) {
    const sampleRoute = await loadRoute(path.join(SAMPLES, other.sample))
    const profile = profiles.find((p) => p.id === other.profile)!
    const route: Route = {
      ...sampleRoute,
      vessel: {
        description: profile.name,
        name: sampleRoute.vessel.name,
        mmsi: sampleRoute.vessel.mmsi,
        lengthM: profile.lengthM,
        draftM: profile.draftM,
        typeCode: profile.typeCode,
        profile: profile.id
      }
    }
    out.push({
      name: `${profile.id} on ${other.sample}`,
      profile,
      route,
      startMs: Date.parse(route.departure) - other.leadHours * HOUR_MS,
      hours: other.hours,
      variation: loadVariation(path.join(SAMPLES, other.sample)),
      environment: loadEnvironment(path.join(SAMPLES, other.sample)),
      sample: other.sample,
      pilot: 'route'
    })
  }
  return out
}

function validationProblems(delta: Delta, mmsi: string): string[] {
  const d = { ...forSchema(delta), context: `vessels.urn:mrn:imo:mmsi:${mmsi}` }
  const problems: string[] = []
  if (!schema.validateDelta(d).valid) problems.push('delta envelope')
  const full = schema.validateFull(schema.deltaToFull(d))
  if (!full.valid) {
    problems.push(
      (full.errors ?? [])
        .map(
          (e: { dataPath: string; message: string }) =>
            `${e.dataPath} ${e.message}`
        )
        .filter((m: string) => !/url|uuid|aircraft|aton|sar\b/i.test(m))
        .join('; ') || 'full model'
    )
  }
  return problems
}

/** the case's scenario as the soak runs it */
function scenarioOf(soak: SoakCase): Scenario {
  return {
    sampleId: soak.name,
    route: soak.route,
    plannedRoute: soak.route,
    legs: routeLegs(soak.route),
    adjustments: [],
    depth: SEABED,
    variation: soak.variation,
    environment: soak.environment,
    profile: soak.profile,
    notes: []
  }
}

/**
 * A short run of the case from a scenario time, a tick a minute, doing `act` before each
 * tick; gives each tick's values and the deltas sent
 */
function shortRun(
  soak: SoakCase,
  fromMs: number,
  minutes: number,
  options: Partial<ConstructorParameters<typeof Simulation>[1]> = {},
  act: (sim: Simulation, minute: number) => void = () => undefined
): { sim: Simulation; ticks: Map<string, unknown>[]; sent: Delta[] } {
  const sent: Delta[] = []
  const sim = new Simulation(
    scenarioOf(soak),
    {
      timeMultiplier: TIME_MULTIPLIER,
      showTraffic: false,
      scenarioStartMs: fromMs,
      seed: SEED,
      ...options
    },
    (d) => sent.push(d),
    0
  )
  const ticks: Map<string, unknown>[] = []
  for (let i = 1; i <= minutes; i++) {
    act(sim, i)
    const from = sent.length
    sim.tick(i * TICK_MS)
    const values = new Map<string, unknown>()
    for (const d of sent.slice(from))
      for (const u of d.updates)
        for (const v of u.values) values.set(v.path, v.value)
    ticks.push(values)
  }
  return { sim, ticks, sent }
}

function run(soak: SoakCase): CaseResult {
  const scenario = scenarioOf(soak)
  const legs = scenario.legs
  const ticks: Tick[] = []
  const invalid: string[] = []
  let deltas = 0
  let pending: Delta[] = []
  const sim = new Simulation(
    scenario,
    {
      timeMultiplier: TIME_MULTIPLIER,
      showTraffic: false,
      scenarioStartMs: soak.startMs,
      seed: SEED,
      autopilotUpdate: (u) =>
        pilotUpdates.push({ ms: sim.systems!.scenarioMs, u })
    },
    (d) => pending.push(d),
    0
  )
  const tickCount = (soak.hours * HOUR_MS) / (TICK_MS * TIME_MULTIPLIER)
  const notes: Note[] = []
  let dragged = false
  const pilotUpdates: { ms: number; u: PilotUpdate }[] = []
  let underWayTicks = 0
  let engagedTicks = 0
  const lightsTries: CaseResult['lightsTries'] = []
  const meta: CaseResult['meta'] = new Map()
  for (const d of pending)
    for (const u of d.updates)
      for (const m of u.meta ?? []) meta.set(m.path, m.value)
  let half: CaseResult['half'] | undefined
  const refusals: CaseResult['refusals'] = { tried: 0, taken: [] }
  const radarIds = soak.profile.radars.map((r) => r.id)
  const latest = new Map<string, unknown>()
  const record = new RunRecord()
  let recordHalf: Buffer | undefined
  for (const d of pending) record.add(d, soak.startMs)
  const check = (batch: Delta[]) => {
    for (const d of batch) {
      deltas++
      for (const problem of validationProblems(
        d,
        soak.route.vessel.mmsi ?? FALLBACK_MMSI
      )) {
        if (invalid.length < 10) invalid.push(problem)
      }
    }
  }
  check(pending)
  pending = []
  for (let i = 1; i <= tickCount; i++) {
    const result = sim.tick(i * TICK_MS)
    for (const d of pending) record.add(d, result.scenarioMs)
    const pilot = sim.pilot
    if (pilot && soak.pilot === 'route') {
      // back on the pilot whenever she is under way and it stands by
      if (!pilot.engaged && !pilot.refusal()) pilot.setState('auto')
      const underWay = !pilot.refusal()
      if (underWay) underWayTicks++
      if (underWay && pilot.engaged && pilot.mode === 'route') engagedTicks++
    }
    check(pending)
    const values = new Map<string, unknown>()
    let main: Set<string> | undefined
    for (const d of pending) {
      for (const u of d.updates) {
        for (const v of u.values) {
          if (v.path.startsWith('notifications.')) {
            const path = v.path.slice('notifications.'.length)
            notes.push({
              ms: result.scenarioMs,
              path,
              value: v.value as NotificationValue,
              watched: latest.get(path)
            })
            continue
          }
          latest.set(v.path, v.value)
          const key = u.source.src ? `${u.source.src}:${v.path}` : v.path
          values.set(key, v.value)
        }
        if (u.values.some((v) => v.path === 'navigation.speedThroughWater')) {
          main = new Set(u.values.map((v) => v.path))
        }
      }
    }
    pending = []
    // a windlass under way and a radar alongside are refused, and refusing changes nothing
    const navState = latest.get('navigation.state')
    const refuse = (id: string) => {
      refusals.tried++
      const answer = sim.systems!.putSwitch(id, true)
      if (answer.ok)
        refusals.taken.push(
          `${id} at ${new Date(result.scenarioMs).toISOString()}`
        )
    }
    if (
      soak.profile.windlass &&
      (navState === 'motoring' || navState === 'sailing')
    )
      refuse('windlass')
    if (navState === 'moored') for (const id of radarIds) refuse(id)
    if (i === Math.round(tickCount / 2)) {
      half = { ms: result.scenarioMs, systems: sim.systems!.save() }
      recordHalf = record.save({ sample: soak.sample })
    }
    if (sim.faults!.active().some((f) => f.kind === 'anchorDragging'))
      dragged = true
    const p = result.position
    const sunDeg =
      (sunElevation(result.scenarioMs, p.lat, p.lon) * 180) / Math.PI
    // the fault as it stood through the tick, before the soak tries to raise it
    const lightsFault = sim
      .faults!.active()
      .some((f) => f.kind === 'navLightsFailure')
    // the lights fail once, at the first try the faults will take: from dusk only
    if (!lightsTries.some((x) => x.raised)) {
      let raised = true
      try {
        sim.faults!.raise('navLightsFailure')
      } catch (error) {
        if (!(error instanceof FaultError)) throw error
        raised = false
      }
      lightsTries.push({ sunDeg, raised })
    }
    ticks.push({
      ms: result.scenarioMs,
      lat: p.lat,
      lon: p.lon,
      sogKn: p.sogKn,
      sunDeg,
      hour: solarHour(result.scenarioMs, p.lon),
      atBerth:
        !p.anchored && (p.finished || result.scenarioMs < legs[0].departMs),
      summary: sim.systems!.summary(),
      values,
      main,
      slow: main?.has('environment.outside.temperature') ?? false,
      lightsFault
    })
  }
  // each fuel rate sent holds until the next tick, as a gauge integrating it would hold it
  let sentFuelL = 0
  for (let i = 1; i < ticks.length; i++) {
    const dtS = (ticks[i].ms - ticks[i - 1].ms) / 1000
    for (const [key, value] of ticks[i].values) {
      if (key.endsWith('.fuel.rate') && typeof value === 'number')
        sentFuelL += value * dtS * 1000
    }
  }
  return {
    soak,
    ticks,
    deltas,
    invalid,
    books: sim.systems!.books(),
    sentFuelL,
    notes,
    bands: sim.alarms!.bands,
    dragged,
    pilotUpdates,
    underWayTicks,
    engagedTicks,
    lightsTries,
    meta,
    half: half!,
    refusals,
    record,
    recordHalf: recordHalf!
  }
}

/** the start of the record's row a scenario time falls in */
const slotOf = (ms: number) => Math.floor(ms / RECORD_STEP_MS) * RECORD_STEP_MS

/** the History API over a case's record, the scenario time at its end */
function historyOf(r: CaseResult): RecordHistory {
  return new RecordHistory(() => r.record, {
    selfContext: OWN_CONTEXT,
    nowMs: () => r.ticks.at(-1)!.ms,
    unitsOf: () => undefined
  })
}

/** the paths a tick sent of the own vessel that the record keeps: numbers and the position */
function recordedPaths(t: Tick): Map<string, number | [number, number]> {
  const out = new Map<string, number | [number, number]>()
  for (const [key, value] of t.values) {
    const p = key.includes(':') ? key.slice(key.indexOf(':') + 1) : key
    if (typeof value === 'number' && Number.isFinite(value)) out.set(p, value)
    const pos = value as { latitude?: number; longitude?: number } | null
    if (p === 'navigation.position' && typeof pos?.latitude === 'number')
      out.set(p, [pos.longitude!, pos.latitude])
  }
  return out
}

type Band = [number, number]

/** the most a currents gives: Miami's harbour entrance and Queensland's ocean, about 2 kn */
const CURRENT_MAX_KN = 2.5
/** leeway, as the model limits it */
const LEEWAY_MAX = 10 * RAD

/** the fastest the polar has her, knots */
const polarMaxKn = (p: VesselProfile) =>
  p.polar ? Math.max(...p.polar.speedKn.flat()) : 0

/** the band a value of this path must stay in, or undefined for a path with no band */
function band(
  p: VesselProfile,
  key: string
): Band | 'string' | 'boolean' | undefined {
  const pathOnly = key.includes(':') ? key.split(':')[1] : key
  const m = (re: RegExp) => re.exec(pathOnly)
  const unit = (id: string) =>
    p.engines.find((e) => e.id === id) ?? p.generators.find((g) => g.id === id)
  let r: RegExpExecArray | null
  if ((r = m(/^propulsion\.(\w+)\.(.+)$/))) {
    if (p.thrusters.some((t) => t.id === r![1])) {
      if (r[2] === 'state') return 'string'
      if (r[2] === 'engineLoad') return [0, 1]
      if (r[2] === 'runTime') return [0, 1e9]
      return undefined
    }
    const engine = p.engines.find((e) => e.id === r![1])
    const generator = p.generators.find((g) => g.id === r![1])
    const u = unit(r[1])
    if (!u) return undefined
    const maxRpm = engine ? engine.maxRpm : generator!.rpm
    const kw = u.powerKw
    switch (r[2]) {
      case 'state':
      case 'transmission.gear':
        return 'string'
      case 'drive.type':
        return engine?.drive === 'outboard' ? 'string' : undefined
      case 'drive.trimState':
        return engine?.drive === 'outboard' ? [0, 1] : undefined
      case 'revolutions':
        return [0, (maxRpm * 1.05) / 60]
      case 'engineLoad':
        return [0, 1]
      case 'runTime':
        return [0, 1e9]
      case 'coolantTemperature':
        return [KELVIN, KELVIN + 100]
      case 'temperature':
        return [KELVIN, KELVIN + 100]
      case 'oilTemperature':
        return [KELVIN, KELVIN + 130]
      case 'exhaustTemperature':
        return [KELVIN, KELVIN + 650]
      case 'oilPressure':
        return [0, 7e5]
      case 'fuel.rate':
        return [0, (kw * 0.4) / 1000 / 3600]
      case 'alternatorVoltage':
        return [0, 32]
    }
    return undefined
  }
  if ((r = m(/^electrical\.batteries\.(\w+)\.(.+)$/))) {
    const b = p.banks.find((x) => x.id === r![1])
    if (!b) return undefined
    switch (r[2]) {
      case 'voltage':
        return [b.nominalVoltage * 0.85, b.nominalVoltage * 1.25]
      case 'current':
        return [-b.capacityAh, b.capacityAh]
      case 'temperature':
        return [KELVIN - 10, KELVIN + 60]
      case 'capacity.stateOfCharge':
        return [0, 1]
      case 'capacity.stateOfHealth':
        return [0.5, 1]
      case 'capacity.timeRemaining':
        return [0, 1e9]
    }
    return undefined
  }
  if ((r = m(/^electrical\.switches\.(\w+)\.state$/))) {
    const id = r[1]
    return switchList(p).some((x) => x.id === id) ? [0, 1] : undefined
  }
  if ((r = m(/^electrical\.switches\.bank\.0\.(\d+)\.state$/))) {
    const n = Number(r[1])
    return [...bankChannels(p).values()].includes(n) ? [0, 1] : undefined
  }
  if ((r = m(/^electrical\.inverters\.inverter\.(.+)$/))) {
    if (!hasInverter(p)) return undefined
    const bank =
      p.banks.find((b) => b.role === (p.hybrid ? 'propulsion' : 'house')) ??
      p.banks[0]
    // the hotel load at its most, and a hybrid's water maker, which it carries too
    const peakW = (2 * p.hotelKw + 0.025 * p.watermakerLph) * 1000
    switch (r[1]) {
      case 'inverterMode':
        return 'string'
      case 'dc.voltage':
        return [bank.nominalVoltage * 0.85, bank.nominalVoltage * 1.25]
      case 'dc.current':
        return [0, peakW / (0.85 * bank.nominalVoltage)]
      case 'ac.lineNeutralVoltage':
        return [0, p.acVoltage]
      case 'ac.frequency':
        return [0, p.acFrequency]
      case 'ac.current':
        return [0, peakW / p.acVoltage / 0.9]
      case 'ac.realPower':
        return [0, peakW]
      case 'ac.apparentPower':
        return [0, peakW / 0.9]
    }
    return undefined
  }
  if ((r = m(/^electrical\.chargers\.(\w+)\.(.+)$/))) {
    const b = p.banks.find((x) => x.id === r![1])
    if (!b) return undefined
    if (r[2] === 'chargingMode') return 'string'
    if (r[2] === 'voltage')
      return [b.nominalVoltage * 0.85, b.nominalVoltage * 1.25]
    if (r[2] === 'current') return [0, b.capacityAh]
    return undefined
  }
  if ((r = m(/^electrical\.solar\.(\w+)\.(.+)$/))) {
    const s = p.solar.find((x) => x.id === r![1])
    if (!s) return undefined
    switch (r[2]) {
      case 'controllerMode':
      case 'chargingMode':
        return 'string'
      case 'panelPower':
        return [0, s.peakW]
      case 'yieldToday':
        return [0, s.peakW * 24 * 3600]
      case 'panelVoltage':
      case 'voltage':
        return [0, 600]
      case 'panelCurrent':
      case 'current':
        return [0, s.peakW / 10]
    }
    return undefined
  }
  if ((r = m(/^electrical\.alternators\.(\w+)\.(.+)$/))) {
    const t = p.windTurbines.find((x) => x.id === r![1])
    if (!t) return undefined
    if (r[2] === 'chargingMode') return 'string'
    if (r[2] === 'revolutions') return [0, 25]
    if (r[2] === 'voltage') return [0, 60]
    if (r[2] === 'current') return [0, t.ratedW / 10]
    return undefined
  }
  if ((r = m(/^electrical\.ac\.(\w+)\.phase\.(\w+)\.(.+)$/))) {
    const g = p.generators.find((x) => x.id === r![1])
    if (!g && r[1] !== 'shore') return undefined
    const perPhaseW =
      ((g ? g.powerKw : 0.5 * p.lengthM ** 2.2) * 1000) /
      (p.acPhases === 3 ? 3 : 1)
    switch (r[3]) {
      case 'lineNeutralVoltage':
        return [0, p.acVoltage * 1.05]
      case 'lineLineVoltage':
        return [0, p.acVoltage * Math.sqrt(3) * 1.05]
      case 'frequency':
        return [0, p.acFrequency * 1.03]
      case 'current':
        return [0, (perPhaseW / (p.acVoltage * 0.9)) * 1.1]
      case 'realPower':
        return [0, perPhaseW * 1.01]
      case 'apparentPower':
        return [0, (perPhaseW / 0.9) * 1.02]
      case 'powerFactor':
        return [0, 1]
    }
    return undefined
  }
  if ((r = m(/^tanks\.(\w+)\.(\w+)\.(.+)$/))) {
    const t = p.tanks[r[1] as keyof VesselProfile['tanks']]?.find(
      (x) => x.id === r![2]
    )
    if (!t) return undefined
    if (r[3] === 'currentLevel') return [0, 1]
    if (r[3] === 'currentVolume') return [0, t.capacityL / 1000]
    if (r[3] === 'capacity') return [t.capacityL / 1000, t.capacityL / 1000]
    return undefined
  }
  if ((r = m(/^environment\.inside\.(\w+)\.(.+)$/))) {
    const z = p.zones.find((x) => x.id === r![1])
    if (!z) return undefined
    if (r[2] === 'relativeHumidity') return [0, 1]
    if (r[2] !== 'temperature') return undefined
    switch (z.kind) {
      case 'living':
        return [KELVIN + 5, KELVIN + 45]
      case 'engineRoom':
        return [KELVIN + 5, KELVIN + 70]
      case 'fridge':
        return [KELVIN - 5, KELVIN + 10]
      case 'freezer':
        return [KELVIN - 30, KELVIN]
    }
  }
  if ((r = m(/^environment\.depth\.(.+)$/))) {
    if (r[1] === 'belowSurface') return [0.5, 200]
    if (r[1] === 'belowTransducer') return [0, 200]
    if (r[1] === 'belowKeel') return [-p.draftM, 200]
    if (r[1] === 'surfaceToTransducer') return [0, p.draftM]
    if (r[1] === 'transducerToKeel') return [-p.draftM, p.draftM]
    return undefined
  }
  if ((r = m(/^sails\.inventory\.(\w+)\.(\w+)$/))) {
    const sail = p.sails?.find((x) => x.id === r![1])
    if (!sail) return undefined
    if (r[2] === 'name' || r[2] === 'type') return 'string'
    if (r[2] === 'active') return 'boolean'
    if (r[2] === 'area') return [sail.areaM2, sail.areaM2]
    if (r[2] === 'minimumWind' || r[2] === 'maximumWind')
      return [0, 40 * KNOT_MS]
    return undefined
  }
  if (p.sails && (r = m(/^sails\.area\.(total|active)$/))) {
    const total = p.sails.reduce(
      (most, s) => (s.type === 'main' ? most : most + s.areaM2),
      Math.max(...p.sails.filter((s) => s.type === 'main').map((s) => s.areaM2))
    )
    return r[1] === 'total' ? [total, total] : [0, total]
  }
  if (p.polar && (r = m(/^performance\.(\w+)$/))) {
    const most = (polarMaxKn(p) + 0.01) * KNOT_MS
    const water = (p.maxSpeedKn + CURRENT_MAX_KN) * KNOT_MS * 1.01
    const bands: Record<string, Band> = {
      polarSpeed: [0, most],
      // through the water she makes at most her top speed, over at least a knot of polar
      polarSpeedRatio: [0, water / KNOT_MS],
      velocityMadeGood: [-water, water],
      beatAngle: [25 * RAD, 90 * RAD],
      beatAngleTargetSpeed: [0, most],
      beatAngleVelocityMadeGood: [0, most],
      gybeAngle: [90 * RAD, Math.PI],
      gybeAngleTargetSpeed: [0, most],
      gybeAngleVelocityMadeGood: [-most, 0],
      targetAngle: [25 * RAD, Math.PI],
      targetSpeed: [0, most],
      leeway: [-LEEWAY_MAX, LEEWAY_MAX],
      tackTrue: [0, 2 * Math.PI],
      tackMagnetic: [0, 2 * Math.PI]
    }
    return bands[r[1]]
  }
  if (pathOnly === 'sensors.ais.fromBow') return [0, p.lengthM]
  if (pathOnly === 'sensors.ais.fromCenter') return [-p.beamM / 2, p.beamM / 2]
  if ((r = m(/^sensors\.(\w+)\.fromCenter$/))) {
    const s = p.sounders.find((x) => x.id === r![1])
    return s ? [s.offsetM, s.offsetM] : undefined
  }
  const fixed: Record<string, Band | 'string'> = {
    'environment.wind.speedTrue': [0, 30],
    'environment.wind.speedApparent': [0, 45],
    'environment.wind.directionTrue': [0, 2 * Math.PI],
    'environment.wind.angleTrueWater': [-Math.PI, Math.PI],
    'environment.wind.angleApparent': [-Math.PI, Math.PI],
    'environment.outside.temperature': [KELVIN - 10, KELVIN + 50],
    'environment.outside.pressure': [95000, 106000],
    'environment.water.temperature': [KELVIN - 2, KELVIN + 35],
    'environment.outside.relativeHumidity': [0, 1],
    'steering.autopilot.target.headingTrue': [0, 2 * Math.PI],
    'steering.autopilot.target.headingMagnetic': [0, 2 * Math.PI],
    'steering.autopilot.target.windAngleApparent': [-Math.PI, Math.PI],
    'environment.tide.heightNow': [-1.5, 3],
    'environment.tide.heightHigh': [-1.5, 3],
    'environment.tide.heightLow': [-1.5, 3],
    'environment.tide.timeHigh': 'string',
    'environment.tide.timeLow': 'string',
    // the water speed is the ground speed less the current
    'navigation.speedThroughWater': [
      0,
      (p.maxSpeedKn + CURRENT_MAX_KN) * KNOT_MS * 1.01
    ],
    'navigation.speedThroughWaterLongitudinal': [
      0,
      (p.maxSpeedKn + CURRENT_MAX_KN) * KNOT_MS * 1.01
    ],
    'navigation.speedThroughWaterTransverse': [
      -(p.maxSpeedKn + CURRENT_MAX_KN) * KNOT_MS * Math.sin(LEEWAY_MAX),
      (p.maxSpeedKn + CURRENT_MAX_KN) * KNOT_MS * Math.sin(LEEWAY_MAX)
    ],
    'navigation.leewayAngle': p.polar ? [-LEEWAY_MAX, LEEWAY_MAX] : [0, 0],
    'environment.current.drift': [0, CURRENT_MAX_KN * KNOT_MS],
    'environment.current.setTrue': [0, 2 * Math.PI],
    'environment.current.setMagnetic': [0, 2 * Math.PI],
    'navigation.speedOverGround': [0, p.maxSpeedKn * KNOT_MS * 1.01],
    'navigation.courseOverGroundTrue': [0, 2 * Math.PI],
    'navigation.courseOverGroundMagnetic': [0, 2 * Math.PI],
    'navigation.headingTrue': [0, 2 * Math.PI],
    'navigation.headingMagnetic': [0, 2 * Math.PI],
    'navigation.magneticVariation': [-Math.PI / 6, Math.PI / 6],
    'navigation.rateOfTurn': [-5 * RAD, 5 * RAD],
    'steering.rudderAngle': [-35 * RAD, 35 * RAD],
    'navigation.attitude.roll': [-25 * RAD, 25 * RAD],
    'navigation.attitude.pitch': [-10 * RAD, 10 * RAD],
    'navigation.log': [0, 1e8],
    'navigation.trip.log': [0, 1e7],
    'navigation.gnss.satellites': [5, 16],
    'navigation.gnss.horizontalDilution': [0.5, 3],
    'navigation.gnss.positionDilution': [0.85, 5.1],
    'navigation.trip.lastReset': 'string',
    'navigation.state': 'string',
    'navigation.gnss.type': 'string',
    'navigation.gnss.methodQuality': 'string',
    'navigation.datetime': 'string',
    'navigation.anchor.maxRadius': [1, 200],
    'navigation.lights': 'string',
    ...(p.windlass
      ? { 'navigation.anchor.rodeCounterLength': [0, 200] as Band }
      : {}),
    'navigation.anchor.currentRadius': [0, 200]
  }
  return fixed[pathOnly]
}

/** paths that are sent only some of the time */
const CONDITIONAL = [
  /\.capacity\.timeRemaining$/,
  /^navigation\.anchor\./,
  /^electrical\.chargers\./,
  /^electrical\.ac\.shore\./,
  /\.chargingMode$/
]

function spearman(xs: number[], ys: number[]): number {
  const rank = (v: number[]) => {
    const order = v.map((x, i) => [x, i]).sort((a, b) => a[0] - b[0])
    const ranks = new Array<number>(v.length)
    order.forEach(([, i], r) => {
      ranks[i] = r
    })
    return ranks
  }
  const rx = rank(xs)
  const ry = rank(ys)
  const mean = (v: number[]) => v.reduce((s, x) => s + x, 0) / v.length
  const mx = mean(rx)
  const my = mean(ry)
  let num = 0
  let dx = 0
  let dy = 0
  for (let i = 0; i < rx.length; i++) {
    num += (rx[i] - mx) * (ry[i] - my)
    dx += (rx[i] - mx) ** 2
    dy += (ry[i] - my) ** 2
  }
  return num / Math.sqrt(dx * dy)
}

function num(t: Tick, key: string): number | undefined {
  const v = t.values.get(key)
  return typeof v === 'number' ? v : undefined
}

describe('Simulator systems soak', function () {
  this.timeout(0)
  let all: SoakCase[] = []
  const results = new Map<string, CaseResult>()

  before(async () => {
    const only = process.env.SOAK_CASES
    all = (await cases()).filter((c) => !only || c.name.includes(only))
  })

  it('covers every profile, a day each, and the motor-sailer and the catamaran for three', function () {
    if (process.env.SOAK_CASES) this.skip()
    const covered = new Set(all.map((c) => c.profile.id))
    expect([...covered].sort()).to.deep.equal(listProfiles(VESSELS))
    expect(STEP_S).to.be.at.most(TIME_MULTIPLIER)
    const sailer = all.filter((c) => c.profile.id === 'motor-sailer-15m')
    expect(sailer.map((c) => c.hours)).to.deep.equal([72])
    const cat = all.filter((c) => c.profile.id === 'hybrid-catamaran-60ft')
    expect(cat.map((c) => c.hours)).to.deep.equal([24, 72])
    for (const c of all) {
      expect(c.hours, c.name).to.be.at.least(24)
    }
  })

  it('runs every case', () => {
    for (const c of all) results.set(c.name, run(c))
    expect(results.size).to.equal(all.length)
  })

  after(() => {
    // what each case did, so a run shows its evidence as well as its verdict
    const rows = [...results.values()].map((r) => {
      const p = r.soak.profile
      const first = r.ticks[0].summary
      const last = r.ticks[r.ticks.length - 1].summary
      let starts = 0
      r.ticks.forEach((t, i) => {
        const before = i ? r.ticks[i - 1].summary.generatorsRunning : 0
        if (t.summary.generatorsRunning > before) starts++
      })
      const socs = r.ticks
        .map((t) => t.summary.houseSoc)
        .filter((x): x is number => x !== undefined)
      const fuelL = p.tanks.fuel.reduce((sum, t) => sum + t.capacityL, 0)
      return {
        case: r.soak.name,
        hours: r.soak.hours,
        deltas: r.deltas,
        'generator starts': starts,
        'water made (l)': Math.round(last.madeL),
        'pump-outs': Object.values(last.pumpOuts).reduce((a, b) => a + b, 0),
        'lowest house SoC': socs.length ? Math.min(...socs).toFixed(2) : '-',
        'thrusters run (s)': Object.keys(last.thrusters).length
          ? Object.entries(last.thrusters)
              .map(([id, t]) => `${id.replace('Thruster', '')} ${t.runS}`)
              .join(', ')
          : '-',
        'fuel left': fuelL
          ? `${Math.round((100 * last.fuelL) / fuelL)} % (from ${Math.round((100 * first.fuelL) / fuelL)} %)`
          : '-'
      }
    })
    console.table(rows)
    const raised = [...results.values()].flatMap((r) => {
      const byPath = new Map<string, Note[]>()
      for (const n of r.notes) {
        if (!SEVERE.has(n.value.state)) continue
        byPath.set(n.path, [...(byPath.get(n.path) ?? []), n])
      }
      return [...byPath].map(([path, ns]) => ({
        case: r.soak.name,
        notification: path,
        raised: ns.length,
        states: [...new Set(ns.map((n) => n.value.state))].join(', '),
        message: ns[0].value.message,
        first: new Date(ns[0].ms).toISOString().slice(0, 16)
      }))
    })
    if (raised.length) console.table(raised)
    else console.log('no notifications raised')
  })

  const each = (fn: (r: CaseResult) => void) => () => {
    for (const r of results.values()) fn(r)
  }

  it(
    'validates every delta against the Signal K schema',
    each((r) => {
      expect(r.invalid, r.soak.name).to.deep.equal([])
      expect(r.deltas, r.soak.name).to.be.above(r.ticks.length)
    })
  )

  it(
    'keeps every value in its band, with no NaN or unknown path',
    each((r) => {
      const problems: string[] = []
      const report = (msg: string) => {
        if (problems.length < 10) problems.push(msg)
      }
      for (const t of r.ticks) {
        for (const [key, value] of t.values) {
          // notifications are checked against their zones below
          if (
            key === '' ||
            key.startsWith('design.') ||
            key.startsWith('notifications.')
          )
            continue
          // an object value: each of its fields in its own band
          if (
            key === 'navigation.attitude' ||
            key === 'environment.current' ||
            key.startsWith('sails.inventory.')
          ) {
            for (const [field, v] of Object.entries(
              value as Record<string, unknown>
            )) {
              const b = band(r.soak.profile, `${key}.${field}`)
              const fits =
                b === 'string'
                  ? typeof v === 'string' && v !== ''
                  : b === 'boolean'
                    ? typeof v === 'boolean'
                    : Array.isArray(b) &&
                      typeof v === 'number' &&
                      Number.isFinite(v) &&
                      v >= b[0] - 1e-9 &&
                      v <= b[1] + 1e-9
              if (!fits) report(`${key}.${field} = ${v}`)
            }
            continue
          }
          // the anchor's values, cleared once it is weighed
          if (value === null && key.startsWith('navigation.anchor.')) continue
          if (
            key === 'navigation.position' ||
            key === 'navigation.anchor.position'
          ) {
            const pos = value as { latitude: number; longitude: number }
            if (
              !Number.isFinite(pos.latitude) ||
              !Number.isFinite(pos.longitude)
            )
              report(`${key} not finite`)
            continue
          }
          const b = band(r.soak.profile, key)
          if (b === undefined) {
            report(`${key}: no band for this path`)
          } else if (b === 'string') {
            if (typeof value !== 'string' || !value) report(`${key}: ${value}`)
          } else if (b === 'boolean') {
            if (typeof value !== 'boolean') report(`${key}: ${value}`)
          } else if (typeof value !== 'number' || !Number.isFinite(value)) {
            report(`${key}: ${value}`)
          } else if (value < b[0] - 1e-9 || value > b[1] + 1e-9) {
            report(
              `${key} = ${value} at ${new Date(t.ms).toISOString()}, band ${b[0]} to ${b[1]}`
            )
          }
        }
      }
      expect(problems, r.soak.name).to.deep.equal([])
    })
  )

  it(
    'sends every value every time, apart from the ones that come and go',
    each((r) => {
      const steady = (s: Set<string>) =>
        [...s].filter((p) => !CONDITIONAL.some((re) => re.test(p)))
      const first = r.ticks.find((t) => t.main && !t.slow)!.main!
      const firstSlow = r.ticks.find((t) => t.slow)!.main!
      const missing: string[] = []
      for (const t of r.ticks) {
        if (!t.main) {
          missing.push(`no systems delta at ${new Date(t.ms).toISOString()}`)
          continue
        }
        const need = steady(t.slow ? firstSlow : first)
        for (const p of need) if (!t.main.has(p)) missing.push(p)
        for (const s of r.soak.profile.sounders) {
          if (!t.values.has(`${s.id}:environment.depth.belowSurface`))
            missing.push(`${s.id} depth`)
        }
        if (missing.length > 5) break
      }
      expect(missing, r.soak.name).to.deep.equal([])
    })
  )

  it(
    'keeps runTime counting up and the solar yield resetting only at midnight',
    each((r) => {
      const last = new Map<string, number>()
      for (const t of r.ticks) {
        for (const [key, value] of t.values) {
          if (typeof value !== 'number') continue
          if (key.endsWith('.runTime')) {
            expect(value, key).to.be.at.least(last.get(key) ?? 0)
            last.set(key, value)
          }
          if (key.endsWith('.yieldToday')) {
            const before = last.get(key) ?? 0
            if (value < before) expect(t.hour, `${key} reset`).to.be.below(1)
            last.set(key, value)
          }
        }
      }
    })
  )

  it(
    'keeps the navigation state in step with the engines',
    each((r) => {
      const p = r.soak.profile
      const states = new Map<string, number>()
      const problems: string[] = []
      for (const t of r.ticks) {
        const state = t.values.get('navigation.state') as string
        states.set(state, (states.get(state) ?? 0) + 1)
        const started = p.engines.filter(
          (e) => t.values.get(`propulsion.${e.id}.state`) === 'started'
        ).length
        const inGear = p.engines.filter(
          (e) =>
            t.values.get(`propulsion.${e.id}.transmission.gear`) === 'Forward'
        ).length
        const at = `${state} at ${new Date(t.ms).toISOString()}`
        const stopped = state !== 'motoring'
        if (stopped && (started || inGear))
          problems.push(`${at}: ${started} started, ${inGear} in gear`)
        if (!stopped && !inGear) problems.push(`${at}: nothing in gear`)
        if (state === 'moored' && !t.atBerth)
          problems.push(`${at}: not at a berth`)
        if (problems.length > 5) break
      }
      expect(problems, r.soak.name).to.deep.equal([])
      expect([...states.keys()], r.soak.name).to.include('motoring')
      if (p.rig === 'sail')
        expect([...states.keys()], r.soak.name).to.include('sailing')
    })
  )

  it(
    'holds the heading to the course over the ground, off it only by the current and the sea',
    each((r) => {
      const problems: string[] = []
      for (const t of r.ticks) {
        const sogKn = (num(t, 'navigation.speedOverGround') ?? 0) / KNOT_MS
        if (
          sogKn < 2 ||
          Math.abs(num(t, 'navigation.rateOfTurn') ?? 0) > 0.5 * RAD
        )
          continue
        const off =
          (((num(t, 'navigation.headingTrue')! -
            num(t, 'navigation.courseOverGroundTrue')!) /
            RAD +
            540) %
            360) -
          180
        // a knot of current across the track at this speed, and a few degrees of yaw
        const allowed = Math.asin(Math.min(1, 1 / sogKn)) / RAD + 10
        if (Math.abs(off) > allowed && problems.length < 5)
          problems.push(
            `${off.toFixed(1)} degrees at ${sogKn.toFixed(1)} kn, ${new Date(t.ms).toISOString()}`
          )
      }
      expect(problems, r.soak.name).to.deep.equal([])
    })
  )

  it(
    'balances the energy books of every bank, and the fuel',
    each((r) => {
      const rows: Record<string, string>[] = []
      const problems: string[] = []
      for (const b of r.books.banks) {
        const sum = (x: Record<string, number>) =>
          Object.values(x).reduce((a, v) => a + v, 0)
        const inJ = sum(b.inJ)
        const outJ = sum(b.outJ)
        const accounted = outJ + b.storedJ + b.lossJ
        const throughput = Math.max(inJ, outJ, 1)
        const error = (inJ - accounted) / throughput
        rows.push({
          case: r.soak.name,
          bank: b.id,
          'in (kWh)': (inJ / 3.6e6).toFixed(2),
          'out (kWh)': (outJ / 3.6e6).toFixed(2),
          'stored (kWh)': (b.storedJ / 3.6e6).toFixed(2),
          'loss (kWh)': (b.lossJ / 3.6e6).toFixed(3),
          'clipped (kWh)': (b.clippedJ / 3.6e6).toFixed(4),
          error: `${(100 * error).toFixed(3)} %`
        })
        if (Math.abs(error) > BOOKS_TOLERANCE)
          problems.push(`${b.id}: books out by ${(100 * error).toFixed(2)} %`)
      }
      console.table(rows)
      const fuel = r.books.fuel
      console.table([
        {
          case: r.soak.name,
          'out of the tanks (l)': (fuel.tanksStartL - fuel.tanksNowL).toFixed(
            2
          ),
          'at the fuel rates (l)': fuel.burnedL.toFixed(2),
          'rates sent, integrated (l)': r.sentFuelL.toFixed(2),
          ...Object.fromEntries(
            r.books.generators.map((g) => [
              `${g.id} efficiency`,
              g.fuelL
                ? `${((100 * g.outputJ) / (g.fuelL * DIESEL_KWH_PER_L * 3.6e6)).toFixed(1)} %`
                : 'did not run'
            ])
          )
        }
      ])
      expect(
        fuel.tanksStartL - fuel.tanksNowL,
        'fuel out of the tanks'
      ).to.be.closeTo(fuel.burnedL, 1e-6 * fuel.tanksStartL + 1e-6)
      if (fuel.burnedL > 1) {
        expect(r.sentFuelL, `${r.soak.name} fuel rates sent`).to.be.closeTo(
          fuel.burnedL,
          BOOKS_TOLERANCE * fuel.burnedL
        )
      }
      for (const g of r.books.generators) {
        const fuelJ = g.fuelL * DIESEL_KWH_PER_L * 3.6e6
        expect(g.outputJ, `${r.soak.name} ${g.id} output`).to.be.at.most(
          GENERATOR_MAX_EFFICIENCY * fuelJ
        )
      }
      expect(problems, r.soak.name).to.deep.equal([])
    })
  )

  it('runs the hybrid as a hybrid: electric in harbour, diesels charging on passage, solar by day', () => {
    const cat = [...results.values()].filter(
      (r) => r.soak.profile.id === 'hybrid-catamaran-60ft'
    )
    expect(cat).to.have.length(2)
    for (const r of cat) {
      const rules = r.soak.profile.hybrid!
      const engines = r.soak.profile.engines.map((e) => e.id)
      let soc = 1
      let electric = 0
      let diesel = 0
      let charging = 0
      let solarDays = 0
      let solarCarries = 0
      const starts: number[] = []
      let generatorWas = false
      for (const t of r.ticks) {
        const s = num(
          t,
          'electrical.batteries.propulsion.capacity.stateOfCharge'
        )
        if (s !== undefined) soc = s
        const label = `${r.soak.name} at ${new Date(t.ms).toISOString()}`
        const moving = t.sogKn > 0.5 && !t.atBerth
        const started = engines.filter(
          (id) => t.values.get(`propulsion.${id}.state`) === 'started'
        ).length
        if (
          moving &&
          t.sogKn <= rules.electricBelowKn - 0.5 &&
          soc > rules.electricAboveSoc
        ) {
          expect(started, `${label}: electric at ${t.sogKn} kn`).to.equal(0)
          electric++
        }
        if (moving && t.sogKn > rules.electricBelowKn + 0.5) {
          expect(started, `${label}: diesels at ${t.sogKn} kn`).to.equal(
            engines.length
          )
          diesel++
          const current = num(t, 'electrical.batteries.propulsion.current')
          if (current !== undefined && soc < 0.98 && current > 1) charging++
        }
        const generator = t.summary.generatorsRunning > 0
        if (generator && !generatorWas) starts.push(soc)
        generatorWas = generator
        if (t.sunDeg > 30 && t.slow && !t.atBerth) {
          solarDays++
          const solarW = r.soak.profile.solar.reduce(
            (sum, a) =>
              sum + (num(t, `electrical.solar.${a.id}.panelPower`) ?? 0),
            0
          )
          if (solarW >= 1000 * t.summary.hotelKw) solarCarries++
        }
      }
      expect(electric, `${r.soak.name} electric ticks`).to.be.above(0)
      if (r.soak.hours === 72) {
        expect(diesel, `${r.soak.name} diesel ticks`).to.be.above(0)
        expect(charging, `${r.soak.name} charging on passage`).to.be.above(0)
      }
      for (const s of starts) {
        // the generator starts only when the bank needs it; the soc read lags a few ticks
        expect(s, `${r.soak.name} generator started at`).to.be.below(
          rules.dieselBelowSoc + 0.02
        )
      }
      expect(
        solarCarries / Math.max(1, solarDays),
        `${r.soak.name} solar by day`
      ).to.be.at.least(0.8)
    }
  })

  it(
    'runs the thrusters only coming alongside and leaving, in bursts the bank carries',
    each((r) => {
      const p = r.soak.profile
      if (!p.thrusters.length) return
      const legs = routeLegs(r.soak.route)
      // the berth the boat is leaving or coming to, at its own end of the passage
      const fromBerthM = (t: Tick) =>
        berthApproachM(legs, positionAt(legs, t.ms)) ?? Infinity
      // the thrusters' zone, and as far as a tick can carry the boat at its top speed
      const reachM =
        3 * p.lengthM +
        (TICK_MS * TIME_MULTIPLIER * p.maxSpeedKn * KNOT_MS) / 1000
      const last = r.ticks[r.ticks.length - 1].summary.thrusters
      for (const th of p.thrusters) {
        // every case comes alongside at the end, so the bow thruster has run
        expect(last[th.id].runS, `${r.soak.name} ${th.id} ran`).to.be.above(0)
        for (let i = 1; i < r.ticks.length; i++) {
          const a = r.ticks[i - 1]
          const t = r.ticks[i]
          const at = `${r.soak.name} ${th.id} at ${new Date(t.ms).toISOString()}`
          if (t.values.get(`propulsion.${th.id}.state`) === 'started') {
            expect(t.values.get('navigation.state'), at).to.equal('motoring')
            expect(fromBerthM(t), at).to.be.at.most(3 * p.lengthM + 1)
          }
          const ran =
            (num(t, `propulsion.${th.id}.runTime`) ?? 0) -
            (num(a, `propulsion.${th.id}.runTime`) ?? 0)
          if (ran > 0) {
            expect(
              Math.min(fromBerthM(a), fromBerthM(t)),
              `${at}: ran ${ran} s away from a berth`
            ).to.be.at.most(reachM)
          }
        }
        // an electric thruster's hardest burst shows on its bank's current
        const peak = last[th.id].peak
        if (th.type === 'electric') {
          expect(peak, `${r.soak.name} ${th.id} burst`).to.not.equal(undefined)
          expect(
            -peak!.currentA * peak!.voltage,
            `${r.soak.name} ${th.id}`
          ).to.be.within(0.5 * peak!.drawW, 1.1 * peak!.drawW)
        } else {
          expect(peak, `${r.soak.name} ${th.id} draws no bank`).to.equal(
            undefined
          )
        }
      }
    })
  )

  it(
    'keeps the banks charged and the fuel from running out',
    each((r) => {
      const p = r.soak.profile
      for (const t of r.ticks) {
        for (const b of p.banks) {
          const soc = num(
            t,
            `electrical.batteries.${b.id}.capacity.stateOfCharge`
          )
          if (soc === undefined) continue
          const floor = b.role === 'start' ? 0.8 : 0.15
          expect(
            soc,
            `${r.soak.name} ${b.id} at ${new Date(t.ms).toISOString()}`
          ).to.be.within(floor, 1)
        }
        for (const tank of p.tanks.fuel) {
          const level = num(t, `tanks.fuel.${tank.id}.currentLevel`)
          if (level !== undefined)
            expect(
              level,
              `${r.soak.name} ${tank.id} at ${new Date(t.ms).toISOString()}`
            ).to.be.above(0.02)
        }
      }
    })
  )

  it('starts and stops the generators on their own, without short cycling', () => {
    for (const profile of new Set(all.map((c) => c.profile))) {
      if (!profile.generators.length) continue
      const mine = [...results.values()].filter(
        (r) => r.soak.profile === profile
      )
      const g = profile.generators[0].id
      let starts = 0
      let stops = 0
      for (const r of mine) {
        let since: number | undefined
        r.ticks.forEach((t, i) => {
          const on = t.summary.generators[g]
          const was = i ? r.ticks[i - 1].summary.generators[g] : false
          if (on && !was) {
            starts++
            since = t.ms
          }
          if (!on && was) {
            stops++
            // a run cut short only by arriving alongside, where shore power takes over
            if (!t.atBerth) {
              expect(
                t.ms - since!,
                `${r.soak.name} ${g} ran too briefly`
              ).to.be.at.least(14 * 60000)
            }
          }
        })
        const days = r.soak.hours / 24
        expect(starts, `${r.soak.name} starts`).to.be.at.most(12 * days)
      }
      if (profile.hybrid && starts === 0) {
        // a hybrid's generator charges its bank only when the bank needs it; a run whose
        // bank never got that low never needs it (the fast tests start one)
        for (const r of mine) {
          for (const t of r.ticks) {
            const soc = num(
              t,
              'electrical.batteries.propulsion.capacity.stateOfCharge'
            )
            if (soc !== undefined && !t.atBerth)
              expect(soc, `${r.soak.name} needed its generator`).to.be.at.least(
                profile.hybrid.dieselBelowSoc
              )
          }
        }
        continue
      }
      expect(starts, `${profile.id} starts`).to.be.at.least(1)
      expect(stops, `${profile.id} stops`).to.be.at.least(1)
    }
  })

  it(
    'follows the sun with the solar arrays, at the sample latitude and date',
    each((r) => {
      for (const s of r.soak.profile.solar) {
        const key = `electrical.solar.${s.id}.panelPower`
        const soc = `electrical.batteries.${s.bank}.capacity.stateOfCharge`
        const sun: number[] = []
        const power: number[] = []
        let peakW = 0
        for (const t of r.ticks) {
          const w = num(t, key)
          if (w === undefined) continue
          const when = `${r.soak.name} ${s.id} ${new Date(t.ms).toISOString()}`
          if (t.sunDeg < 0) expect(w, `${when} at night`).to.equal(0)
          if (t.sunDeg > 15) expect(w, `${when} in daylight`).to.be.above(0)
          // never more than the sun gives at this elevation (sent in whole watts)
          const clearSkyW =
            s.peakW * Math.max(0, Math.sin((t.sunDeg * Math.PI) / 180)) ** 1.2
          expect(w, `${when} against the sun`).to.be.at.most(clearSkyW + 0.5)
          peakW = Math.max(peakW, w)
          // while the bank still takes charge, output follows the sun, not the bank
          if (t.sunDeg > 0 && (num(t, soc) ?? 1) < 0.95) {
            sun.push(t.sunDeg)
            power.push(w)
          }
        }
        expect(peakW, `${r.soak.name} ${s.id} peak`).to.be.above(0.2 * s.peakW)
        if (sun.length >= 20) {
          expect(
            spearman(sun, power),
            `${r.soak.name} ${s.id} against the sun`
          ).to.be.above(0.7)
        }
      }
    })
  )

  it(
    'carries an air conditioning load that follows the outside temperature',
    each((r) => {
      if (!r.soak.profile.generators.length) {
        for (const t of r.ticks) expect(t.summary.hvacKw).to.equal(0)
        return
      }
      const on = r.ticks.filter(
        (t) => t.summary.hvacKw > 0 || t.summary.airC > 23
      )
      const powered = on.filter(
        (t) => t.atBerth || t.summary.generatorsRunning > 0
      )
      for (const t of r.ticks) {
        if (!t.atBerth && t.summary.generatorsRunning === 0) {
          expect(t.summary.hvacKw, `${r.soak.name} no AC source`).to.equal(0)
        }
        if (t.summary.airC <= 22) expect(t.summary.hvacKw).to.equal(0)
      }
      if (powered.length > 20) {
        const rho = spearman(
          powered.map((t) => t.summary.airC),
          powered.map((t) => t.summary.hvacKw)
        )
        expect(
          rho,
          `${r.soak.name} AC against outside temperature`
        ).to.be.above(0.9)
      }
    })
  )

  it(
    'uses fresh water through the day and refills it with the water maker',
    each((r) => {
      const p = r.soak.profile
      if (!p.tanks.freshWater.length) return
      const byHour = new Array<number>(24).fill(0)
      const counts = new Array<number>(24).fill(0)
      for (let i = 1; i < r.ticks.length; i++) {
        const t = r.ticks[i]
        const used = t.summary.freshUsedL - r.ticks[i - 1].summary.freshUsedL
        if ((t.summary.freshLevel ?? 0) < 0.05) continue
        byHour[Math.floor(t.hour)] += used
        counts[Math.floor(t.hour)]++
      }
      const rate = (from: number, to: number) => {
        let used = 0
        let n = 0
        for (let h = from; h < to; h++) {
          used += byHour[h]
          n += counts[h]
        }
        return n ? used / n : 0
      }
      expect(rate(6, 9), `${r.soak.name} morning against night`).to.be.above(
        3 * rate(0, 5)
      )
      if (p.watermakerLph) {
        for (let i = 1; i < r.ticks.length; i++) {
          const t = r.ticks[i]
          if (
            t.summary.watermakerRunning &&
            r.ticks[i - 1].summary.watermakerRunning
          ) {
            expect(
              t.summary.freshLevel!,
              `${r.soak.name} refilling`
            ).to.be.at.least(r.ticks[i - 1].summary.freshLevel! - 1e-9)
          }
          expect(
            t.summary.freshLevel!,
            `${r.soak.name} fresh level`
          ).to.be.above(0.5)
        }
      }
    })
  )

  it('makes water on every boat with a water maker', () => {
    for (const profile of new Set(all.map((c) => c.profile))) {
      if (!profile.watermakerLph) continue
      const made = [...results.values()]
        .filter((r) => r.soak.profile === profile)
        .reduce((sum, r) => sum + r.ticks[r.ticks.length - 1].summary.madeL, 0)
      expect(made, `${profile.id} water made`).to.be.above(0)
    }
  })

  it('fills the holding tanks and pumps them out where allowed, before they overflow', () => {
    let greyPumpOuts = 0
    let blackPumpOuts = 0
    for (const r of results.values()) {
      const p = r.soak.profile
      for (const type of ['wasteWater', 'blackWater'] as const) {
        for (const tank of p.tanks[type]) {
          const key = `tanks.${type}.${tank.id}.currentLevel`
          let rose = false
          let previous: Tick | undefined
          for (const t of r.ticks) {
            const level = num(t, key)
            if (level === undefined) continue
            expect(level, `${r.soak.name} ${tank.id} overflowing`).to.be.below(
              0.95
            )
            const before = previous && num(previous, key)
            if (before !== undefined) {
              if (level > before + 0.003) rose = true
              if (type === 'blackWater' && level < before - 0.02) {
                // black water goes overboard only well offshore, or at the pump-out station
                expect(
                  t.atBerth || t.sogKn >= 5,
                  `${r.soak.name} ${tank.id} pumped at ${new Date(t.ms).toISOString()}`
                ).to.equal(true)
              }
            }
            previous = t
          }
          expect(rose, `${r.soak.name} ${tank.id} fills`).to.equal(true)
          const pumped =
            r.ticks[r.ticks.length - 1].summary.pumpOuts[tank.id] ?? 0
          if (type === 'wasteWater') greyPumpOuts += pumped
          else blackPumpOuts += pumped
        }
      }
    }
    expect(greyPumpOuts, 'grey water pump-outs').to.be.at.least(1)
    expect(blackPumpOuts, 'black water pump-outs').to.be.at.least(1)
  })

  it(
    'raises each notification from its zone and clears it out of it',
    each((r) => {
      const problems: string[] = []
      for (const n of r.notes) {
        // the anchor watch and the lights failure raise their own, with no zone
        if (n.path === ANCHOR_ALARM || n.path === LIGHTS_ALARM) continue
        const band = r.bands.get(n.path)
        const at = `${n.path} ${n.value.state} at ${new Date(n.ms).toISOString()}`
        if (!band) {
          problems.push(`${at}: no zone on this path`)
          continue
        }
        if (n.value.state === 'normal') {
          // cleared: out of every zone, or no longer read
          const w = n.watched
          if (
            typeof w === 'number' &&
            band.zones.some(
              (z) =>
                SEVERE.has(z.state) &&
                (z.lower === undefined || w >= z.lower) &&
                (z.upper === undefined || w < z.upper)
            )
          )
            problems.push(`${at}: cleared at ${n.watched}, still in a zone`)
          continue
        }
        const v = n.watched
        const matches =
          typeof v === 'number' &&
          band.zones.some(
            (z) =>
              z.state === n.value.state &&
              z.message === n.value.message &&
              (z.lower === undefined || v >= z.lower - band.margin) &&
              (z.upper === undefined || v < z.upper + band.margin)
          )
        if (!matches) problems.push(`${at}: ${v} is not in its zone`)
        const method =
          n.value.state === 'warn' ? ['visual'] : ['visual', 'sound']
        if (JSON.stringify(n.value.method) !== JSON.stringify(method))
          problems.push(`${at}: method ${n.value.method}`)
      }
      expect(problems.slice(0, 10), r.soak.name).to.deep.equal([])
    })
  )

  it(
    'raises only the alarms a day on board should, and clears each',
    each((r) => {
      const raised = new Set(
        r.notes.filter((n) => SEVERE.has(n.value.state)).map((n) => n.path)
      )
      const unexpected = [...raised].filter(
        (p) =>
          !DAY_ALARMS.some((re) => re.test(p)) &&
          !(p === ANCHOR_ALARM && r.dragged) &&
          p !== LIGHTS_ALARM
      )
      expect(unexpected, r.soak.name).to.deep.equal([])
    })
  )

  it(
    'sails each passage on the autopilot in route mode, and a day out by the helm',
    each((r) => {
      const raised = (path: string) =>
        r.pilotUpdates.filter(
          (x) => x.u.alarm?.path === path && x.u.alarm.value.state !== 'normal'
        )
      if (r.soak.pilot === 'standby' || !r.soak.profile.autopilot) {
        // the helm has her all day: the pilot never engages, and says nothing
        expect(
          r.pilotUpdates.filter((x) => x.u.engaged),
          r.soak.name
        ).to.deep.equal([])
        expect(
          r.pilotUpdates.filter((x) => x.u.alarm),
          r.soak.name
        ).to.deep.equal([])
        return
      }
      expect(r.underWayTicks, r.soak.name).to.be.above(60)
      // engaged from the tick after she gets under way, and again after each anchorage
      expect(r.engagedTicks / r.underWayTicks, r.soak.name).to.be.above(0.98)
      expect(raised('waypointArrival').length, r.soak.name).to.be.above(5)
      expect(raised('routeComplete'), r.soak.name).to.have.length(1)
      for (const off of ['xte', 'heading', 'wind'])
        expect(raised(off), `${r.soak.name} ${off}`).to.deep.equal([])
    })
  )

  it(
    'agrees the speed through the water with the speed over the ground less the current',
    each((r) => {
      let checked = 0
      const off: string[] = []
      for (const t of r.ticks) {
        const state = t.values.get('navigation.state')
        const stw = num(t, 'navigation.speedThroughWater')
        const sog = num(t, 'navigation.speedOverGround')
        const cog = num(t, 'navigation.courseOverGroundTrue')
        if (
          (state !== 'motoring' && state !== 'sailing') ||
          stw === undefined ||
          sog === undefined ||
          cog === undefined ||
          sog < 0.5 * KNOT_MS
        )
          continue
        const c = t.summary.water
        const set = c.currentToDeg * RAD
        const e = sog * Math.sin(cog) - c.currentKn * KNOT_MS * Math.sin(set)
        const n = sog * Math.cos(cog) - c.currentKn * KNOT_MS * Math.cos(set)
        checked++
        // the speeds are sent to the millimetre a second, the course to a ten-thousandth
        if (Math.abs(Math.hypot(e, n) - stw) > 0.01 && off.length < 5)
          off.push(
            `${new Date(t.ms).toISOString()}: through the water ${stw}, over the ground less the current ${Math.hypot(e, n).toFixed(3)}`
          )
      }
      expect(checked, r.soak.name).to.be.above(60)
      expect(off, r.soak.name).to.deep.equal([])
    })
  )

  it(
    'sets sails only on a sailing boat, and only under way',
    each((r) => {
      const sailing = r.soak.profile.rig === 'sail'
      let set = 0
      let state: unknown
      for (const t of r.ticks) {
        state = t.values.get('navigation.state') ?? state
        for (const key of t.values.keys()) {
          if (!sailing && /^(sails|performance)\./.test(key))
            expect.fail(`${r.soak.name}: ${key} from a motor boat`)
        }
        const active = num(t, 'sails.area.active')
        if (active === undefined || active === 0) continue
        set++
        expect(
          state,
          `${r.soak.name} at ${new Date(t.ms).toISOString()}`
        ).to.be.oneOf(['sailing', 'motoring'])
      }
      if (sailing) expect(set, r.soak.name).to.be.above(0)
    })
  )

  it(
    'shows the lights by the sun and what she is doing, and fails them only from dusk',
    each((r) => {
      let state: unknown
      const seen = new Set<unknown>()
      for (const t of r.ticks) {
        state = t.values.get('navigation.state') ?? state
        const lights = t.values.get('navigation.lights')
        const at = `${r.soak.name} at ${new Date(t.ms).toISOString()} (${state}, sun ${t.sunDeg.toFixed(2)}°)`
        expect(lights, at).to.be.a('string')
        seen.add(lights)
        if (t.lightsFault) {
          expect(lights, at).to.equal('fault')
          continue
        }
        expect(lights, at).to.not.equal('fault')
        // never lit by day, nor alongside
        if (t.sunDeg > SUNSET_DEG + SUNSET_MARGIN_DEG || state === 'moored')
          expect(lights, at).to.equal('off')
        // always lit at night, at anchor and under way
        if (t.sunDeg < SUNSET_DEG - SUNSET_MARGIN_DEG && state !== 'moored')
          expect(lights, at).to.equal(
            state === 'anchored'
              ? 'anchored'
              : t.summary.sailing
                ? 'sailing'
                : 'motoring'
          )
      }
      expect(seen.has('off'), r.soak.name).to.equal(true)
      // a try at failing them by day is refused; the first after dusk takes
      const raised = r.lightsTries.filter((x) => x.raised)
      expect(raised, r.soak.name).to.have.length(1)
      expect(raised[0].sunDeg, r.soak.name).to.be.below(
        SUNSET_DEG + SUNSET_MARGIN_DEG
      )
      for (const x of r.lightsTries.filter((y) => !y.raised))
        expect(x.sunDeg, r.soak.name).to.be.above(
          SUNSET_DEG - SUNSET_MARGIN_DEG
        )
      expect(
        r.notes.filter(
          (n) => n.path === LIGHTS_ALARM && n.value.state === 'alarm'
        ).length,
        r.soak.name
      ).to.be.above(0)
      expect(r.ticks.some((t) => t.lightsFault)).to.equal(true)
    })
  )

  it(
    'pays out the chain the scope calls for on the windlass, and none under way',
    each((r) => {
      const p = r.soak.profile
      let state: unknown
      let anchoredTicks = 0
      let ran = 0
      let previous: number | undefined
      for (const t of r.ticks) {
        state = t.values.get('navigation.state') ?? state
        const chain = num(t, 'navigation.anchor.rodeCounterLength')
        const windlass = num(t, 'electrical.switches.windlass.state')
        if (!p.windlass) {
          expect(chain, r.soak.name).to.equal(undefined)
          expect(windlass, r.soak.name).to.equal(undefined)
          continue
        }
        const at = `${r.soak.name} at ${new Date(t.ms).toISOString()}`
        expect(chain, at).to.be.a('number')
        if (state !== 'anchored') expect(chain, at).to.equal(0)
        // the windlass runs only while the chain moves
        if (windlass === 1 && previous !== undefined)
          expect(chain, at).to.not.equal(previous)
        if (windlass === 1) ran++
        const anchor = t.values.get('navigation.anchor.position') as
          { altitude: number } | undefined
        if (state === 'anchored' && windlass === 0 && anchor) {
          // lying to her anchor, the chain out is the scope: five times the depth there
          // and the bow's height, unless she is heaving in to leave
          anchoredTicks++
          const full = SCOPE * (-anchor.altitude + 0.08 * p.lengthM)
          expect(chain! <= full + CHAIN_ROUNDING_M, at).to.equal(true)
        }
        previous = chain
      }
      const anchors = r.soak.route.waypoints.some((w) => w.anchor)
      if (p.windlass && anchors) {
        expect(anchoredTicks, r.soak.name).to.be.above(0)
        expect(ran, r.soak.name).to.be.above(0)
        const house =
          r.books.banks.find((b) => b.id === 'house') ?? r.books.banks[0]
        expect(house.outJ.windlass, r.soak.name).to.be.above(0)
      }
    })
  )

  it(
    'trims only an outboard: tilted up alongside, down to leave and come in',
    each((r) => {
      const outboards = new Set(
        r.soak.profile.engines
          .filter((e) => e.drive === 'outboard')
          .map((e) => e.id)
      )
      for (const t of r.ticks) {
        for (const [key, v] of t.values) {
          const m = /^propulsion\.(\w+)\.drive\./.exec(key)
          if (!m) continue
          expect(outboards.has(m[1]), `${r.soak.name}: ${key}`).to.equal(true)
          if (key.endsWith('.trimState') && t.atBerth)
            expect(v, `${r.soak.name}: ${key} alongside`).to.equal(1)
        }
      }
      for (const id of outboards) {
        const trims = r.ticks
          .map((t) => t.values.get(`propulsion.${id}.drive.trimState`))
          .filter((x): x is number => typeof x === 'number')
        expect(Math.min(...trims), r.soak.name).to.equal(0)
        expect(Math.max(...trims), r.soak.name).to.equal(1)
      }
    })
  )

  it(
    'works the stabilisers only on the two yachts, and they cut the roll',
    each((r) => {
      const p = r.soak.profile
      const on = r.ticks.filter(
        (t) => num(t, 'electrical.switches.stabilisers.state') === 1
      )
      if (!p.stabilisers) {
        expect(
          r.ticks.some((t) =>
            t.values.has('electrical.switches.stabilisers.state')
          ),
          r.soak.name
        ).to.equal(false)
        return
      }
      expect(on.length, r.soak.name).to.be.above(30)
      // the same day without them, for the roll they take out
      const bare = run({ ...r.soak, profile: { ...p, stabilisers: undefined } })
      const rms = (ticks: Tick[]) => {
        const rolls = ticks
          .map((t) => t.values.get('navigation.attitude') as { roll: number })
          .filter(Boolean)
          .map((a) => a.roll)
        return Math.sqrt(rolls.reduce((a, x) => a + x * x, 0) / rolls.length)
      }
      const when = new Set(on.map((t) => t.ms))
      const ratio = rms(on) / rms(bare.ticks.filter((t) => when.has(t.ms)))
      console.log(
        `${r.soak.name}: stabilisers on ${on.length} of ${r.ticks.length} ticks, the roll then ${(100 * ratio).toFixed(0)} % of what it is without them`
      )
      expect(ratio, r.soak.name).to.be.below(0.5)
    })
  )

  it(
    'transmits on each radar only under way',
    each((r) => {
      let state: unknown
      for (const t of r.ticks) {
        state = t.values.get('navigation.state') ?? state
        for (const radar of r.soak.profile.radars) {
          const v = num(t, `electrical.switches.${radar.id}.state`)
          const want = state === 'sailing' || state === 'motoring' ? 1 : 0
          expect(v, `${r.soak.name} ${radar.id} ${state}`).to.equal(want)
        }
      }
    })
  )

  it("sails the Saronic passage's afternoon and motors its morning", () => {
    const r = [...results.values()].find(
      (x) =>
        x.soak.sample === 'saronic-gulf-2018-07-13' && x.soak.pilot === 'route'
    )
    if (!r) return
    const start = r.ticks[0].ms
    const underWay = (t: Tick) =>
      t.summary.sails?.propulsion !== null &&
      t.summary.sails?.propulsion !== undefined
    // by local solar time: the first afternoon, and the next morning
    const afternoon = r.ticks.filter(
      (t) =>
        underWay(t) &&
        t.hour >= 12.5 &&
        t.hour < 15 &&
        t.ms < start + 12 * HOUR_MS
    )
    const morning = r.ticks.filter(
      (t) =>
        underWay(t) &&
        t.hour >= 3.5 &&
        t.hour < 7.5 &&
        t.ms > start + 12 * HOUR_MS
    )
    const share = (ts: Tick[], p: string[]) =>
      ts.filter((t) => p.includes(t.summary.sails!.propulsion!)).length /
      ts.length
    console.log(
      `Saronic passage: the afternoon ${(100 * share(afternoon, ['sailing'])).toFixed(0)} % under sail and ${(100 * share(afternoon, ['motor-sailing'])).toFixed(0)} % motor-sailing; the morning ${(100 * share(morning, ['motoring', 'motor-sailing'])).toFixed(0)} % with the engine on`
    )
    expect(afternoon.length).to.be.above(30)
    expect(morning.length).to.be.above(30)
    // the afternoon's northerly is light, 4 to 7 kn: her sails are set for most of it, and
    // she sails on them alone some of the time; the morning's legs run dead to windward
    expect(share(afternoon, ['sailing', 'motor-sailing'])).to.be.above(0.5)
    expect(share(afternoon, ['sailing'])).to.be.above(
      share(morning, ['sailing']) + 0.1
    )
    expect(share(morning, ['motoring', 'motor-sailing'])).to.be.above(0.9)
  })

  it('follows the tide on the Miami depth through the day', () => {
    const miami = [...results.values()].filter(
      (r) => r.soak.sample === 'miami-icw-2024-03-16'
    )
    expect(miami.length).to.be.above(0)
    for (const r of miami) {
      const env = r.soak.environment!
      const pairs = r.ticks
        .map((t) => {
          const sounder = r.soak.profile.sounders[0]
          const depth = num(t, `${sounder.id}:environment.depth.belowSurface`)
          const grid = SEABED.depth(t.lat, t.lon)
          const level = env.value('waterLevelM', t.lat, t.lon, t.ms)
          return depth === undefined ||
            grid === undefined ||
            level === undefined
            ? undefined
            : { offset: depth - grid, level }
        })
        .filter((p): p is { offset: number; level: number } => p !== undefined)
      expect(pairs.length, r.soak.name).to.be.above(1000)
      // what the sounder reads over the seabed is the water level, give or take its own
      // bias, drift and its offset across the boat
      for (const p of pairs)
        expect(p.offset, r.soak.name).to.be.closeTo(p.level, 0.25)
      const levels = pairs.map((p) => p.level)
      expect(
        Math.max(...levels) - Math.min(...levels),
        r.soak.name
      ).to.be.above(0.4)
      expect(
        spearman(
          pairs.map((p) => p.level),
          pairs.map((p) => p.offset)
        ),
        r.soak.name
      ).to.be.above(0.9)
    }
  })

  it(
    'lies to her anchor at every anchorage, inside its radius, and weighs it',
    each((r) => {
      const legs = routeLegs(r.soak.route)
      const anchorages = r.soak.route.waypoints.filter((w) => w.anchor).length
      if (!anchorages) return
      const anchored = r.ticks.filter(
        (t) => t.values.get('navigation.state') === 'anchored'
      )
      expect(anchored.length, r.soak.name).to.be.above(0)
      for (const t of anchored) {
        const at = `${r.soak.name} ${new Date(t.ms).toISOString()}`
        const anchor = t.values.get('navigation.anchor.position')
        expect(anchor, at).to.be.an('object')
        expect(t.sogKn, at).to.be.below(1)
        expect(num(t, 'navigation.anchor.currentRadius'), at).to.be.at.most(
          num(t, 'navigation.anchor.maxRadius')!
        )
      }
      // each one weighed on leaving clears the anchor's values once
      const weighed = legs.filter(
        (l) => l.from.anchor && l.departMs < r.ticks.at(-1)!.ms
      ).length
      const cleared = r.ticks.filter(
        (t) => t.values.get('navigation.anchor.position') === null
      ).length
      expect(cleared, r.soak.name).to.equal(weighed)
      const alarms = r.notes.filter((n) => n.path === ANCHOR_ALARM)
      for (const n of alarms) {
        expect(n.value.method, r.soak.name).to.deep.equal(
          n.value.state === 'normal' ? [] : ['visual', 'sound']
        )
      }
      if (!r.dragged) expect(alarms, r.soak.name).to.deep.equal([])
    })
  )

  it('runs a tank low or fills one on a day out, and says so', () => {
    const tanks = [...results.values()].flatMap((r) =>
      r.notes
        .filter((n) => SEVERE.has(n.value.state) && n.path.startsWith('tanks.'))
        .map((n) => `${r.soak.name}: ${n.value.message}`)
    )
    expect(tanks).to.not.deep.equal([])
  })

  it(
    'charges from the wind turbine as the wind blows',
    each((r) => {
      if (!r.soak.profile.windTurbines.length) return
      // below its cut-in it gives nothing, checked tick by tick here; above it, it follows the
      // apparent wind while the bank takes what it gives
      const charging = r.ticks.filter(
        (t) => (t.summary.houseSoc ?? 1) < 0.95 && t.summary.apparentWindMs >= 3
      )
      for (const t of r.ticks) {
        if (t.summary.apparentWindMs < 3) expect(t.summary.turbineW).to.equal(0)
      }
      expect(charging.length, `${r.soak.name} time below full`).to.be.above(20)
      const rho = spearman(
        charging.map((t) => t.summary.apparentWindMs),
        charging.map((t) => t.summary.turbineW)
      )
      expect(rho, `${r.soak.name} turbine against wind`).to.be.above(0.9)
    })
  )
  it(
    'sends every switch the profile has, by name and on its bank channel, named in metadata',
    each((r) => {
      const p = r.soak.profile
      const channels = bankChannels(p)
      const list = switchList(p).filter((x) => x.id !== 'bilgePump')
      for (const t of r.ticks) {
        for (const sw of list) {
          const v = num(t, switchPath(sw.id))
          const at = `${r.soak.name} ${sw.id} ${new Date(t.ms).toISOString()}`
          expect(v, at).to.be.oneOf([0, 1])
          expect(num(t, bankPath(channels.get(sw.id)!)), at).to.equal(v)
        }
      }
      for (const sw of switchList(p)) {
        const n = channels.get(sw.id)!
        for (const at of [
          `electrical.switches.${sw.id}`,
          switchPath(sw.id),
          `electrical.switches.bank.0.${n}`,
          bankPath(n)
        ])
          expect(r.meta.get(at)?.displayName, `${r.soak.name} ${at}`).to.equal(
            sw.displayName
          )
      }
    })
  )

  it(
    'keeps the bank numbering through a restart from the saved systems',
    each((r) => {
      const p = r.soak.profile
      const channels = bankChannels(p)
      const again = shortRun(r.soak, r.half.ms, 3, {
        systemsState: r.half.systems
      })
      const meta = new Map(
        again.sent
          .flatMap((d) => d.updates.flatMap((u) => u.meta ?? []))
          .map((m) => [m.path, m.value.displayName])
      )
      for (const [id, n] of channels) {
        expect(meta.get(bankPath(n)), `${r.soak.name} ${id}`).to.equal(
          r.meta.get(bankPath(n))?.displayName
        )
        if (id === 'bilgePump') continue
        for (const values of again.ticks)
          expect(values.get(bankPath(n)), `${r.soak.name} ${id}`).to.equal(
            values.get(switchPath(id))
          )
      }
    })
  )

  it(
    'refuses the windlass under way and a radar alongside, every time',
    each((r) => {
      const p = r.soak.profile
      expect(r.refusals.taken, r.soak.name).to.deep.equal([])
      if (p.windlass || p.radars.length)
        expect(r.refusals.tried, r.soak.name).to.be.above(10)
    })
  )

  it(
    'lets the fridges and freezers warm while switched off, and brings them back switched on',
    each((r) => {
      const p = r.soak.profile
      const kinds = (['fridge', 'freezer'] as const).filter((k) =>
        p.zones.some((z) => z.kind === k)
      )
      if (!kinds.length) return
      const OFF_MIN = 180
      const ON_MIN = 240
      const short = shortRun(
        r.soak,
        r.half.ms,
        OFF_MIN + ON_MIN,
        {},
        (sim, minute) => {
          for (const k of kinds) {
            if (minute === 1) sim.systems!.putSwitch(k, false)
            if (minute === OFF_MIN + 1) sim.systems!.putSwitch(k, true)
          }
        }
      )
      const tempAt = (id: string, minute: number) => {
        for (let i = minute - 1; i >= 0; i--) {
          const v = short.ticks[i].get(`environment.inside.${id}.temperature`)
          if (typeof v === 'number') return v - KELVIN
        }
        return NaN
      }
      for (const z of p.zones.filter((x) => kinds.includes(x.kind as never))) {
        const at = `${r.soak.name} ${z.id}`
        const warmest = tempAt(z.id, OFF_MIN)
        const coldest = tempAt(z.id, OFF_MIN + ON_MIN)
        expect(short.ticks[OFF_MIN - 1].get(switchPath(z.kind)), at).to.equal(0)
        expect(
          short.ticks[OFF_MIN + ON_MIN - 1].get(switchPath(z.kind)),
          at
        ).to.equal(1)
        expect(warmest, at).to.be.above(z.setpointC + 8)
        expect(coldest, at).to.be.below(z.setpointC + 3)
      }
    })
  )

  it(
    "stands the inverter by with a generator running or on shore power, and its AC is the books' inverter output",
    each((r) => {
      const p = r.soak.profile
      if (!hasInverter(p)) {
        expect(
          r.ticks.some((t) => t.summary.inverter !== undefined),
          r.soak.name
        ).to.equal(false)
        return
      }
      let state: unknown
      let acJ = 0
      const modes = new Set<unknown>()
      for (const t of r.ticks) {
        state = t.values.get('navigation.state') ?? state
        const mode = t.values.get('electrical.inverters.inverter.inverterMode')
        modes.add(mode)
        const at = `${r.soak.name} ${new Date(t.ms).toISOString()}`
        if (state === 'moored' || t.summary.generatorsRunning > 0)
          expect(mode, at).to.equal('standby')
        else expect(mode, at).to.be.oneOf(['inverting', 'idle'])
        acJ += (t.summary.inverter!.acW * (TICK_MS * TIME_MULTIPLIER)) / 1000
      }
      expect(modes.has('standby'), r.soak.name).to.equal(true)
      expect(modes.has('inverting'), r.soak.name).to.equal(true)
      const bank = r.books.banks.find(
        (b) => b.id === r.ticks[0].summary.inverter!.bank
      )!
      const drawnJ = bank.outJ.inverter ?? 0
      console.log(
        `${r.soak.name}: inverter carried ${(acJ / 3.6e6).toFixed(2)} kWh AC for ${(drawnJ / 3.6e6).toFixed(2)} kWh off the ${bank.id} bank`
      )
      expect(acJ, r.soak.name).to.be.closeTo(0.9 * drawnJ, 0.05 * drawnJ)
    })
  )

  it(
    'observes, through the Weather API, what the instruments showed at that moment',
    each((r) => {
      const env = r.soak.environment
      if (!env) return
      const problems: string[] = []
      let windDiffKn = 0
      let dirDiffS = 0
      let dirDiffC = 0
      let windTicks = 0
      for (const t of r.ticks.filter((_, i) => i % 15 === 0)) {
        const weather = new SampleWeather(env, () => t.ms, r.soak.sample)
        const [obs] = weather.getObservations(
          { latitude: t.lat, longitude: t.lon },
          { maxCount: 1 }
        )
        if (!obs) continue
        expect(obs.date).to.equal(new Date(t.ms).toISOString())
        const near = (path: string, value: number | undefined, tol: number) => {
          const sent = t.values.get(path)
          if (typeof sent !== 'number' || value === undefined) return
          if (Math.abs(sent - value) > tol && problems.length < 10)
            problems.push(
              `${new Date(t.ms).toISOString()} ${path}: sent ${sent}, observed ${value}`
            )
        }
        near('environment.outside.temperature', obs.outside?.temperature, 0.05)
        near('environment.outside.pressure', obs.outside?.pressure, 5)
        near(
          'environment.outside.relativeHumidity',
          obs.outside?.relativeHumidity,
          0.005
        )
        near('environment.water.temperature', obs.water?.temperature, 0.05)
        near('environment.tide.heightNow', obs.water?.level, 0.005)
        // the instruments' wind is the sample's with the seed's gusts and shifts on it
        const speed = t.values.get('environment.wind.speedTrue')
        const dir = t.values.get('environment.wind.directionTrue')
        if (
          typeof speed === 'number' &&
          typeof dir === 'number' &&
          obs.wind?.speedTrue !== undefined &&
          obs.wind.directionTrue !== undefined
        ) {
          windTicks++
          windDiffKn += (speed - obs.wind.speedTrue) / KNOT_MS
          if (obs.wind.speedTrue > 3 * KNOT_MS) {
            dirDiffS += Math.sin(dir - obs.wind.directionTrue)
            dirDiffC += Math.cos(dir - obs.wind.directionTrue)
          }
        }
      }
      expect(problems, r.soak.name).to.deep.equal([])
      // a boat with no wind instrument sends none to compare
      if (!r.ticks.some((t) => t.values.has('environment.wind.speedTrue')))
        return
      expect(windTicks, r.soak.name).to.be.above(10)
      expect(Math.abs(windDiffKn / windTicks), r.soak.name).to.be.below(1.5)
      expect(
        Math.abs(Math.atan2(dirDiffS, dirDiffC)) / RAD,
        r.soak.name
      ).to.be.below(15)
    })
  )

  it(
    'forecasts on the hour in order, a day at a time a day apart, and warns only where the record has the wind for it',
    each((r) => {
      const env = r.soak.environment
      if (!env) return
      for (const t of [r.ticks[0], r.ticks[Math.floor(r.ticks.length / 2)]]) {
        const at = { latitude: t.lat, longitude: t.lon }
        const weather = new SampleWeather(env, () => t.ms, r.soak.sample)
        const points = weather.getForecasts(at, 'point')
        for (let i = 1; i < points.length; i++)
          expect(
            Date.parse(points[i].date) - Date.parse(points[i - 1].date)
          ).to.equal(HOUR_MS)
        const days = weather.getForecasts(at, 'daily')
        for (let i = 1; i < days.length; i++)
          expect(
            Date.parse(days[i].date) - Date.parse(days[i - 1].date)
          ).to.equal(DAY_MS)
        // the wind ahead, looked at independently every five minutes
        const end = env.span()!.endMs
        const strong: [number, number][] = []
        let from: number | undefined
        let last = t.ms
        for (let ms = t.ms; ms <= end; ms += 5 * 60_000) {
          const kn = env.at(t.lat, t.lon, ms).windKn ?? 0
          if (kn >= STRONG_WIND_KN) {
            from ??= ms
            last = ms
          } else if (from !== undefined) {
            strong.push([from, last])
            from = undefined
          }
        }
        if (from !== undefined) strong.push([from, last])
        const warnings = weather.getWarnings(at)
        const long = strong.filter(([a, b]) => b - a >= HOUR_MS)
        expect(warnings.length, r.soak.name).to.be.at.most(long.length)
        for (const w of warnings) {
          expect(
            Date.parse(w.endTime) - Date.parse(w.startTime)
          ).to.be.at.least(HOUR_MS)
          for (
            let ms = Date.parse(w.startTime);
            ms <= Date.parse(w.endTime);
            ms += 10 * 60_000
          )
            expect(env.at(t.lat, t.lon, ms).windKn!).to.be.at.least(
              STRONG_WIND_KN
            )
        }
        if (!long.length) expect(warnings, r.soak.name).to.deep.equal([])
      }
    })
  )

  const eachAsync = (fn: (r: CaseResult) => Promise<void>) => async () => {
    for (const r of results.values()) await fn(r)
  }

  it(
    'records every path the boat sent, and gives the sent values back through the History API at the resolution asked',
    eachAsync(async (r) => {
      const from = r.record.startMs!
      const to = r.record.endMs! + RECORD_STEP_MS
      const kept = r.ticks.filter((t) => t.ms >= from)
      const sent = new Set<string>()
      for (const t of kept) for (const p of recordedPaths(t).keys()) sent.add(p)
      expect(r.record.ownPaths(from, to), r.soak.name).to.include.members([
        ...sent
      ])
      const paths = [
        'navigation.speedOverGround',
        'navigation.position',
        'environment.outside.pressure'
      ]
      // a tick a minute: each minute's bucket holds that tick's values, whatever the method
      const byMinute = new Map(
        kept.map((t) => [slotOf(t.ms), recordedPaths(t)])
      )
      for (const method of ['average', 'first', 'last'] as const) {
        const v = await historyOf(r).getValues({
          from: { epochMilliseconds: from },
          to: { epochMilliseconds: to },
          resolution: 60,
          pathSpecs: paths.map((path) => ({
            path,
            aggregate: method,
            parameter: []
          }))
        })
        let compared = 0
        for (const row of v.data) {
          const tick = byMinute.get(Date.parse(row[0] as string))
          if (!tick) continue
          paths.forEach((p, i) => {
            const sentValue = tick.get(p)
            if (sentValue === undefined) return
            compared++
            expect(
              row[i + 1],
              `${r.soak.name} ${p} ${method} ${row[0]}`
            ).to.deep.equal(sentValue)
          })
        }
        expect(compared, r.soak.name).to.be.above(kept.length)
      }
    })
  )

  it(
    "averages a five-minute bucket of the boat's speed as the five ticks in it average",
    eachAsync(async (r) => {
      const from = r.record.startMs!
      const v = await historyOf(r).getValues({
        from: { epochMilliseconds: from },
        to: { epochMilliseconds: from + 6 * HOUR_MS },
        resolution: 300,
        pathSpecs: [
          {
            path: 'navigation.speedOverGround',
            aggregate: 'average',
            parameter: []
          }
        ]
      })
      for (const row of v.data) {
        const start = Date.parse(row[0] as string)
        const xs = r.ticks
          .filter(
            (t) => slotOf(t.ms) >= start && slotOf(t.ms) < start + 300_000
          )
          .map((t) => t.values.get('navigation.speedOverGround'))
          .filter((x): x is number => typeof x === 'number')
        if (!xs.length) expect(row[1]).to.equal(null)
        else
          expect(row[1] as number, r.soak.name).to.be.closeTo(
            xs.reduce((a, b) => a + b, 0) / xs.length,
            1e-9
          )
      }
    })
  )

  let largestRecord = { name: '', paths: 0, bytes: 0 }
  it(
    'keeps the record through a resume, and holds a day of the boat within its bound',
    each((r) => {
      // the record saved halfway, read back as a resume reads it, holds what was sent
      const resumed = RunRecord.restore(r.recordHalf, r.soak.sample)!
      const rows = resumed.ownRows(-Infinity, Infinity)
      expect(rows.length, r.soak.name).to.be.above(100)
      expect(rows.at(-1)!.ms, r.soak.name).to.equal(
        r.half.ms - (r.half.ms % RECORD_STEP_MS)
      )
      const byMs = new Map(r.ticks.map((t) => [slotOf(t.ms), recordedPaths(t)]))
      let compared = 0
      for (const row of rows) {
        const tick = byMs.get(row.ms)
        if (!tick) continue
        for (const p of ['navigation.speedOverGround', 'navigation.position']) {
          if (!tick.has(p)) continue
          compared++
          expect(row.value(p), r.soak.name).to.deep.equal(tick.get(p))
        }
      }
      expect(compared, r.soak.name).to.be.above(rows.length)
      expect(r.record.endMs! - r.record.startMs!, r.soak.name).to.be.below(
        RECORD_ROWS * RECORD_STEP_MS
      )
      const paths = r.record.ownPathNames.length
      expect(r.record.bytes, r.soak.name).to.be.at.most(recordBoundBytes(paths))
      if (r.record.bytes > largestRecord.bytes)
        largestRecord = { name: r.soak.name, paths, bytes: r.record.bytes }
    })
  )

  it('reports the largest record', () => {
    console.log(
      `largest record: ${largestRecord.name}, ${largestRecord.paths} paths, ${(largestRecord.bytes / 1048576).toFixed(1)} MiB for a day`
    )
  })

  it(
    'raises a person overboard through the Notifications API at emergency, and nothing else',
    each((r) => {
      const emitted: Delta[] = []
      let position: unknown
      let sim: Simulation | undefined
      const manager = new NotificationManager({
        // the manager sends its alarm object itself, which it changes as it clears
        handleMessage: (_id: string, d: Delta) =>
          emitted.push(structuredClone(d)),
        get signalk() {
          return { self: { navigation: { position: { value: position } } } }
        }
      } as unknown as NotificationApplication)
      const from = r.ticks[60].ms
      const boatNotes = (sent: Delta[]) =>
        sent
          .flatMap((d) => d.updates.flatMap((u) => u.values))
          .filter((v) => v.path.startsWith('notifications.'))
          .map((v) => JSON.stringify(v))
      const plain = shortRun(r.soak, from, 20)
      const overboard = shortRun(
        r.soak,
        from,
        20,
        {
          mob: {
            raise: (message) => manager.mob(message),
            resolve: (id) => manager.clear(id as never)
          }
        },
        (s, minute) => {
          sim = s
          const p = s.last?.position
          if (p) position = { latitude: p.lat, longitude: p.lon }
          if (minute === 3) s.faults!.raise('personOverboard')
          if (minute === 15) s.faults!.clear('personOverboard', 'crew')
        }
      )
      expect(boatNotes(overboard.sent), r.soak.name).to.deep.equal(
        boatNotes(plain.sent)
      )
      const mob = emitted
        .flatMap((d) => d.updates.flatMap((u) => u.values))
        .filter((v) => v.path.startsWith('notifications.mob.'))
      expect(mob.length, r.soak.name).to.equal(2)
      expect((mob[0].value as { state: string }).state).to.equal('emergency')
      expect((mob[1].value as { state: string }).state).to.equal('normal')
      expect(Object.keys(manager.list).length, r.soak.name).to.equal(1)
      expect(sim!.mobs(), r.soak.name).to.deep.equal([])
    })
  )

  it('publishes resources on or beside each sample route', async function () {
    this.timeout(60000)
    const near = (a: Point, b: Point) =>
      Math.hypot(
        (a.lat - b.lat) * METRES_PER_DEG,
        (a.lon - b.lon) * METRES_PER_DEG * Math.cos(a.lat * (Math.PI / 180))
      )
    const toLeg = (p: Point, a: Point, b: Point) => {
      const cos = Math.cos(a.lat * (Math.PI / 180))
      const bx = (b.lon - a.lon) * METRES_PER_DEG * cos
      const by = (b.lat - a.lat) * METRES_PER_DEG
      const px = (p.lon - a.lon) * METRES_PER_DEG * cos
      const py = (p.lat - a.lat) * METRES_PER_DEG
      const len2 = bx * bx + by * by
      const t = len2 ? Math.max(0, Math.min(1, (px * bx + py * by) / len2)) : 0
      return Math.hypot(px - t * bx, py - t * by)
    }
    for (const sample of listSamples(SAMPLES)) {
      const scenario = await loadScenario(SAMPLES, sample, {
        minDepthUnderKeelM: DEFAULT_MIN_DEPTH_UNDER_KEEL_M,
        receiverAntennaHeightM: DEFAULT_RECEIVER_ANTENNA_HEIGHT_M
      })
      const r = sampleResources(scenario.plannedRoute, scenario.route)
      const points = scenario.route.waypoints
      const onRoute = (p: Point) =>
        Math.min(...points.map((w) => near(p, w))) < 1
      for (const w of r.waypoints) {
        const [lon, lat] = w.value.feature.geometry.coordinates
        expect(onRoute({ lat, lon }), `${sample} ${w.value.name}`).to.equal(
          true
        )
      }
      for (const n of r.notes) {
        const { latitude: lat, longitude: lon } = n.value.position
        expect(onRoute({ lat, lon }), `${sample} ${n.value.name}`).to.equal(
          true
        )
      }
      const slow: [Point, Point][] = []
      for (let i = 0; i < points.length - 1; i++)
        if (points[i].speedKn! <= DEAD_SLOW_KN)
          slow.push([points[i], points[i + 1]])
      let farthest = 0
      for (const region of r.regions) {
        for (const [lon, lat] of region.value.feature.geometry.coordinates[0]) {
          const m = Math.min(...slow.map(([a, b]) => toLeg({ lat, lon }, a, b)))
          farthest = Math.max(farthest, m)
          expect(m, `${sample} ${region.value.name}`).to.be.at.most(150)
        }
      }
      console.log(
        `${sample}: ${countWords(resourceCounts(r))}, region corners at most ${farthest.toFixed(0)} m from their legs`
      )
    }
  })
})
