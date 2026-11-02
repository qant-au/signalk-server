/**
 * The systems soak: every vessel profile run for days of scenario time on the
 * controllable clock, checking that what the boat sends stays believable. It is not part
 * of `npm test`; run it with `npm run test:simulator-soak`. See README.md.
 */
import { expect } from 'chai'
import path from 'path'
import { DepthModel } from '../depth/depth'
import { Simulation } from '../engine/simulation'
import { Scenario } from '../engine/scenario'
import { Route, Waypoint, loadRoute, routeLegs } from '../routes/route'
import { VariationGrid, loadVariation } from '../systems/magnetic'
import { EnergyBooks, STEP_S, SystemsSummary } from '../systems/model'
import { solarHour, sunElevation } from '../systems/sun'
import { VesselProfile, listProfiles, loadProfile } from '../vessels/profile'
import { Delta } from './deltas'

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
}

interface CaseResult {
  soak: SoakCase
  ticks: Tick[]
  deltas: number
  invalid: string[]
  books: EnergyBooks
  /** the fuel rates sent, integrated over the run, litres */
  sentFuelL: number
}

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
      variation: loadVariation(path.join(SAMPLES, sample))
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
      variation: loadVariation(path.join(SAMPLES, sample))
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
      variation: loadVariation(path.join(SAMPLES, other.sample))
    })
  }
  return out
}

function validationProblems(delta: Delta, mmsi: string): string[] {
  const d = { ...delta, context: `vessels.urn:mrn:imo:mmsi:${mmsi}` }
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

function run(soak: SoakCase): CaseResult {
  const legs = routeLegs(soak.route)
  const scenario: Scenario = {
    sampleId: soak.name,
    route: soak.route,
    plannedRoute: soak.route,
    legs,
    adjustments: [],
    depth: SEABED,
    variation: soak.variation,
    profile: soak.profile,
    notes: []
  }
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
      seed: SEED
    },
    (d) => pending.push(d),
    0
  )
  const tickCount = (soak.hours * HOUR_MS) / (TICK_MS * TIME_MULTIPLIER)
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
    check(pending)
    const values = new Map<string, unknown>()
    let main: Set<string> | undefined
    for (const d of pending) {
      for (const u of d.updates) {
        for (const v of u.values) {
          const key = u.source.src ? `${u.source.src}:${v.path}` : v.path
          values.set(key, v.value)
        }
        if (u.values.some((v) => v.path === 'navigation.speedThroughWater')) {
          main = new Set(u.values.map((v) => v.path))
        }
      }
    }
    pending = []
    const p = result.position
    ticks.push({
      ms: result.scenarioMs,
      lat: p.lat,
      lon: p.lon,
      sogKn: p.sogKn,
      sunDeg: (sunElevation(result.scenarioMs, p.lat, p.lon) * 180) / Math.PI,
      hour: solarHour(result.scenarioMs, p.lon),
      atBerth:
        !p.anchored && (p.finished || result.scenarioMs < legs[0].departMs),
      summary: sim.systems!.summary(),
      values,
      main,
      slow: main?.has('environment.outside.temperature') ?? false
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
    sentFuelL
  }
}

type Band = [number, number]

/** the band a value of this path must stay in, or undefined for a path with no band */
function band(p: VesselProfile, key: string): Band | 'string' | undefined {
  const pathOnly = key.includes(':') ? key.split(':')[1] : key
  const m = (re: RegExp) => re.exec(pathOnly)
  const unit = (id: string) =>
    p.engines.find((e) => e.id === id) ?? p.generators.find((g) => g.id === id)
  let r: RegExpExecArray | null
  if ((r = m(/^propulsion\.(\w+)\.(.+)$/))) {
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
    // the water speed is the ground speed less a current of at most a knot
    'navigation.speedThroughWater': [0, (p.maxSpeedKn + 1) * KNOT_MS * 1.01],
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
    'navigation.datetime': 'string'
  }
  return fixed[pathOnly]
}

/** paths that are sent only some of the time */
const CONDITIONAL = [
  /\.capacity\.timeRemaining$/,
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
        'fuel left': fuelL
          ? `${Math.round((100 * last.fuelL) / fuelL)} % (from ${Math.round((100 * first.fuelL) / fuelL)} %)`
          : '-'
      }
    })
    console.table(rows)
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
          if (key === '' || key.startsWith('design.')) continue
          if (key === 'navigation.attitude') {
            for (const [axis, angle] of Object.entries(
              value as Record<string, number>
            )) {
              const b = band(r.soak.profile, `${key}.${axis}`)
              if (
                !Array.isArray(b) ||
                !Number.isFinite(angle) ||
                angle < b[0] ||
                angle > b[1]
              )
                report(`${key}.${axis} = ${angle}`)
            }
            continue
          }
          if (key === 'navigation.position') {
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
    'charges from the wind turbine as the wind blows',
    each((r) => {
      if (!r.soak.profile.windTurbines.length) return
      const charging = r.ticks.filter((t) => (t.summary.houseSoc ?? 1) < 0.95)
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
})
