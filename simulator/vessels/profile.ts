import { readFileSync, readdirSync } from 'fs'
import path from 'path'

/**
 * A vessel profile: what is on board, from which the systems model produces data. Counts
 * that a profile leaves out are filled in from the boat's length (see `resolveProfile` and
 * README.md); counts it gives are used as they are, up to the most a profile may have.
 */
export type EngineType = 'diesel' | 'petrol' | 'hybrid' | 'electric'
export type TankType = 'fuel' | 'freshWater' | 'wasteWater' | 'blackWater'
export type Chemistry = 'LiFePO4' | 'AGM' | 'FLA'

export interface EngineProfile {
  id: string
  displayName: string
  type: EngineType
  /** rated power of the combustion engine, or of the motor for an electric drive */
  powerKw: number
  maxRpm: number
  idleRpm: number
  /** hybrid only: rated power of the inline electric drive */
  electricKw?: number
  /** bank an electric or hybrid drive runs from; alternator target for diesels */
  bank?: string
  /** fuel tank the engine draws from */
  fuelTank?: string
}

export interface GeneratorProfile {
  id: string
  displayName: string
  powerKw: number
  /** 1500 rpm for 50 Hz, 1800 rpm for 60 Hz */
  rpm: number
  fuelTank?: string
  /** bank its charger feeds */
  chargesBank?: string
}

export interface BankProfile {
  id: string
  displayName: string
  nominalVoltage: number
  capacityAh: number
  chemistry: Chemistry
  role: 'house' | 'start' | 'propulsion'
}

export interface SolarProfile {
  id: string
  displayName: string
  peakW: number
  bank: string
}

export interface WindTurbineProfile {
  id: string
  displayName: string
  ratedW: number
  bank: string
}

export interface TankProfile {
  id: string
  displayName: string
  capacityL: number
  /** fuel only: a day tank, topped up from the storage tanks by a transfer pump */
  dayTank?: boolean
}

export interface SounderProfile {
  id: string
  displayName: string
  /** transducer depth below the waterline, metres */
  depthM: number
  /** athwartships offset from the centreline, metres, positive to starboard */
  offsetM: number
}

export interface ZoneProfile {
  id: string
  displayName: string
  kind: 'living' | 'engineRoom' | 'fridge' | 'freezer'
  /** target temperature, degrees Celsius */
  setpointC: number
}

export interface VesselProfile {
  id: string
  name: string
  lengthM: number
  beamM: number
  draftM: number
  displacementT: number
  typeCode: number
  rig: 'motor' | 'sail'
  /** speed at full power, knots */
  maxSpeedKn: number
  acVoltage: number
  acFrequency: number
  acPhases: 1 | 3
  /** people aboard, for water use */
  persons: number
  /** water maker output, litres an hour; 0 for none */
  watermakerLph: number
  engines: EngineProfile[]
  generators: GeneratorProfile[]
  banks: BankProfile[]
  solar: SolarProfile[]
  windTurbines: WindTurbineProfile[]
  tanks: Record<TankType, TankProfile[]>
  sounders: SounderProfile[]
  radars: { id: string; displayName: string }[]
  wind: boolean
  zones: ZoneProfile[]
}

/** What a profile file may say; anything left out comes from the length. */
export type ProfileFile = Partial<Omit<VesselProfile, 'tanks'>> & {
  id: string
  name: string
  lengthM: number
  tanks?: Partial<Record<TankType, TankProfile[]>>
}

/** the most of each tank type a profile may have */
export const MAX_TANKS: Record<TankType, number> = {
  fuel: 8,
  freshWater: 4,
  wasteWater: 2,
  blackWater: 2
}
const TWIN_ENGINE_FROM_M = 10
const WATERMAKER_FROM_M = 12
/** water maker output per metre of length, litres an hour */
const WATERMAKER_LPH_PER_M = 5
/** the smallest holding tank fitted, litres */
const MIN_HOLDING_L = { wasteWater: 40, blackWater: 45 }
const GENERATOR_FROM_M = 10
const SOUNDER_DEPTH_M = 0.5
const SIDES = ['Port', 'Starboard']
/** generators sit under propulsion beside the main engines, told apart by their id */
const GENERATOR_ID = /^generator\d+$/

const round = (x: number, step: number) => Math.round(x / step) * step

/** total tankage by length: fitted to typical boats from 4 m to 45 m */
export function defaultCapacityL(type: TankType, lengthM: number): number {
  const fresh = Math.max(0, 0.28 * lengthM ** 2.86)
  switch (type) {
    case 'fuel':
      return round(Math.max(20, 0.019 * lengthM ** 3.93), 10)
    case 'freshWater':
      return round(fresh, 10)
    case 'wasteWater':
      return round(Math.max(MIN_HOLDING_L.wasteWater, fresh * 0.25), 5)
    case 'blackWater':
      return round(Math.max(MIN_HOLDING_L.blackWater, fresh * 0.15), 5)
  }
}

export function defaultTankCount(type: TankType, lengthM: number): number {
  switch (type) {
    case 'fuel':
      return lengthM < TWIN_ENGINE_FROM_M ? 1 : lengthM < 20 ? 2 : 4
    case 'freshWater':
      return lengthM < 6 ? 0 : lengthM < 15 ? 1 : 2
    case 'wasteWater':
      return lengthM < 10 ? 0 : lengthM < 25 ? 1 : 2
    case 'blackWater':
      return lengthM < 8 ? 0 : lengthM < 25 ? 1 : 2
  }
}

const TANK_LABEL: Record<TankType, string> = {
  fuel: 'fuel',
  freshWater: 'fresh water',
  wasteWater: 'grey water',
  blackWater: 'black water'
}

function defaultTanks(type: TankType, lengthM: number): TankProfile[] {
  const count = defaultTankCount(type, lengthM)
  const each = count ? round(defaultCapacityL(type, lengthM) / count, 5) : 0
  const label = TANK_LABEL[type]
  const capitalised = label[0].toUpperCase() + label.slice(1)
  return Array.from({ length: count }, (_, i) => ({
    id: count === 1 ? type : count === 2 ? type + SIDES[i] : type + (i + 1),
    displayName:
      count === 1
        ? capitalised
        : count === 2
          ? SIDES[i] + ' ' + label
          : capitalised + ' ' + (i + 1),
    capacityL: each
  }))
}

function defaultEngines(p: ProfileFile): EngineProfile[] {
  const twin = p.lengthM >= TWIN_ENGINE_FROM_M
  const powerKw = round(Math.max(4, 0.9 * p.lengthM ** 2), 5) / (twin ? 2 : 1)
  const base = {
    type: 'diesel' as EngineType,
    powerKw,
    maxRpm: powerKw > 500 ? 2100 : 3000,
    idleRpm: 700
  }
  return twin
    ? [
        { ...base, id: 'port', displayName: 'Port engine' },
        { ...base, id: 'starboard', displayName: 'Starboard engine' }
      ]
    : [{ ...base, id: 'main', displayName: 'Engine' }]
}

function defaultBanks(p: ProfileFile): BankProfile[] {
  const voltage = p.lengthM < 12 ? 12 : 24
  return [
    {
      id: 'house',
      displayName: 'House bank',
      nominalVoltage: voltage,
      capacityAh: round(10 * p.lengthM ** 1.5, 10),
      chemistry: 'LiFePO4',
      role: 'house'
    },
    {
      id: 'start',
      displayName: 'Start bank',
      nominalVoltage: voltage,
      capacityAh: p.lengthM < 12 ? 70 : 200,
      chemistry: 'AGM',
      role: 'start'
    }
  ]
}

function defaultZones(lengthM: number): ZoneProfile[] {
  if (lengthM < 6) return []
  const zones: ZoneProfile[] = [
    { id: 'saloon', displayName: 'Saloon', kind: 'living', setpointC: 22 },
    { id: 'fridge', displayName: 'Fridge', kind: 'fridge', setpointC: 4 }
  ]
  if (lengthM >= 9) {
    zones.push({
      id: 'cabin',
      displayName: 'Cabin',
      kind: 'living',
      setpointC: 21
    })
  }
  if (lengthM >= 12) {
    zones.push({
      id: 'engineRoom',
      displayName: 'Engine room',
      kind: 'engineRoom',
      setpointC: 30
    })
    zones.push({
      id: 'freezer',
      displayName: 'Freezer',
      kind: 'freezer',
      setpointC: -18
    })
  }
  return zones
}

/** Fills in what a profile file leaves out and checks it against the limits. */
export function resolveProfile(p: ProfileFile): VesselProfile {
  const L = p.lengthM
  const draftM = p.draftM ?? round(Math.max(0.3, L * 0.11), 0.1)
  const tanks = {} as Record<TankType, TankProfile[]>
  for (const type of Object.keys(MAX_TANKS) as TankType[]) {
    tanks[type] = p.tanks?.[type] ?? defaultTanks(type, L)
    if (tanks[type].length > MAX_TANKS[type]) {
      throw new Error(
        `${p.id}: ${tanks[type].length} ${type} tanks, at most ${MAX_TANKS[type]}`
      )
    }
  }
  const engines = p.engines ?? defaultEngines(p)
  const banks = p.banks ?? defaultBanks(p)
  const house = banks.find((b) => b.role === 'house')?.id ?? banks[0]?.id
  const generators =
    p.generators ??
    (L >= GENERATOR_FROM_M
      ? [
          {
            id: 'generator1',
            displayName: 'Generator',
            powerKw: round(Math.max(4, 0.12 * L ** 1.9), 0.5),
            rpm: 1500,
            chargesBank: house
          }
        ]
      : [])
  const profile: VesselProfile = {
    beamM: round(L * 0.3, 0.1),
    draftM,
    displacementT: round(Math.max(0.3, 0.004 * L ** 3), 0.1),
    typeCode: 37,
    rig: 'motor',
    maxSpeedKn: round(2.43 * Math.sqrt(L * 3.281) * 0.85, 0.5),
    acVoltage: 230,
    acFrequency: 50,
    acPhases: L >= 24 ? 3 : 1,
    persons: Math.max(1, Math.round(L / 3.5)),
    watermakerLph:
      L >= WATERMAKER_FROM_M ? round(WATERMAKER_LPH_PER_M * L, 5) : 0,
    solar: [],
    windTurbines: [],
    sounders: [
      {
        id: 'sounder',
        displayName: 'Depth sounder',
        // through the hull, and never below the keel
        depthM: Math.min(SOUNDER_DEPTH_M, round(0.8 * draftM, 0.05)),
        offsetM: 0
      }
    ],
    radars:
      L < 9
        ? []
        : L < 25
          ? [{ id: 'radar', displayName: 'Radar' }]
          : [
              { id: 'radarX', displayName: 'X-band radar' },
              { id: 'radarS', displayName: 'S-band radar' }
            ],
    wind: L >= 7,
    zones: defaultZones(L),
    ...p,
    engines,
    generators,
    banks,
    tanks
  } as VesselProfile

  // tie engines and generators to tanks and banks when the file does not say
  const fuel = profile.tanks.fuel
  const dayTanks = fuel.filter((t) => t.dayTank)
  const feed = dayTanks.length ? dayTanks : fuel
  profile.engines = profile.engines.map((e, i) => ({
    ...e,
    fuelTank:
      e.fuelTank ??
      (e.type === 'electric'
        ? undefined
        : feed[Math.min(i, feed.length - 1)]?.id),
    bank:
      e.bank ??
      (e.type === 'diesel' || e.type === 'petrol'
        ? (banks.find((b) => b.role === 'start')?.id ?? house)
        : (banks.find((b) => b.role === 'propulsion')?.id ?? house))
  }))
  profile.generators = profile.generators.map((g, i) => ({
    ...g,
    fuelTank: g.fuelTank ?? feed[i % Math.max(1, feed.length)]?.id,
    chargesBank: g.chargesBank ?? house
  }))
  validateProfile(profile)
  return profile
}

export function validateProfile(p: VesselProfile): void {
  const ids = new Set<string>()
  const unique = (kind: string, id: string) => {
    const key = `${kind}:${id}`
    if (ids.has(key)) throw new Error(`${p.id}: duplicate ${kind} id ${id}`)
    ids.add(key)
  }
  for (const e of [...p.engines, ...p.generators]) unique('propulsion', e.id)
  for (const e of p.engines) {
    if (GENERATOR_ID.test(e.id)) {
      throw new Error(`${p.id}: main engine ${e.id} is named like a generator`)
    }
  }
  for (const g of p.generators) {
    if (!GENERATOR_ID.test(g.id)) {
      throw new Error(`${p.id}: generator ${g.id} must be named generator<n>`)
    }
  }
  for (const b of p.banks) unique('bank', b.id)
  const bankIds = new Set(p.banks.map((b) => b.id))
  const fuelIds = new Set(p.tanks.fuel.map((t) => t.id))
  for (const e of p.engines) {
    if (e.bank && !bankIds.has(e.bank))
      throw new Error(`${p.id}: ${e.id} names unknown bank ${e.bank}`)
    if (e.type !== 'electric' && (!e.fuelTank || !fuelIds.has(e.fuelTank))) {
      throw new Error(`${p.id}: ${e.id} needs a fuel tank`)
    }
  }
  for (const s of [...p.solar, ...p.windTurbines]) {
    if (!bankIds.has(s.bank))
      throw new Error(`${p.id}: ${s.id} names unknown bank ${s.bank}`)
  }
  for (const type of Object.keys(p.tanks) as TankType[]) {
    for (const t of p.tanks[type]) unique(`tank ${type}`, t.id)
  }
}

/** `dir` is simulator/vessels, where the profile files are */
export function loadProfile(id: string, dir: string): VesselProfile {
  const file: ProfileFile = JSON.parse(
    readFileSync(path.join(dir, `${id}.json`), 'utf8')
  )
  if (file.id !== id) throw new Error(`${id}.json declares id ${file.id}`)
  return resolveProfile(file)
}

export function listProfiles(dir: string): string[] {
  return readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .map((f) => f.replace(/\.json$/, ''))
    .sort()
}
