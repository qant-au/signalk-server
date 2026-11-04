import { Delta, DeltaSource, SOURCE } from '../soak/deltas'
import {
  BankProfile,
  EngineProfile,
  GeneratorProfile,
  SolarProfile,
  TankProfile,
  TankType,
  ThrusterProfile,
  VesselProfile,
  WindTurbineProfile,
  ZoneProfile
} from '../vessels/profile'
import {
  AnchorPosition,
  AnchorReport,
  Anchorage,
  AnchorageState,
  anchorWatch,
  watchRadiusM
} from './anchor'
import { Current, Navigation, NavigationState } from './navigation'
import { NEAR_STOP_M, Sailing, SailingSaved } from '../sailing/sailing'
import { OptimumAngle } from '../sailing/polar'
import type { Conditions, TideNow } from '../weather/environment'
import { Drift, DriftState, Rng } from './random'
import { solarHour, sunElevation } from './sun'

/**
 * The boat's systems: engines, generators, batteries and their chargers, tanks, depth
 * sounders, wind and the spaces inside. Each one is a small physical model driven by what
 * the boat is doing (its speed, whether it is at a berth, the time of day) and by the
 * other systems (an engine burns fuel from its tank, a generator carries the AC load and
 * charges a bank), with a seeded drift on top so the values wander the way real ones do.
 *
 * The model moves in fixed steps of scenario time, so a run depends only on the seed and
 * the scenario times asked for, never on how often or how late the caller ticks.
 */
export interface Motion {
  lat: number
  lon: number
  sogKn: number
  cogDeg: number
  /** alongside a berth, before departure or after arrival: shore power, engines off */
  atBerth: boolean
  /** lying at anchor: engines off, no shore power */
  anchored?: boolean
  /** the track's rate of turn, degrees a second, positive to starboard */
  rateOfTurnDegS?: number
  /** stopped, and leaving within a few minutes */
  leavingSoon?: boolean
  /** stopped, seconds until the route has the boat leave */
  leavesInS?: number
  /** under way, metres from the berth the boat left or is coming to */
  nearBerthM?: number
  /** under way, metres from the stop she left or is coming to: a berth, anchorage or hold */
  nearStopM?: number
}

export interface SystemsOptions {
  seed: number
  /** scenario time the model starts at, ms since the epoch */
  startMs: number
  /** depth below the surface at a position, metres, or undefined with no data */
  /** depth below the surface at a position and scenario time, the tide included, metres */
  depthAt?: (lat: number, lon: number, ms: number) => number | undefined
  /** the sample's weather at a position and scenario time (simulator/weather) */
  weatherAt?: (lat: number, lon: number, ms: number) => Conditions
  /** magnetic variation at a position, degrees, positive east, where the sample has it */
  variationAt?: (lat: number, lon: number) => number
  /** a saved run to carry on from, in place of starting fresh at `startMs` */
  state?: SystemsState
  /** faults on board (simulator/faults), stepped with the model */
  faults?: SystemFaults
  /** the anchor watch's radius, metres; unset, the scope's radius plus a margin */
  anchorWatchRadiusM?: number
}

/** what the faults on board do to the systems, asked at each of the model's steps */
export interface SystemFaults {
  /** moves each fault on its course to this scenario time, knowing where the boat lies */
  step(
    nowMs: number,
    dt: number,
    at: { anchored: boolean; atBerth: boolean }
  ): void
  /** the engine's raw-water intake is blocked: its coolant heats while it runs */
  intakeBlocked(engineId: string): boolean
  /** the generator will not start; asking is a start that failed */
  refusesStart(generatorId: string): boolean
  /** how far a cell in the bank has failed, 0 to 1 */
  cellFailure(bankId: string): number
  alternatorFailed(engineId: string): boolean
  chargerFailed(bankId: string): boolean
  /** watts the bilge pump draws from the house bank */
  bilgePumpW(): number
  /** the anchor is dragging */
  anchorDragging(): boolean
  /** the autopilot is out of action */
  autopilotFailed(): boolean
}

type Scalar = number | boolean | string | null

interface UnitState {
  id: string
  values: Record<string, Scalar>
  drifts: Record<string, DriftState>
}

/**
 * Everything the model carries from one step to the next, as JSON: restored into a model
 * built from the same profile and seed, the run carries on exactly as if it had never
 * stopped.
 */
export interface SystemsState {
  version: number
  profileId: string
  seed: number
  nowMs: number
  motion: Motion
  values: Record<string, Scalar>
  drifts: Record<string, DriftState>
  engines: UnitState[]
  generators: UnitState[]
  banks: UnitState[]
  tanks: UnitState[]
  solar: UnitState[]
  turbines: UnitState[]
  thrusters: UnitState[]
  zones: UnitState[]
  sounders: UnitState[]
  navigation: NavigationState
  anchorage: AnchorageState
  /** a sailing boat's sail plan, null on a motor boat */
  sailing: SailingSaved | null
  /** holding tanks being pumped out, as `type.id` */
  pumping: string[]
  pumpOuts: Record<string, number>
}

export const SYSTEMS_STATE_VERSION = 7

/** where each bank's energy went over the run, in joules, and what fuel was burned */
export interface EnergyBooks {
  banks: {
    id: string
    /** energy delivered into the bank at its terminals, by source */
    inJ: Record<string, number>
    /** energy drawn from it at its terminals, by load */
    outJ: Record<string, number>
    /** the change in energy stored, from its state of charge at the start and now */
    storedJ: number
    /** lost in its internal resistance */
    lossJ: number
    /** charge past full or discharge past empty, which the bank cannot hold or give */
    clippedJ: number
  }[]
  fuel: {
    /** asked of the tanks by every engine and generator, at their fuel rates */
    burnedL: number
    tanksStartL: number
    tanksNowL: number
  }
  generators: { id: string; outputJ: number; fuelL: number }[]
}

interface BankBook {
  startSoc: number
  inJ: Record<string, number>
  outJ: Record<string, number>
  lossJ: number
  clippedJ: number
}

/** a saved state that cannot be carried on from: another profile, or an older format */
export class StaleStateError extends Error {}

export const STEP_S = 2

const KELVIN = 273.15
const PASCALS_PER_BAR = 100000
const LITRES_PER_M3 = 1000
const SECONDS_PER_HOUR = 3600
const METRES_PER_SECOND_PER_KNOT = 1852 / 3600
const RADIANS = Math.PI / 180
const DAY_S = 86400

/** litres of fuel per kWh delivered */
const FUEL_L_PER_KWH = { diesel: 0.25, petrol: 0.35 }
/**
 * a generator's fuel per kWh of electricity at full load: a third of diesel's 9.94 kWh a
 * litre, as small marine sets manage, the engine's losses and the alternator's together
 */
const GENERATOR_FUEL_L_PER_KWH = 0.3
/** fuel an idling engine burns, as a share of rated power */
const IDLE_FUEL_SHARE = 0.005
/** a generator's fuel at no load, as a share of its full-load fuel */
const GENERATOR_NO_LOAD_FUEL = 0.25
const ELECTRIC_DRIVE_EFFICIENCY = 0.92
/** a hybrid's inline drive, run as a generator off the diesel, gives up to this share of its rating */
const REGEN_SHARE = 0.25
const CHARGER_EFFICIENCY = 0.9
const POWER_FACTOR = 0.9
/** a generator is loaded to at most this share before another is started */
const GENERATOR_SHARE = 0.8
/** grey water as a share of fresh water used */
const GREY_SHARE = 0.7
const BLACK_L_PER_PERSON_DAY = 8
/** a holding tank is emptied from this level, overboard where that is allowed */
const HOLDING_PUMP_OUT_LEVEL = 0.85
/** at a berth the pump-out station empties any holding tank above this level */
const BERTH_PUMP_OUT_LEVEL = 0.5
/** pumping stops here */
const HOLDING_EMPTY_LEVEL = 0.05
const HOLDING_PUMP_OUT_MIN_KN = 5
const HOLDING_PUMP_OUT_L_PER_H = 2000
/** the water maker starts below this share of the fresh water capacity and stops above the next */
const WATERMAKER_START_LEVEL = 0.85
const WATERMAKER_STOP_LEVEL = 0.98
/** a reverse-osmosis water maker on AC, energy per litre made */
const WATERMAKER_KWH_PER_L = 0.025
/** alongside, the fresh water is topped up from the dock */
const SHORE_WATER_L_PER_H = 1000
const SHORE_WATER_FULL_LEVEL = 0.98
/** shore-power charger rating per metre of length */
const SHORE_CHARGER_W_PER_M = 200
/** a charger is rated for the bank's full charge rate */
const CHARGER_RATING_C = 0.3
/** engine alternator output per kW of engine */
const ALTERNATOR_W_PER_KW = 30
/** however big the engine, an alternator gives at most this many amps at its bank's voltage */
const ALTERNATOR_MAX_A = 150
/** and at idle about half of that */
const ALTERNATOR_IDLE_SHARE = 0.5
/** thrusters run within this many boat lengths of a berth */
const THRUSTER_ZONE_LENGTHS = 3
/** a thruster runs in bursts of a few seconds, with pauses between, at part to full power */
const THRUSTER_BURST_S = { low: 2, high: 8 }
const THRUSTER_GAP_S = { low: 4, high: 20 }
const THRUSTER_LOAD = { low: 0.5, high: 1 }
/** an electric thruster's motor, and a hydraulic one's pump, motor and pipes */
const THRUSTER_MOTOR_EFFICIENCY = 0.85
const HYDRAULIC_EFFICIENCY = 0.7
/** DC-DC converter keeping a house bank charged from a propulsion bank */
const CONVERTER_W = 3000
const CONVERTER_EFFICIENCY = 0.95
const CONVERTER_MIN_SOC = 0.2
const SOLAR_DERATE = 0.85
/** a generator charging a bank starts below the first and stops above the second */
const PROPULSION_CHARGE_FROM = 0.3
const PROPULSION_CHARGE_TO = 0.8
const HOUSE_CHARGE_FROM = 0.45
const HOUSE_CHARGE_TO = 0.9
/** a generator, once started, runs at least this long */
const GENERATOR_MIN_RUN_S = 15 * 60
/** one of several running generators is stopped when the rest would be under this share */
const GENERATOR_STOP_SHARE = 0.6
/** air conditioning at most this share of the hotel load, rising from HVAC_FROM_C over HVAC_RANGE_C */
const HVAC_SHARE = 0.4
const HVAC_FROM_C = 22
const HVAC_RANGE_C = 14
const DAY_TANK_LOW = 0.5
/** a storage tank is changed for a fuller one below this level */
const FUEL_SWITCH_LEVEL = 0.15
const DAY_TANK_FULL = 0.95
/** on the inverter a boat sheds all but the occasional galley load */
const INVERTER_SHARE = 0.06
/** above this length every generator-equipped boat carries its AC load on generators */
const LARGE_YACHT_M = 24
/** heat a blocked raw-water intake leaves in the coolant, degrees a second */
const OVERHEAT_C_PER_S = 0.1
/** above this coolant temperature the oil thins, losing up to this share of its pressure */
const OIL_THINS_FROM_C = 100
const OIL_THINS_OVER_C = 20
const OIL_THINNING = 0.85
/** one cell's voltage, lost when it fails */
const CELL_VOLTS = { lead: 2.1, LiFePO4: 3.3 }
/** a failed cell takes this share of the bank's capacity, and multiplies its resistance by 1 plus this */
const FAILED_CELL_CAPACITY = 0.5
const FAILED_CELL_RESISTANCE = 4

interface EngineState {
  p: EngineProfile
  running: boolean
  /** diesel stopped, shaft turned by the inline electric drive */
  electricMode: boolean
  rpm: number
  load: number
  /** kW from the combustion engine */
  shaftKw: number
  /** kW drawn from (positive) or put into (negative) the bank by an electric drive */
  bankKw: number
  coolantC: number
  oilC: number
  exhaustC: number
  runS: number
  fuelLph: number
  rpmDrift: Drift
  pressureDrift: Drift
  tempDrift: Drift
}

interface GeneratorState {
  p: GeneratorProfile
  running: boolean
  /** seconds since it last started */
  runForS: number
  /** started to charge its bank, until the bank is charged */
  wantsCharge: boolean
  loadKw: number
  coolantC: number
  runS: number
  fuelLph: number
  rpmDrift: Drift
  pressureDrift: Drift
  tempDrift: Drift
}

interface BankState {
  p: BankProfile
  soc: number
  health: number
  /** positive charging, as Signal K has it for batteries */
  currentA: number
  voltage: number
  tempC: number
  chargerW: number
  /** a charger that would be charging has tripped; sent as not charging */
  chargerTripped: boolean
  drift: Drift
}

interface TankState {
  p: TankProfile
  type: TankType
  litres: number
  slosh: Drift
}

interface SolarState {
  p: SolarProfile
  powerW: number
  yieldJ: number
  day: number
  cloud: Drift
  cloudCover: number
}

interface ThrusterState {
  p: ThrusterProfile
  running: boolean
  /** share of rated power this burst */
  load: number
  /** seconds left of the burst, or of the pause before the next */
  burstS: number
  gapS: number
  runS: number
  /** watts drawn from its bank, for an electric thruster */
  drawW: number
  /** the stream that times the bursts, and where it has reached */
  rng: Rng
  rngState: number
  /** the hardest burst so far: the bank current while thrusters drew this, for the soak */
  peak?: { drawW: number; currentA: number; voltage: number }
}

interface TurbineState {
  p: WindTurbineProfile
  powerW: number
  revolutionsHz: number
}

interface ZoneState {
  p: ZoneProfile
  tempC: number
  humidity: number
  compressorOn: boolean
  drift: Drift
}

interface SounderState {
  id: string
  displayName: string
  depthM: number
  offsetM: number
  bias: number
  drift: Drift
  reading?: number
}

/** what each kind of unit carries from step to step, besides its profile */
const ENGINE_FIELDS = [
  'running',
  'electricMode',
  'rpm',
  'load',
  'shaftKw',
  'bankKw',
  'coolantC',
  'oilC',
  'exhaustC',
  'runS',
  'fuelLph'
] as const
const ENGINE_DRIFTS = ['rpmDrift', 'pressureDrift', 'tempDrift'] as const
const GENERATOR_FIELDS = [
  'running',
  'runForS',
  'wantsCharge',
  'loadKw',
  'coolantC',
  'runS',
  'fuelLph'
] as const
const BANK_FIELDS = [
  'soc',
  'health',
  'currentA',
  'voltage',
  'tempC',
  'chargerW'
] as const
const SOLAR_FIELDS = ['powerW', 'yieldJ', 'day', 'cloudCover'] as const
const TURBINE_FIELDS = ['powerW', 'revolutionsHz'] as const
const THRUSTER_FIELDS = [
  'running',
  'load',
  'burstS',
  'gapS',
  'runS',
  'drawW',
  'rngState'
] as const
const ZONE_FIELDS = ['tempC', 'humidity', 'compressorOn'] as const

export class SystemsModel {
  private nowMs: number
  private readonly engines: EngineState[]
  private readonly generators: GeneratorState[]
  private readonly banks: BankState[]
  private readonly tanks: TankState[]
  private readonly solar: SolarState[]
  private readonly turbines: TurbineState[]
  private readonly thrusters: ThrusterState[]
  private readonly zones: ZoneState[]
  private readonly sounders: SounderState[]
  private readonly windBaseKn: number
  private readonly windBaseDeg: number
  private readonly windSpeedDrift: Drift
  private readonly windDirDrift: Drift
  private readonly airDrift: Drift
  private readonly pressureDrift: Drift
  private readonly loadDrift: Drift
  private readonly navigation: Navigation
  private readonly bankBooks = new Map<BankState, BankBook>()
  private readonly generatorBooks = new Map<
    GeneratorState,
    { outputJ: number; fuelL: number }
  >()
  private fuelBurnedL = 0
  private tanksStartL = 0
  private motion: Motion = {
    lat: 0,
    lon: 0,
    sogKn: 0,
    cogDeg: 0,
    atBerth: true
  }
  private airC = 20
  private waterC = 20
  private pressurePa = 101325
  private windKn = 0
  private windDeg = 0
  /** what the sample gives that the model has no state of its own for */
  private humidity: number | undefined
  private waveHeightM: number | undefined
  private tide: TideNow | undefined
  private hotelKw = 0
  private hvacKw = 0
  /** AC the shore supply carries alongside: the hotel load and the chargers */
  private shoreKw = 0
  private shoreChargeKw = 0
  private hvacOn = false
  /** the water maker wants to run; it makes water while a generator runs */
  private watermakerOn = false
  private watermakerRunning = false
  private freshUsedL = 0
  private madeL = 0
  private shoreWaterL = 0
  private readonly pumping = new Set<TankState>()
  private readonly pumpOuts = new Map<string, number>()
  /** under sail alone, the engines stopped */
  private sailing = false
  /** a sailing boat's sails and polar (simulator/sailing) */
  private readonly sail: Sailing | undefined
  /** the sample's current at the latest step, where it has one */
  private sampledCurrent: Current | undefined
  /** the polar's optimum angles, worked out again only when the true wind changes */
  private optimum?: { twsKn: number; beat: OptimumAngle; gybe: OptimumAngle }
  private readonly anchorage: Anchorage
  /** the anchor watch's alarm is raised */
  private anchorAlarmed = false
  /** the model has stepped since it started or was restored */
  private stepped = false
  /** a hybrid's diesels have taken over to charge its bank, until it is full enough again */
  private hybridCharging = false
  private transferring: string | undefined
  /** AC a small boat's inverter carries from the house bank when no generator runs */
  private inverterKw = 0

  constructor(
    readonly profile: VesselProfile,
    private readonly options: SystemsOptions
  ) {
    const seed = options.seed
    const rng = (stream: string) => new Rng(seed, stream)
    this.nowMs = options.startMs

    this.engines = profile.engines.map((p) => {
      const r = rng(`engine:${p.id}`)
      return {
        p,
        running: false,
        electricMode: false,
        rpm: 0,
        load: 0,
        shaftKw: 0,
        bankKw: 0,
        coolantC: 20,
        oilC: 20,
        exhaustC: 20,
        runS: r.between(400, 3000) * SECONDS_PER_HOUR,
        fuelLph: 0,
        rpmDrift: new Drift(r, 0.006, 20),
        pressureDrift: new Drift(r, 0.05, 120),
        tempDrift: new Drift(r, 0.8, 300)
      }
    })
    this.generators = profile.generators.map((p) => {
      const r = rng(`generator:${p.id}`)
      return {
        p,
        running: false,
        runForS: 0,
        wantsCharge: false,
        loadKw: 0,
        coolantC: 20,
        runS: r.between(1000, 9000) * SECONDS_PER_HOUR,
        fuelLph: 0,
        rpmDrift: new Drift(r, 0.002, 30),
        pressureDrift: new Drift(r, 0.04, 120),
        tempDrift: new Drift(r, 0.6, 300)
      }
    })
    this.banks = profile.banks.map((p) => {
      const r = rng(`bank:${p.id}`)
      return {
        p,
        soc: p.role === 'start' ? r.between(0.95, 1) : r.between(0.75, 0.98),
        health: r.between(0.9, 0.99),
        currentA: 0,
        voltage: p.nominalVoltage,
        tempC: 20,
        chargerW: 0,
        chargerTripped: false,
        drift: new Drift(r, 0.003, 60)
      }
    })
    this.tanks = (Object.keys(profile.tanks) as TankType[]).flatMap((type) =>
      profile.tanks[type].map((p) => {
        const r = rng(`tank:${type}:${p.id}`)
        const level =
          type === 'fuel'
            ? p.dayTank
              ? r.between(0.8, 0.95)
              : r.between(0.85, 0.98)
            : type === 'freshWater'
              ? r.between(0.6, 0.95)
              : r.between(0.05, 0.3)
        return {
          p,
          type,
          litres: level * p.capacityL,
          slosh: new Drift(r, 0.004, 8)
        }
      })
    )
    this.solar = profile.solar.map((p) => ({
      p,
      powerW: 0,
      yieldJ: 0,
      day: -1,
      cloud: new Drift(rng(`solar:${p.id}`), 0.12, 900),
      cloudCover: 0
    }))
    this.thrusters = profile.thrusters.map((p) => {
      const r = rng(`thruster:${p.id}`)
      return {
        p,
        running: false,
        load: 0,
        burstS: 0,
        gapS: 0,
        runS: 0,
        drawW: 0,
        rng: r,
        rngState: r.save()
      }
    })
    this.turbines = profile.windTurbines.map((p) => ({
      p,
      powerW: 0,
      revolutionsHz: 0
    }))
    this.zones = profile.zones.map((p) => {
      const r = rng(`zone:${p.id}`)
      return {
        p,
        tempC: p.setpointC + r.between(-1, 1),
        humidity: r.between(0.45, 0.6),
        compressorOn: r.next() < 0.5,
        drift: new Drift(r, 0.15, 600)
      }
    })
    this.sounders = profile.sounders.map((p) => {
      const r = rng(`sounder:${p.id}`)
      return {
        ...p,
        bias: r.between(-0.05, 0.05),
        drift: new Drift(r, 0.03, 15)
      }
    })
    const weather = rng('weather')
    this.windBaseKn = weather.between(6, 12)
    this.windBaseDeg = weather.between(0, 360)
    this.windSpeedDrift = new Drift(weather, 2, 1200)
    this.windDirDrift = new Drift(weather, 15, 3600)
    this.airDrift = new Drift(weather, 0.8, 3600)
    this.pressureDrift = new Drift(weather, 150, 7200)
    this.loadDrift = new Drift(rng('hotel'), 0.06, 900)
    this.navigation = new Navigation(profile, seed, options.startMs)
    this.anchorage = new Anchorage(profile.lengthM, seed, options.depthAt)
    this.sail =
      profile.sails && profile.polar
        ? new Sailing(profile.sails, profile.polar)
        : undefined
    if (options.state) this.restore(options.state)
    this.openBooks()
  }

  /** the books start where the model starts, fresh or restored */
  private openBooks(): void {
    for (const b of this.banks) {
      this.bankBooks.set(b, {
        startSoc: b.soc,
        inJ: {},
        outJ: {},
        lossJ: 0,
        clippedJ: 0
      })
    }
    for (const g of this.generators) {
      this.generatorBooks.set(g, { outputJ: 0, fuelL: 0 })
    }
    this.tanksStartL = this.tanksOf('fuel').reduce(
      (sum, t) => sum + t.litres,
      0
    )
  }

  /** the energy and fuel books since the model started */
  books(): EnergyBooks {
    return {
      banks: this.banks.map((b) => {
        const book = this.bankBooks.get(b)!
        return {
          id: b.p.id,
          inJ: { ...book.inJ },
          outJ: { ...book.outJ },
          storedJ:
            storedEnergyJ(b.p, b.health, b.soc) -
            storedEnergyJ(b.p, b.health, book.startSoc),
          lossJ: book.lossJ,
          clippedJ: book.clippedJ
        }
      }),
      fuel: {
        burnedL: this.fuelBurnedL,
        tanksStartL: this.tanksStartL,
        tanksNowL: this.tanksOf('fuel').reduce((sum, t) => sum + t.litres, 0)
      },
      generators: this.generators.map((g) => ({
        id: g.p.id,
        ...this.generatorBooks.get(g)!
      }))
    }
  }

  get scenarioMs(): number {
    return this.nowMs
  }

  /** metres the boat is off its route's track, positive to starboard */
  get trackOffsetM(): number {
    return this.navigation.trackOffsetM
  }

  private modelDrifts(): Record<string, Drift> {
    return {
      windSpeed: this.windSpeedDrift,
      windDir: this.windDirDrift,
      air: this.airDrift,
      pressure: this.pressureDrift,
      load: this.loadDrift
    }
  }

  /** the state to carry the run on from, after a restart */
  save(): SystemsState {
    const drifts = this.modelDrifts()
    return {
      version: SYSTEMS_STATE_VERSION,
      profileId: this.profile.id,
      seed: this.options.seed,
      nowMs: this.nowMs,
      motion: { ...this.motion },
      values: {
        airC: this.airC,
        waterC: this.waterC,
        pressurePa: this.pressurePa,
        windKn: this.windKn,
        windDeg: this.windDeg,
        hotelKw: this.hotelKw,
        hvacKw: this.hvacKw,
        shoreKw: this.shoreKw,
        shoreChargeKw: this.shoreChargeKw,
        hvacOn: this.hvacOn,
        watermakerOn: this.watermakerOn,
        watermakerRunning: this.watermakerRunning,
        freshUsedL: this.freshUsedL,
        madeL: this.madeL,
        shoreWaterL: this.shoreWaterL,
        sailing: this.sailing,
        hybridCharging: this.hybridCharging,
        transferring: this.transferring ?? null,
        inverterKw: this.inverterKw,
        anchorAlarmed: this.anchorAlarmed
      },
      drifts: Object.fromEntries(
        Object.entries(drifts).map(([k, d]) => [k, d.save()])
      ),
      engines: this.engines.map((e) =>
        saveUnit(e.p.id, e, ENGINE_FIELDS, ENGINE_DRIFTS)
      ),
      generators: this.generators.map((g) =>
        saveUnit(g.p.id, g, GENERATOR_FIELDS, ENGINE_DRIFTS)
      ),
      banks: this.banks.map((b) => saveUnit(b.p.id, b, BANK_FIELDS, ['drift'])),
      tanks: this.tanks.map((t) =>
        saveUnit(tankKey(t), t, ['litres'], ['slosh'])
      ),
      solar: this.solar.map((s) =>
        saveUnit(s.p.id, s, SOLAR_FIELDS, ['cloud'])
      ),
      turbines: this.turbines.map((t) =>
        saveUnit(t.p.id, t, TURBINE_FIELDS, [])
      ),
      thrusters: this.thrusters.map((t) =>
        saveUnit(t.p.id, t, THRUSTER_FIELDS, [])
      ),
      zones: this.zones.map((z) => saveUnit(z.p.id, z, ZONE_FIELDS, ['drift'])),
      sounders: this.sounders.map((s) =>
        saveUnit(s.id, s, ['reading'], ['drift'])
      ),
      navigation: this.navigation.save(),
      anchorage: this.anchorage.save(),
      sailing: this.sail?.save() ?? null,
      pumping: [...this.pumping].map(tankKey),
      pumpOuts: Object.fromEntries(this.pumpOuts)
    }
  }

  /** puts a saved run back, or throws StaleStateError when it does not fit this model */
  private restore(state: SystemsState): void {
    if (state?.version !== SYSTEMS_STATE_VERSION) {
      throw new StaleStateError(
        `saved systems state is format ${state?.version}, this simulator writes ${SYSTEMS_STATE_VERSION}`
      )
    }
    if (
      state.profileId !== this.profile.id ||
      state.seed !== this.options.seed
    ) {
      throw new StaleStateError(
        `saved systems state is for ${state.profileId} seed ${state.seed}, not ${this.profile.id} seed ${this.options.seed}`
      )
    }
    if (!Number.isFinite(state.nowMs) || typeof state.motion !== 'object') {
      throw new StaleStateError('saved systems state has no time or motion')
    }
    restoreUnits(
      'engines',
      this.engines,
      state.engines,
      (e) => e.p.id,
      ENGINE_FIELDS,
      ENGINE_DRIFTS
    )
    restoreUnits(
      'generators',
      this.generators,
      state.generators,
      (g) => g.p.id,
      GENERATOR_FIELDS,
      ENGINE_DRIFTS
    )
    restoreUnits('banks', this.banks, state.banks, (b) => b.p.id, BANK_FIELDS, [
      'drift'
    ])
    restoreUnits(
      'tanks',
      this.tanks,
      state.tanks,
      tankKey,
      ['litres'],
      ['slosh']
    )
    restoreUnits(
      'solar',
      this.solar,
      state.solar,
      (s) => s.p.id,
      SOLAR_FIELDS,
      ['cloud']
    )
    restoreUnits(
      'turbines',
      this.turbines,
      state.turbines,
      (t) => t.p.id,
      TURBINE_FIELDS,
      []
    )
    restoreUnits(
      'thrusters',
      this.thrusters,
      state.thrusters,
      (t) => t.p.id,
      THRUSTER_FIELDS,
      []
    )
    for (const t of this.thrusters) t.rng.restore(t.rngState)
    restoreUnits('zones', this.zones, state.zones, (z) => z.p.id, ZONE_FIELDS, [
      'drift'
    ])
    restoreUnits(
      'sounders',
      this.sounders,
      state.sounders,
      (s) => s.id,
      ['reading'],
      ['drift']
    )
    const values: Record<string, Scalar> = { ...state.values }
    const current = this.save().values
    for (const [k, v] of Object.entries(current)) {
      if (!fits(values[k], v)) {
        throw new StaleStateError(`saved systems state has a bad ${k}`)
      }
    }
    for (const [k, d] of Object.entries(this.modelDrifts())) {
      d.restore(checkedDrift(state.drifts?.[k], k))
    }
    this.navigation.restore(
      state.navigation,
      (ok, what) => {
        if (!ok)
          throw new StaleStateError(`saved systems state has a bad ${what}`)
      },
      checkedDrift
    )
    this.anchorage.restore(state.anchorage, (ok, what) => {
      if (!ok)
        throw new StaleStateError(`saved systems state has a bad ${what}`)
    })
    if (this.sail) {
      this.sail.restore(state.sailing!, (ok, what) => {
        if (!ok)
          throw new StaleStateError(`saved systems state has a bad ${what}`)
      })
    }
    this.stepped = true
    const tanks = new Map(this.tanks.map((t) => [tankKey(t), t]))
    const pumping = (state.pumping ?? []).map((k) => tanks.get(k))
    if (pumping.some((t) => !t)) {
      throw new StaleStateError('saved systems state pumps out an unknown tank')
    }

    this.nowMs = state.nowMs
    this.motion = { ...state.motion }
    this.airC = values.airC as number
    this.waterC = values.waterC as number
    this.pressurePa = values.pressurePa as number
    this.windKn = values.windKn as number
    this.windDeg = values.windDeg as number
    this.hotelKw = values.hotelKw as number
    this.hvacKw = values.hvacKw as number
    this.shoreKw = values.shoreKw as number
    this.shoreChargeKw = values.shoreChargeKw as number
    this.hvacOn = values.hvacOn as boolean
    this.watermakerOn = values.watermakerOn as boolean
    this.watermakerRunning = values.watermakerRunning as boolean
    this.freshUsedL = values.freshUsedL as number
    this.madeL = values.madeL as number
    this.shoreWaterL = values.shoreWaterL as number
    this.sailing = values.sailing as boolean
    this.hybridCharging = values.hybridCharging as boolean
    this.transferring = (values.transferring as string | null) ?? undefined
    this.inverterKw = values.inverterKw as number
    this.anchorAlarmed = values.anchorAlarmed as boolean
    this.pumping.clear()
    for (const t of pumping) this.pumping.add(t as TankState)
    this.pumpOuts.clear()
    for (const [k, n] of Object.entries(state.pumpOuts ?? {})) {
      this.pumpOuts.set(k, n)
    }
  }

  /** Moves the model on to `toMs` in fixed steps, asking `motionAt` where the boat is. */
  advance(toMs: number, motionAt: (ms: number) => Motion): void {
    const stepMs = STEP_S * 1000
    while (this.nowMs + stepMs <= toMs) {
      this.nowMs += stepMs
      this.step(STEP_S, motionAt(this.nowMs))
    }
  }

  private step(dt: number, motion: Motion): void {
    this.motion = motion
    const anchored = motion.anchored === true
    this.options.faults?.step(this.nowMs, dt, {
      anchored,
      atBerth: motion.atBerth
    })
    this.stepWeather(dt)
    this.anchorage.step(
      dt,
      {
        anchored,
        lat: motion.lat,
        lon: motion.lon,
        sogKn: motion.sogKn,
        cogDeg: motion.cogDeg,
        leavesInS: motion.leavesInS,
        windKn: this.windKn,
        windDeg: this.windDeg,
        dragging: this.options.faults?.anchorDragging() === true,
        ms: this.nowMs
      },
      !this.stepped
    )
    this.stepped = true
    const at = this.anchorage.position
    // the boat lies to her chain, or makes back to the track after weighing
    if (at) {
      this.motion = {
        ...motion,
        lat: at.lat,
        lon: at.lon,
        sogKn: at.sogKn,
        cogDeg: at.cogDeg
      }
    }
    this.stepAnchorWatch()
    this.stepPropulsion(dt)
    this.stepThrusters(dt)
    this.navigation.step(
      dt,
      this.nowMs,
      {
        lat: this.motion.lat,
        lon: this.motion.lon,
        sogKn: this.motion.sogKn,
        cogDeg: this.motion.cogDeg,
        rateOfTurnDegS: motion.rateOfTurnDegS ?? 0,
        atBerth: motion.atBerth,
        anchored: motion.anchored === true,
        leavingSoon: motion.leavingSoon === true,
        // the crew points her on the course she is about to leave on
        headDeg:
          at?.headDeg !== undefined && motion.leavingSoon
            ? motion.cogDeg
            : at?.headDeg
      },
      { kn: this.windKn, deg: this.windDeg, waveHeightM: this.waveHeightM },
      { sailing: this.sailing, areaShare: this.sail?.areaShare ?? 0 },
      this.sampledCurrent
    )
    this.stepAc(dt)
    this.stepZones(dt)
    this.stepElectrical(dt)
    this.stepGenerators(dt)
    this.stepTanks(dt)
    this.stepSounders(dt)
  }

  /** the anchor watch, on while the anchor is down */
  private stepAnchorWatch(): void {
    const report = this.anchorage.report
    if (!report) {
      this.anchorAlarmed = false
      return
    }
    this.anchorAlarmed = anchorWatch(
      this.anchorAlarmed,
      report.currentRadiusM,
      watchRadiusM(report, this.options.anchorWatchRadiusM)
    )
  }

  /** what the autopilot steers by: her heading, the true wind, the current, a fault */
  pilotContext(): {
    headingDeg: number
    windKn: number
    windDeg: number
    currentKn: number
    currentToDeg: number
    leewayDeg: number
    failed: boolean
  } {
    const current = this.navigation.current
    return {
      headingDeg: this.navigation.heading,
      leewayDeg: this.navigation.leeway,
      windKn: this.windKn,
      windDeg: this.windDeg,
      currentKn: current.kn,
      currentToDeg: current.toDeg,
      failed: this.options.faults?.autopilotFailed() === true
    }
  }

  /** the anchor as the boat reports it, with the watch's radius, while it is down */
  get anchor(): (AnchorReport & { watchRadiusM: number }) | undefined {
    const report = this.anchorage.report
    return (
      report && {
        ...report,
        watchRadiusM: watchRadiusM(report, this.options.anchorWatchRadiusM)
      }
    )
  }

  /** the anchor watch's alarm, as the anchor alarm plugin raises it */
  anchorAlarm(): { state: 'emergency'; message: string } | undefined {
    return this.anchorAlarmed
      ? { state: 'emergency', message: 'Anchor Alarm - Emergency' }
      : undefined
  }

  /** where the boat is, when she lies at anchor or is rejoining her track from it */
  get anchoredPosition(): AnchorPosition | undefined {
    return this.anchorage.position
  }

  private stepWeather(dt: number): void {
    const { lat, lon } = this.motion
    const t = this.nowMs
    const dayOfYear = (t / 1000 / DAY_S) % 365.25
    const seasonal =
      Math.cos((2 * Math.PI * (dayOfYear - 200)) / 365.25) * Math.sign(lat)
    const seasonalRange = 8 * Math.min(1, Math.abs(lat) / 40)
    const baseC = 30 - 0.2 * Math.abs(lat) + seasonalRange * seasonal
    const hour = solarHour(t, lon)
    const diurnal = Math.cos((2 * Math.PI * (hour - 15)) / 24)
    // every stream steps whether or not the sample replaces its value, so a run with and
    // without a sample's weather draws the same numbers
    const airDrift = this.airDrift.step(dt)
    const pressureDrift = this.pressureDrift.step(dt)
    const gusts = this.windSpeedDrift.step(dt)
    const shifts = this.windDirDrift.step(dt)
    const c = this.options.weatherAt?.(lat, lon, t) ?? {}
    this.airC = c.airC ?? baseC + 4 * diurnal + airDrift
    this.waterC = c.waterC ?? baseC
    this.pressurePa = c.pressurePa ?? 101325 + pressureDrift
    this.humidity = c.humidity
    this.waveHeightM = c.waveHeightM
    this.tide = c.tide
    this.sampledCurrent =
      c.currentKn === undefined || c.currentToDeg === undefined
        ? undefined
        : { kn: c.currentKn, toDeg: c.currentToDeg }
    // the sample's wind with the seed's gusts and shifts on it; without one, a sea breeze
    // that freshens through the afternoon
    this.windKn = Math.max(
      0,
      (c.windKn ?? this.windBaseKn + 3 * diurnal) + gusts
    )
    this.windDeg = ((c.windDeg ?? this.windBaseDeg) + shifts + 360) % 360
  }

  /**
   * A sailing boat's sail plan for the leg she is on: sets `sailing`, and gives the speed
   * the sails make through the water, knots, nothing with them down
   */
  private stepSails(dt: number, stopped: boolean): number {
    const sail = this.sail
    if (!sail) {
      this.sailing = false
      return 0
    }
    const { sogKn, cogDeg } = this.motion
    const c = this.sampledCurrent ?? this.navigation.current
    const cog = cogDeg * RADIANS
    const set = c.toDeg * RADIANS
    const waterE = sogKn * Math.sin(cog) - c.kn * Math.sin(set)
    const waterN = sogKn * Math.cos(cog) - c.kn * Math.cos(set)
    const waterTrackDeg = Math.atan2(waterE, waterN) / RADIANS
    sail.step(dt, {
      underWay: !stopped,
      nearStop: (this.motion.nearStopM ?? Infinity) < NEAR_STOP_M,
      twsKn: this.windKn,
      twdDeg: this.windDeg,
      stwKn: Math.hypot(waterE, waterN),
      waterTrackDeg
    })
    const propulsion = sail.plan.propulsion
    this.sailing = propulsion === 'sailing'
    return propulsion === 'sailing' || propulsion === 'motor-sailing'
      ? sail.polar.speedKn(this.windKn, this.windDeg - waterTrackDeg)
      : 0
  }

  private stepPropulsion(dt: number): void {
    const p = this.profile
    const { sogKn, atBerth } = this.motion
    const stopped = atBerth || this.motion.anchored === true
    // motor-sailing, the sails give some of the speed and the engine the rest: power goes
    // with the cube of speed, so the engine makes up the cube the sails leave
    const sailKn = this.stepSails(dt, stopped)
    const engineKn = Math.cbrt(Math.max(0, sogKn ** 3 - sailKn ** 3))
    const speedShare = Math.min(1, engineKn / p.maxSpeedKn)
    const underway = !stopped && !this.sailing
    const ratedKw = p.engines.reduce((sum, e) => sum + e.powerKw, 0)
    // propeller law: power goes with the cube of speed
    const demandKw = (ratedKw * speedShare ** 3) / Math.max(1, p.engines.length)
    const rules = p.hybrid
    const propulsionBank = this.banks.find((b) => b.p.role === 'propulsion')
    if (rules && propulsionBank) {
      if (propulsionBank.soc < rules.dieselBelowSoc) this.hybridCharging = true
      else if (propulsionBank.soc > rules.electricAboveSoc)
        this.hybridCharging = false
    }
    const hybrids = this.engines.filter((e) => e.p.type === 'hybrid').length

    for (const e of this.engines) {
      const ep = e.p
      const bank = this.bank(ep.bank)
      e.electricMode = false
      e.bankKw = 0
      e.shaftKw = 0
      if (!underway) {
        e.running = false
      } else if (ep.type === 'electric') {
        e.running = true
        e.bankKw = Math.min(ep.powerKw, demandKw) / ELECTRIC_DRIVE_EFFICIENCY
      } else if (
        ep.type === 'hybrid' &&
        ep.electricKw &&
        rules &&
        bank &&
        !this.hybridCharging &&
        sogKn <= rules.electricBelowKn &&
        demandKw <= ep.electricKw
      ) {
        e.running = false
        e.electricMode = true
        e.bankKw = demandKw / ELECTRIC_DRIVE_EFFICIENCY
      } else {
        e.running = true
        e.shaftKw = Math.min(ep.powerKw, demandKw)
        if (
          ep.type === 'hybrid' &&
          ep.electricKw &&
          bank &&
          rules?.chargeWhileDiesel
        ) {
          // the inline drive runs as a generator, charging the bank off the diesel with
          // as much as the bank will take, shared between the drives
          const regenKw = Math.min(
            REGEN_SHARE * ep.electricKw,
            ep.powerKw - e.shaftKw,
            acceptanceW(bank) / 1000 / ELECTRIC_DRIVE_EFFICIENCY / hybrids
          )
          e.shaftKw += regenKw
          e.bankKw = -regenKw * ELECTRIC_DRIVE_EFFICIENCY
        }
      }

      // revolutions are the engine's: a hybrid's diesel is still while the motor turns the shaft
      const turning = e.running || ep.type === 'electric'
      const targetRpm =
        turning && underway
          ? ep.idleRpm + (ep.maxRpm - ep.idleRpm) * speedShare
          : 0
      e.rpm = targetRpm * (1 + e.rpmDrift.step(dt))
      e.load = e.running
        ? Math.max(0.03, e.shaftKw / ep.powerKw)
        : ep.type === 'electric' && underway
          ? e.bankKw / ep.powerKw
          : 0
      const fuelPerKwh =
        ep.type === 'petrol' ? FUEL_L_PER_KWH.petrol : FUEL_L_PER_KWH.diesel
      e.fuelLph =
        e.running && ep.type !== 'electric'
          ? fuelPerKwh * e.shaftKw + IDLE_FUEL_SHARE * ep.powerKw
          : 0
      if (e.running) e.runS += dt

      const roomC = this.engineRoomAmbient()
      const hot = e.running || (ep.type === 'electric' && underway)
      const coolantTarget = hot
        ? ep.type === 'electric'
          ? this.waterC + 15 + 20 * e.load
          : 80 + 6 * e.load
        : roomC
      e.coolantC = relax(e.coolantC, coolantTarget, dt, hot ? 400 : 2400)
      // with the raw water blocked the coolant keeps the engine's heat, until the
      // relaxation back towards its normal running temperature balances it
      if (e.running && this.options.faults?.intakeBlocked(ep.id)) {
        e.coolantC += OVERHEAT_C_PER_S * dt
      }
      e.oilC = relax(
        e.oilC,
        hot ? 85 + 15 * e.load : roomC,
        dt,
        hot ? 600 : 3000
      )
      e.exhaustC = relax(
        e.exhaustC,
        e.running ? 150 + 350 * e.load : roomC,
        dt,
        e.running ? 60 : 600
      )
      e.tempDrift.step(dt)
      e.pressureDrift.step(dt)
    }
  }

  /**
   * Thrusters run in bursts in the last and first few boat lengths to and from a berth,
   * and never at anchor or under way beyond them. A hydraulic one runs only
   * with its main engine running, which carries its load and burns its fuel; an electric
   * one draws its bank, in stepElectrical.
   */
  private stepThrusters(dt: number): void {
    const m = this.motion
    const near =
      !m.atBerth &&
      m.anchored !== true &&
      m.nearBerthM !== undefined &&
      m.nearBerthM <= THRUSTER_ZONE_LENGTHS * this.profile.lengthM
    for (const t of this.thrusters) {
      const engine =
        t.p.type === 'hydraulic'
          ? this.engines.find((e) => e.p.id === t.p.engine)
          : undefined
      const powered = t.p.type === 'electric' || engine?.running === true
      if (!near || !powered) {
        t.running = false
        t.load = 0
        t.burstS = 0
        t.gapS = 0
        t.drawW = 0
        continue
      }
      if (t.running) {
        t.burstS -= dt
        if (t.burstS <= 0) {
          t.running = false
          t.load = 0
          t.gapS = t.rng.between(THRUSTER_GAP_S.low, THRUSTER_GAP_S.high)
        }
      } else {
        t.gapS -= dt
        if (t.gapS <= 0) {
          t.running = true
          t.burstS = t.rng.between(THRUSTER_BURST_S.low, THRUSTER_BURST_S.high)
          t.load = t.rng.between(THRUSTER_LOAD.low, THRUSTER_LOAD.high)
        }
      }
      t.rngState = t.rng.save()
      const kw = t.running ? t.p.powerKw * t.load : 0
      if (t.running) t.runS += dt
      t.drawW =
        t.p.type === 'electric' ? (kw * 1000) / THRUSTER_MOTOR_EFFICIENCY : 0
      if (engine && kw > 0) {
        const pumpKw = kw / HYDRAULIC_EFFICIENCY
        engine.shaftKw += pumpKw
        engine.fuelLph += FUEL_L_PER_KWH.diesel * pumpKw
        engine.load = Math.min(1, engine.shaftKw / engine.p.powerKw)
      }
    }
  }

  /**
   * Which generators run and the AC load each source carries before any charging: the
   * hotel load, the air conditioning and the water maker. Chargers are added in
   * `stepElectrical`, once the banks' other sources are known.
   */
  private stepAc(dt: number): void {
    const p = this.profile
    const { atBerth } = this.motion
    const anchored = this.motion.anchored === true
    const hour = solarHour(this.nowMs, this.motion.lon)
    const meal = isMealTime(hour)
    const awake = hour >= 6.5 && hour < 22.5
    const scaleKw = p.hotelKw
    // a hybrid's hotel load runs on its bank, and its generator only charges the bank
    const batteryHotel = p.hybrid !== undefined
    const baseKw =
      scaleKw *
      (awake ? 1 : 0.6) *
      (meal ? 1.3 : 1) *
      (1 + this.loadDrift.step(dt))
    const hvacDemandKw =
      HVAC_SHARE *
      scaleKw *
      clamp((this.airC - HVAC_FROM_C) / HVAC_RANGE_C, 0, 1)
    const hasGenerators = this.generators.length > 0

    this.updateWatermaker(atBerth)
    const watermakerKw = this.watermakerOn
      ? WATERMAKER_KWH_PER_L * p.watermakerLph
      : 0

    for (const g of this.generators) g.runForS = g.running ? g.runForS + dt : 0
    if (atBerth) {
      // shore power takes over alongside
      for (const g of this.generators) g.running = false
    } else if (hasGenerators && p.lengthM >= LARGE_YACHT_M) {
      const totalKw = baseKw + hvacDemandKw + watermakerKw
      const each = this.generators[0].p.powerKw
      const running = this.generators.filter((g) => g.running).length
      let needed = Math.ceil(totalKw / (GENERATOR_SHARE * each))
      // one is stopped only when the rest could carry the load with room to spare
      if (
        needed < running &&
        totalKw > GENERATOR_STOP_SHARE * each * (running - 1)
      ) {
        needed = running
      }
      needed = clamp(needed, 1, this.generators.length)
      this.generators.forEach((g, i) => this.setGenerator(g, i < needed))
    } else {
      for (const g of this.generators) {
        const bank = this.bank(g.p.chargesBank)
        if (bank) {
          const propulsion = bank.p.role === 'propulsion'
          const low = propulsion
            ? (p.hybrid?.dieselBelowSoc ?? PROPULSION_CHARGE_FROM)
            : HOUSE_CHARGE_FROM
          const high = propulsion
            ? (p.hybrid?.electricAboveSoc ?? PROPULSION_CHARGE_TO)
            : HOUSE_CHARGE_TO
          if (bank.soc < low) g.wantsCharge = true
          else if (bank.soc > high) g.wantsCharge = false
        }
        const allowed = !(
          anchored &&
          p.hybrid &&
          !p.hybrid.generatorChargesAtAnchor
        )
        // at anchor a smaller boat runs its generator for cooking and hot water at meals
        const forAc = !batteryHotel && ((anchored && meal) || this.watermakerOn)
        this.setGenerator(g, allowed && (g.wantsCharge || forAc))
      }
    }

    const running = this.generators.filter((g) => g.running)
    this.hvacOn = hasGenerators && (atBerth || running.length > 0)
    this.hvacKw = this.hvacOn ? hvacDemandKw : 0
    this.hotelKw = baseKw
    this.watermakerRunning =
      this.watermakerOn && (running.length > 0 || batteryHotel)
    for (const g of this.generators) g.loadKw = 0
    this.shoreKw = atBerth && hasGenerators ? baseKw + this.hvacKw : 0
    if (!atBerth && running.length) {
      const acKw =
        baseKw + this.hvacKw + (this.watermakerRunning ? watermakerKw : 0)
      for (const g of running) g.loadKw = acKw / running.length
    }
    this.inverterKw =
      atBerth || running.length
        ? 0
        : batteryHotel
          ? baseKw + (this.watermakerRunning ? watermakerKw : 0)
          : hasGenerators
            ? INVERTER_SHARE * baseKw
            : 0
  }

  /** once started a generator runs a minimum time, so a passing load cannot cycle it */
  private setGenerator(g: GeneratorState, wanted: boolean): void {
    if (wanted && !g.running) {
      if (this.options.faults?.refusesStart(g.p.id)) return
      g.running = true
      g.runForS = 0
    } else if (!wanted && g.running && g.runForS >= GENERATOR_MIN_RUN_S) {
      g.running = false
    }
  }

  /** the water maker runs away from the berth, topping the fresh water tanks up */
  private updateWatermaker(atBerth: boolean): void {
    const fresh = this.tanksOf('freshWater')
    if (!this.profile.watermakerLph || !fresh.length || atBerth) {
      this.watermakerOn = false
      return
    }
    const level = fillLevel(fresh)
    if (level < WATERMAKER_START_LEVEL) this.watermakerOn = true
    else if (level > WATERMAKER_STOP_LEVEL) this.watermakerOn = false
  }

  /** generator fuel and temperatures, once chargers have added their load */
  private stepGenerators(dt: number): void {
    for (const g of this.generators) {
      g.loadKw = Math.min(g.p.powerKw, g.loadKw)
      const share = g.running ? g.loadKw / g.p.powerKw : 0
      g.fuelLph = g.running
        ? GENERATOR_FUEL_L_PER_KWH *
          g.p.powerKw *
          (GENERATOR_NO_LOAD_FUEL + (1 - GENERATOR_NO_LOAD_FUEL) * share)
        : 0
      if (g.running) g.runS += dt
      const book = this.generatorBooks.get(g)
      if (book && g.running) {
        book.outputJ += g.loadKw * 1000 * dt
        book.fuelL += (g.fuelLph * dt) / SECONDS_PER_HOUR
      }
      g.coolantC = relax(
        g.coolantC,
        g.running ? 78 + 8 * share : this.engineRoomAmbient(),
        dt,
        g.running ? 300 : 2400
      )
      g.rpmDrift.step(dt)
      g.pressureDrift.step(dt)
      g.tempDrift.step(dt)
    }
  }

  private stepZones(dt: number): void {
    const sun = Math.max(
      0,
      Math.sin(sunElevation(this.nowMs, this.motion.lat, this.motion.lon))
    )
    const ambientC = this.cabinAmbient()
    for (const z of this.zones) {
      const p = z.p
      z.drift.step(dt)
      if (p.kind === 'living') {
        const target = this.hvacOn ? p.setpointC : this.airC + 1 + 3 * sun
        z.tempC = relax(z.tempC, target, dt, this.hvacOn ? 900 : 3600)
        z.humidity = relax(z.humidity, this.hvacOn ? 0.5 : 0.7, dt, 1800)
      } else if (p.kind === 'engineRoom') {
        z.tempC = relax(z.tempC, this.engineRoomAmbient(), dt, 900)
        z.humidity = relax(z.humidity, 0.4, dt, 1800)
      } else {
        // a compressor cycling between a band either side of the setpoint
        const band = 1.5
        if (z.tempC > p.setpointC + band) z.compressorOn = true
        else if (z.tempC < p.setpointC - band) z.compressorOn = false
        const coolPerS = (p.kind === 'freezer' ? 1.0 : 1.2) / 600
        z.tempC = z.compressorOn
          ? z.tempC - coolPerS * dt
          : relax(z.tempC, ambientC, dt, p.kind === 'freezer' ? 14400 : 10800)
        z.humidity = relax(z.humidity, 0.8, dt, 1800)
      }
    }
  }

  /**
   * Each bank's loads, then its sources in the order a real system ends up drawing on
   * them: solar and wind first (they cost nothing, and their controllers hold the bank
   * up before the chargers' setpoints are reached), then engine alternators and drive
   * regeneration, the DC-DC converter from a propulsion bank, and AC chargers last. Each
   * source gives only what the loads and the bank's charge acceptance still want.
   */
  private stepElectrical(dt: number): void {
    const p = this.profile
    const { atBerth } = this.motion
    const sunSin = Math.max(
      0,
      Math.sin(sunElevation(this.nowMs, this.motion.lat, this.motion.lon))
    )
    const day = Math.floor(
      (this.nowMs / 1000 + (this.motion.lon / 15) * SECONDS_PER_HOUR) / DAY_S
    )
    for (const s of this.solar) {
      if (s.day !== day) {
        s.day = day
        s.yieldJ = 0
      }
      s.cloudCover = clamp(Math.abs(s.cloud.step(dt)), 0, 0.7)
    }
    const apparentMs = this.apparentWind().speedMs

    // every flow in and out of each bank this step, watts by name, for its books
    const flowsIn = new Map<BankState, Record<string, number>>()
    const flowsOut = new Map<BankState, Record<string, number>>()
    const add = (
      flows: Map<BankState, Record<string, number>>,
      bank: BankState,
      name: string,
      w: number
    ) => {
      const record = flows.get(bank) ?? {}
      record[name] = (record[name] ?? 0) + w
      flows.set(bank, record)
    }
    const loadW = new Map<BankState, number>()
    const draw = (bank: BankState | undefined, w: number, name: string) => {
      if (!bank) return
      loadW.set(bank, (loadW.get(bank) ?? 0) + w)
      add(flowsOut, bank, name, w)
    }
    for (const e of this.engines) {
      if (e.bankKw > 0) draw(this.bank(e.p.bank), e.bankKw * 1000, 'drive')
    }
    const house = this.banks.find((b) => b.p.role === 'house')
    const propulsion = this.banks.find((b) => b.p.role === 'propulsion')
    if (house) {
      draw(house, 3 * p.lengthM ** 1.4, 'house')
      let fridgeW = 0
      for (const z of this.zones) {
        if (
          z.compressorOn &&
          (z.p.kind === 'fridge' || z.p.kind === 'freezer')
        ) {
          fridgeW +=
            (z.p.kind === 'freezer' ? 80 : 50) * Math.max(1, p.lengthM / 15)
        }
      }
      draw(house, fridgeW, 'fridges')
      draw(house, this.options.faults?.bilgePumpW() ?? 0, 'bilge pump')
    }
    // a hybrid's inverter hangs off its propulsion bank, which carries its hotel load
    const inverterBank = p.hybrid && propulsion ? propulsion : house
    draw(
      inverterBank,
      (this.inverterKw * 1000) / CHARGER_EFFICIENCY,
      'inverter'
    )
    for (const b of this.banks) {
      if (b.p.role === 'start')
        draw(b, 2.5 * (b.p.nominalVoltage / 12), 'standby')
    }
    for (const t of this.thrusters) {
      if (t.drawW > 0) draw(this.bank(t.p.bank), t.drawW, 'thrusters')
    }

    const supplied = new Map<BankState, number>()
    const take = (bank: BankState, availableW: number, name: string) => {
      const wanted =
        (loadW.get(bank) ?? 0) + acceptanceW(bank) - (supplied.get(bank) ?? 0)
      const w = clamp(availableW, 0, Math.max(0, wanted))
      supplied.set(bank, (supplied.get(bank) ?? 0) + w)
      add(flowsIn, bank, name, w)
      return w
    }
    // the house bank first, so the converter's draw on the propulsion bank is known
    // each running engine's alternator: half its output at idle, all of it flat out
    const alternatorW = new Map<EngineState, number>()
    const charged = this.alternatorBank()
    for (const e of this.engines) {
      if (
        !e.running ||
        e.p.type === 'electric' ||
        !charged ||
        this.options.faults?.alternatorFailed(e.p.id)
      )
        continue
      const revs = clamp(
        (e.rpm - e.p.idleRpm) / (e.p.maxRpm - e.p.idleRpm),
        0,
        1
      )
      alternatorW.set(
        e,
        Math.min(
          ALTERNATOR_W_PER_KW * e.p.powerKw,
          ALTERNATOR_MAX_A * charged.p.nominalVoltage
        ) *
          (ALTERNATOR_IDLE_SHARE + (1 - ALTERNATOR_IDLE_SHARE) * revs)
      )
    }
    const ordered = [...this.banks].sort(
      (a, b) => Number(b.p.role === 'house') - Number(a.p.role === 'house')
    )
    this.shoreChargeKw = 0
    for (const b of ordered) {
      // arrays on one bank share what it takes, each in proportion to what it could give
      const arrays = this.solar.filter((s) => s.p.bank === b.p.id)
      const availableW = arrays.map(
        (s) => s.p.peakW * SOLAR_DERATE * sunSin ** 1.2 * (1 - s.cloudCover)
      )
      const totalW = availableW.reduce((sum, w) => sum + w, 0)
      const takenW = take(b, totalW, 'solar')
      arrays.forEach((s, i) => {
        s.powerW = totalW > 0 ? (takenW * availableW[i]) / totalW : 0
        s.yieldJ += s.powerW * dt
      })
      for (const t of this.turbines) {
        if (t.p.bank !== b.p.id) continue
        const share = clamp((apparentMs - 3) / (12.5 - 3), 0, 1)
        t.powerW = take(b, t.p.ratedW * share ** 3, 'wind')
        t.revolutionsHz = apparentMs > 2 ? Math.min(25, 2 * apparentMs) : 0
      }
      // on a boat with a propulsion bank the house hangs off its bus, ahead of any alternator
      if (b === house && propulsion && propulsion.soc > CONVERTER_MIN_SOC) {
        const w = take(b, CONVERTER_W, 'converter')
        draw(propulsion, w / CONVERTER_EFFICIENCY, 'converter')
      }
      for (const e of this.engines) {
        if (b.p.role !== 'propulsion' && alternatorW.has(e)) {
          // one alternator per engine, shared through a charge splitter: what the house
          // bank takes first, the start bank cannot also have
          const w = take(b, alternatorW.get(e)!, 'alternator')
          alternatorW.set(e, alternatorW.get(e)! - w)
        }
        if (e.bankKw < 0 && e.p.bank === b.p.id)
          take(b, -e.bankKw * 1000, 'regeneration')
      }
      b.chargerW = 0
      b.chargerTripped = false
      if (b.p.role === 'start') continue
      const ratingW = CHARGER_RATING_C * b.p.capacityAh * b.p.nominalVoltage
      if (this.options.faults?.chargerFailed(b.p.id)) {
        b.chargerTripped =
          atBerth ||
          this.generators.some((g) => g.running && g.p.chargesBank === b.p.id)
      } else if (atBerth) {
        b.chargerW = take(
          b,
          Math.min(ratingW, SHORE_CHARGER_W_PER_M * p.lengthM),
          'shore charger'
        )
        this.shoreChargeKw += b.chargerW / CHARGER_EFFICIENCY / 1000
      } else {
        for (const g of this.generators) {
          if (!g.running || g.p.chargesBank !== b.p.id) continue
          const w = take(
            b,
            Math.min(
              ratingW - b.chargerW,
              (g.p.powerKw - g.loadKw) * 1000 * CHARGER_EFFICIENCY
            ),
            'generator charger'
          )
          g.loadKw += w / CHARGER_EFFICIENCY / 1000
          b.chargerW += w
        }
      }
    }

    for (const b of this.banks) {
      const w = (supplied.get(b) ?? 0) - (loadW.get(b) ?? 0)
      const scale = b.p.nominalVoltage / 12
      // a failing cell gives up its voltage, holds less charge and resists the current
      const failed = this.options.faults?.cellFailure(b.p.id) ?? 0
      const ocv =
        scale * openCircuitVolts(b.p.chemistry, b.soc) -
        failed * CELL_VOLTS[b.p.chemistry === 'LiFePO4' ? 'LiFePO4' : 'lead']
      const resistance =
        ((scale * BLOCK_RESISTANCE_OHM_AH) / b.p.capacityAh) *
        (1 + FAILED_CELL_RESISTANCE * failed)
      // the terminals take w = I (ocv + I r): the current that does it, through the
      // resistance, so what goes in at the terminals is what is stored plus I squared r
      const current =
        (-ocv + Math.sqrt(Math.max(0, ocv * ocv + 4 * resistance * w))) /
        (2 * resistance)
      const capacityAh =
        b.p.capacityAh * b.health * (1 - FAILED_CELL_CAPACITY * failed)
      const wantedSoc = b.soc + (current * dt) / SECONDS_PER_HOUR / capacityAh
      b.soc = clamp(wantedSoc, SOC_FLOOR, 1)
      b.currentA = current
      const thrusting = this.thrusters.filter(
        (t) => t.drawW > 0 && t.p.bank === b.p.id
      )
      if (thrusting.length) {
        const drawW = thrusting.reduce((sum, t) => sum + t.drawW, 0)
        for (const t of thrusting) {
          if (!t.peak || current < t.peak.currentA) {
            t.peak = {
              drawW,
              currentA: current,
              voltage: ocv + current * resistance
            }
          }
        }
      }
      const book = this.bankBooks.get(b)
      if (book) {
        for (const [name, flow] of Object.entries(flowsIn.get(b) ?? {}))
          book.inJ[name] = (book.inJ[name] ?? 0) + flow * dt
        for (const [name, flow] of Object.entries(flowsOut.get(b) ?? {}))
          book.outJ[name] = (book.outJ[name] ?? 0) + flow * dt
        book.lossJ += current * current * resistance * dt
        book.clippedJ +=
          (wantedSoc - b.soc) * capacityAh * SECONDS_PER_HOUR * ocv
      }
      // the voltage a monitor reads: the charger holds it at absorption, and it wanders
      const absorption = scale * (b.p.chemistry === 'LiFePO4' ? 14.2 : 14.4)
      const terminal = ocv + current * resistance
      b.voltage =
        Math.min(terminal, current > 0 ? absorption : Infinity) *
        (1 + b.drift.step(dt))
      const inEngineRoom =
        b.p.role !== 'house' &&
        this.zones.some((z) => z.p.kind === 'engineRoom')
      const ambient = inEngineRoom
        ? this.engineRoomAmbient()
        : this.cabinAmbient()
      b.tempC = relax(
        b.tempC,
        ambient + (5 * Math.abs(b.currentA)) / b.p.capacityAh,
        dt,
        1800
      )
    }
  }

  private tanksOf(type: TankType): TankState[] {
    return this.tanks.filter((t) => t.type === type)
  }

  private stepTanks(dt: number): void {
    const p = this.profile
    const { atBerth, sogKn } = this.motion
    const tank = (type: TankType, id: string | undefined) =>
      this.tanks.find((t) => t.type === type && t.p.id === id)
    const fuel = this.tanksOf('fuel')
    const burn = (t: TankState | undefined, litres: number) => {
      if (!t) return
      this.fuelBurnedL += litres
      // below its reserve a storage tank is switched for the fullest one, as a crew
      // changes tanks; a day tank is kept full by the transfer pump instead
      const fullest = fuel.reduce((a, b) => (b.litres > a.litres ? b : a), t)
      const from =
        t.litres < litres ||
        (!t.p.dayTank && t.litres < FUEL_SWITCH_LEVEL * t.p.capacityL)
          ? fullest
          : t
      from.litres = Math.max(0, from.litres - litres)
    }
    for (const e of this.engines)
      burn(tank('fuel', e.p.fuelTank), (e.fuelLph * dt) / SECONDS_PER_HOUR)
    for (const g of this.generators)
      burn(tank('fuel', g.p.fuelTank), (g.fuelLph * dt) / SECONDS_PER_HOUR)

    // the transfer pump keeps the day tanks topped up from the storage tanks
    const dayTanks = fuel.filter((t) => t.p.dayTank)
    const storage = fuel.filter((t) => !t.p.dayTank)
    const low = dayTanks.find(
      (t) =>
        t.p.id === this.transferring || t.litres < DAY_TANK_LOW * t.p.capacityL
    )
    this.transferring = undefined
    if (low && low.litres < DAY_TANK_FULL * low.p.capacityL && storage.length) {
      const from = storage.reduce((a, b) => (b.litres > a.litres ? b : a))
      const litres = Math.min(
        from.litres,
        (Math.max(300, 0.5 * low.p.capacityL) * dt) / SECONDS_PER_HOUR
      )
      from.litres -= litres
      low.litres += litres
      if (litres > 0) this.transferring = low.p.id
    }

    const busy = waterUse(solarHour(this.nowMs, this.motion.lon))
    const perPerson =
      p.lengthM >= LARGE_YACHT_M ? 100 : p.lengthM >= 10 ? 60 : 20
    const fresh = this.tanksOf('freshWater')
    if (fresh.length) {
      const wantL = (p.persons * perPerson * busy * dt) / DAY_S
      const source =
        fresh.find((t) => t.litres > 0.2 * t.p.capacityL) ??
        fresh.reduce((a, b) => (b.litres > a.litres ? b : a))
      const usedL = Math.min(source.litres, wantL)
      source.litres -= usedL
      this.freshUsedL += usedL
      fillTanks(this.tanksOf('wasteWater'), GREY_SHARE * usedL)
      const lowest = fresh.reduce((a, b) =>
        b.litres / b.p.capacityL < a.litres / a.p.capacityL ? b : a
      )
      if (this.watermakerRunning) {
        const madeL = (p.watermakerLph * dt) / SECONDS_PER_HOUR
        lowest.litres = Math.min(lowest.p.capacityL, lowest.litres + madeL)
        this.madeL += madeL
      }
      if (atBerth && fillLevel(fresh) < SHORE_WATER_FULL_LEVEL) {
        const hoseL = (SHORE_WATER_L_PER_H * dt) / SECONDS_PER_HOUR
        lowest.litres = Math.min(lowest.p.capacityL, lowest.litres + hoseL)
        this.shoreWaterL += hoseL
      }
    }
    fillTanks(
      this.tanksOf('blackWater'),
      (p.persons * BLACK_L_PER_PERSON_DAY * busy * dt) / DAY_S
    )

    // holding tanks: the pump-out station at a berth; grey water overboard anywhere
    // else, black water only well offshore, which a boat making 5 kn stands for here
    for (const t of [
      ...this.tanksOf('wasteWater'),
      ...this.tanksOf('blackWater')
    ]) {
      const level = t.litres / t.p.capacityL
      const allowed = atBerth
        ? true
        : t.type === 'wasteWater' || sogKn >= HOLDING_PUMP_OUT_MIN_KN
      const startAt = atBerth ? BERTH_PUMP_OUT_LEVEL : HOLDING_PUMP_OUT_LEVEL
      if (!allowed || level <= HOLDING_EMPTY_LEVEL) {
        this.pumping.delete(t)
      } else if (!this.pumping.has(t) && level >= startAt) {
        this.pumping.add(t)
        this.pumpOuts.set(t.p.id, (this.pumpOuts.get(t.p.id) ?? 0) + 1)
      }
      if (this.pumping.has(t)) {
        t.litres = Math.max(
          0,
          t.litres - (HOLDING_PUMP_OUT_L_PER_H * dt) / SECONDS_PER_HOUR
        )
      }
    }
    for (const t of this.tanks) t.slosh.step(dt)
  }

  private stepSounders(dt: number): void {
    const depthAt = this.options.depthAt
    const { lat, lon, cogDeg } = this.motion
    for (const s of this.sounders) {
      s.drift.step(dt)
      if (!depthAt) continue
      // offset athwartships: positive is to starboard of the heading
      const bearing = (cogDeg + 90) * RADIANS
      const dLat = (s.offsetM * Math.cos(bearing)) / 111320
      const dLon =
        (s.offsetM * Math.sin(bearing)) / (111320 * Math.cos(lat * RADIANS))
      const depth = depthAt(lat + dLat, lon + dLon, this.nowMs)
      s.reading =
        depth === undefined ? undefined : depth + s.bias + s.drift.value
    }
  }

  /** the low-voltage bank a combustion engine's alternator charges */
  private alternatorBank(): BankState | undefined {
    return (
      this.banks.find((b) => b.p.role === 'start') ??
      this.banks.find((b) => b.p.role === 'house')
    )
  }

  private bank(id: string | undefined): BankState | undefined {
    return this.banks.find((b) => b.p.id === id)
  }

  private engineRoomAmbient(): number {
    const enginesHot = this.engines.some((e) => e.running)
    const generatorsHot = this.generators.some((g) => g.running)
    const maxLoad = Math.max(0, ...this.engines.map((e) => e.load))
    return this.airC + (enginesHot ? 15 + 10 * maxLoad : generatorsHot ? 10 : 3)
  }

  private cabinAmbient(): number {
    return this.hvacOn ? 22 : this.airC + 1
  }

  /** wind over the deck, from the true wind and the boat's own motion */
  private apparentWind(): { speedMs: number; angle: number } {
    const windMs = this.windKn * METRES_PER_SECOND_PER_KNOT
    const from = this.windDeg * RADIANS
    const course = this.motion.cogDeg * RADIANS
    const boatMs = this.motion.sogKn * METRES_PER_SECOND_PER_KNOT
    // air moving over the ground, less the boat's velocity
    const east = -windMs * Math.sin(from) - boatMs * Math.sin(course)
    const north = -windMs * Math.cos(from) - boatMs * Math.cos(course)
    const apparentFrom = Math.atan2(-east, -north)
    // the vane sits on the boat, so its angle is off the bow, not off the track
    return {
      speedMs: Math.hypot(east, north),
      angle: wrapPi(apparentFrom - this.navigation.heading * RADIANS)
    }
  }

  /** displayName and description for every unit, sent once at the start */
  metaDelta(sentAtMs: number): Delta {
    const meta: NonNullable<Delta['updates'][number]['meta']> = []
    const name = (path: string, displayName: string, description: string) =>
      meta.push({ path, value: { displayName, description } })
    for (const e of this.engines) {
      name(
        `propulsion.${e.p.id}`,
        e.p.displayName,
        `${e.p.type} main engine, ${e.p.powerKw} kW`
      )
    }
    for (const g of this.generators) {
      name(
        `propulsion.${g.p.id}`,
        g.p.displayName,
        `generator engine, ${g.p.powerKw} kW`
      )
      name(
        `electrical.ac.${g.p.id}`,
        `${g.p.displayName} AC`,
        `AC output of ${g.p.displayName}`
      )
    }
    for (const b of this.banks) {
      name(
        `electrical.batteries.${b.p.id}`,
        b.p.displayName,
        `${b.p.nominalVoltage} V ${b.p.capacityAh} Ah ${b.p.chemistry}`
      )
    }
    for (const s of this.solar) {
      name(
        `electrical.solar.${s.p.id}`,
        s.p.displayName,
        `${s.p.peakW} W solar array`
      )
    }
    for (const t of this.thrusters) {
      const where =
        t.p.type === 'electric'
          ? `on the ${t.p.bank} bank`
          : `off ${t.p.engine}`
      name(
        `propulsion.${t.p.id}`,
        t.p.displayName,
        `${t.p.type} thruster, ${t.p.powerKw} kW, ${where}; not a main engine`
      )
    }
    for (const t of this.turbines) {
      name(
        `electrical.alternators.${t.p.id}`,
        t.p.displayName,
        `${t.p.ratedW} W wind turbine`
      )
    }
    for (const t of this.tanks) {
      name(`tanks.${t.type}.${t.p.id}`, t.p.displayName, `${t.p.capacityL} l`)
    }
    for (const z of this.zones) {
      name(`environment.inside.${z.p.id}`, z.p.displayName, `${z.p.kind}`)
    }
    for (const s of this.sounders) {
      name(
        `sensors.${s.id}`,
        s.displayName,
        `depth sounder, ${s.depthM} m below the waterline`
      )
    }
    // positive to starboard, as this server's path metadata defines it
    const values = this.sounders.map((s) => ({
      path: `sensors.${s.id}.fromCenter`,
      value: s.offsetM
    }))
    return {
      context: 'vessels.self',
      updates: [{ source: SOURCE, timestamp: iso(sentAtMs), values, meta }]
    }
  }

  /**
   * The current values. `slow` adds what changes over minutes (electrical, tanks, the
   * spaces inside), which a real gateway sends less often than engine and wind data.
   */
  deltas(sentAtMs: number, slow: boolean): Delta[] {
    const timestamp = iso(sentAtMs)
    const values: { path: string; value: unknown }[] = []
    const put = (path: string, value: unknown) => values.push({ path, value })

    for (const e of this.engines) this.putEngine(e, put)
    for (const t of this.thrusters) {
      const base = `propulsion.${t.p.id}`
      put(`${base}.state`, t.running ? 'started' : 'stopped')
      put(`${base}.engineLoad`, round3(t.load))
      put(`${base}.runTime`, Math.round(t.runS))
    }
    for (const g of this.generators) this.putGenerator(g, put)
    if (this.profile.wind) this.putWind(put)
    const { lat, lon } = this.motion
    const variationDeg = this.options.variationAt?.(lat, lon)
    this.navigation.put(put, variationDeg)
    this.putPerformance(put, variationDeg)
    this.putAnchor(put)
    if (!slow) {
      // a battery monitor reports every second: a thruster burst is over in a few
      for (const b of this.banks) {
        if (this.thrusters.some((t) => t.drawW > 0 && t.p.bank === b.p.id))
          this.putBank(b, put)
      }
    }

    if (slow) {
      for (const g of this.generators)
        this.putAc(g.p.id, g.running ? g.loadKw : 0, g.running, put)
      const shoreKw = this.shoreKw + this.shoreChargeKw
      if (shoreKw > 0) this.putAc('shore', shoreKw, true, put)
      for (const b of this.banks) this.putBank(b, put)
      for (const s of this.solar) this.putSolar(s, put)
      for (const t of this.turbines) this.putTurbine(t, put)
      for (const t of this.tanks) this.putTank(t, put)
      for (const z of this.zones) {
        const base = `environment.inside.${z.p.id}`
        put(`${base}.temperature`, round2(z.tempC + z.drift.value + KELVIN))
        put(`${base}.relativeHumidity`, round3(clamp(z.humidity, 0, 1)))
      }
      put('environment.outside.temperature', round2(this.airC + KELVIN))
      put('environment.outside.pressure', Math.round(this.pressurePa))
      put('environment.water.temperature', round2(this.waterC + KELVIN))
      if (this.humidity !== undefined)
        put('environment.outside.relativeHumidity', round3(this.humidity))
      this.putTide(put)
      this.navigation.putCurrent(put, variationDeg)
      this.putSails(put)
    }

    const deltas: Delta[] = [
      {
        context: 'vessels.self',
        updates: [{ source: SOURCE, timestamp, values }]
      }
    ]
    const draft = this.profile.draftM
    const sounderUpdates = this.sounders
      .filter((s) => s.reading !== undefined)
      .map((s) => {
        const below = s.reading as number
        const source: DeltaSource = { ...SOURCE, src: s.id }
        return {
          source,
          timestamp,
          values: [
            { path: 'environment.depth.belowSurface', value: round2(below) },
            {
              path: 'environment.depth.belowTransducer',
              value: round2(below - s.depthM)
            },
            {
              path: 'environment.depth.belowKeel',
              value: round2(below - draft)
            },
            { path: 'environment.depth.surfaceToTransducer', value: s.depthM },
            {
              path: 'environment.depth.transducerToKeel',
              value: round2(draft - s.depthM)
            }
          ]
        }
      })
    if (sounderUpdates.length) {
      deltas.push({ context: 'vessels.self', updates: sounderUpdates })
    }
    return deltas
  }

  /** the polar's beat and gybe at the true wind now */
  private optimumAngles(): { beat: OptimumAngle; gybe: OptimumAngle } {
    const polar = this.sail!.polar
    if (this.optimum?.twsKn !== this.windKn) {
      this.optimum = {
        twsKn: this.windKn,
        beat: polar.beat(this.windKn),
        gybe: polar.gybe(this.windKn)
      }
    }
    return this.optimum
  }

  /** what the polar makes of her sailing now, for the performance paths and the run view */
  performance(): PerformanceNow | undefined {
    if (!this.sail || !this.profile.wind) return undefined
    const heading = this.navigation.heading
    const twaDeg = wrap180(this.windDeg - heading)
    const stwKn = this.navigation.speedThroughWaterKn
    const polarKn = this.sail.polar.speedKn(this.windKn, twaDeg)
    const { beat, gybe } = this.optimumAngles()
    return {
      twaDeg,
      polarKn,
      ratio: polarKn > 0 ? stwKn / polarKn : 0,
      vmgKn: stwKn * Math.cos(twaDeg * RADIANS),
      beat,
      gybe,
      target: Math.abs(twaDeg) < 90 ? beat : gybe,
      // the same angle to the wind on her other side
      tackDeg: norm360(2 * this.windDeg - heading)
    }
  }

  /** the performance paths, from the polar, on a sailing boat with a wind instrument */
  private putPerformance(
    put: (path: string, value: unknown) => void,
    variationDeg: number | undefined
  ): void {
    const perf = this.performance()
    if (!perf) return
    const ms = (kn: number) => round3(kn * METRES_PER_SECOND_PER_KNOT)
    const rad = (deg: number) => round4(deg * RADIANS)
    put('performance.polarSpeed', ms(perf.polarKn))
    put('performance.polarSpeedRatio', round3(perf.ratio))
    put('performance.velocityMadeGood', ms(perf.vmgKn))
    put('performance.beatAngle', rad(perf.beat.twaDeg))
    put('performance.beatAngleTargetSpeed', ms(perf.beat.speedKn))
    put('performance.beatAngleVelocityMadeGood', ms(perf.beat.vmgKn))
    put('performance.gybeAngle', rad(perf.gybe.twaDeg))
    put('performance.gybeAngleTargetSpeed', ms(perf.gybe.speedKn))
    put('performance.gybeAngleVelocityMadeGood', ms(perf.gybe.vmgKn))
    put('performance.targetAngle', rad(perf.target.twaDeg))
    put('performance.targetSpeed', ms(perf.target.speedKn))
    put('performance.leeway', round4(this.navigation.leeway * RADIANS))
    put('performance.tackTrue', rad(perf.tackDeg) % round4(2 * Math.PI))
    if (variationDeg !== undefined) {
      put(
        'performance.tackMagnetic',
        rad(norm360(perf.tackDeg - variationDeg)) % round4(2 * Math.PI)
      )
    }
  }

  /** a sailing boat's sails: each one set or not, and the area of all and of those set */
  private putSails(put: (path: string, value: unknown) => void): void {
    const sail = this.sail
    if (!sail) return
    const set = new Set(sail.plan.sails)
    for (const s of sail.sails) {
      put(`sails.inventory.${s.id}`, {
        name: s.name,
        type: s.type,
        active: set.has(s.id),
        area: s.areaM2,
        minimumWind: round2(s.minWindKn * METRES_PER_SECOND_PER_KNOT),
        maximumWind: round2(s.maxWindKn * METRES_PER_SECOND_PER_KNOT)
      })
    }
    put('sails.area.total', sail.fullAreaM2)
    put('sails.area.active', sail.activeAreaM2)
  }

  /** the tide as a tide table and gauge give it, above chart datum, where the sample has one */
  private putTide(put: (path: string, value: unknown) => void): void {
    const tide = this.tide
    if (!tide) return
    put('environment.tide.heightNow', round3(tide.heightM))
    if (tide.high) {
      put('environment.tide.heightHigh', round3(tide.high.heightM))
      put('environment.tide.timeHigh', iso(tide.high.ms))
    }
    if (tide.low) {
      put('environment.tide.heightLow', round3(tide.low.heightM))
      put('environment.tide.timeLow', iso(tide.low.ms))
    }
  }

  /** the anchor's values while it is down, as the anchor alarm plugin sends them, and cleared once it is up */
  private putAnchor(put: (path: string, value: unknown) => void): void {
    const report = this.anchorage.report
    if (this.anchorage.takeWeighed() && !report) {
      put('navigation.anchor.position', null)
      put('navigation.anchor.maxRadius', null)
      put('navigation.anchor.currentRadius', null)
    }
    if (!report) return
    put('navigation.anchor.position', {
      latitude: report.lat,
      longitude: report.lon,
      altitude: -round2(report.depthM)
    })
    put('navigation.anchor.maxRadius', round2(report.maxRadiusM))
    put('navigation.anchor.currentRadius', round2(report.currentRadiusM))
  }

  private putEngine(
    e: EngineState,
    put: (path: string, value: unknown) => void
  ): void {
    const base = `propulsion.${e.p.id}`
    const turning = e.rpm > 0
    put(
      `${base}.state`,
      e.running || (e.p.type === 'electric' && turning) ? 'started' : 'stopped'
    )
    put(`${base}.revolutions`, round3(e.rpm / 60))
    put(`${base}.engineLoad`, round3(e.load))
    put(`${base}.runTime`, Math.round(e.runS))
    // a hybrid's motor turns the shaft in gear while its diesel is still
    put(
      `${base}.transmission.gear`,
      turning || e.electricMode ? 'Forward' : 'Neutral'
    )
    if (e.p.type === 'electric') {
      put(
        `${base}.temperature`,
        round2(e.coolantC + e.tempDrift.value + KELVIN)
      )
      return
    }
    put(
      `${base}.coolantTemperature`,
      round2(e.coolantC + e.tempDrift.value + KELVIN)
    )
    put(`${base}.oilTemperature`, round2(e.oilC + e.tempDrift.value + KELVIN))
    put(`${base}.exhaustTemperature`, round2(e.exhaustC + KELVIN))
    const rpmShare = e.running
      ? (e.rpm - e.p.idleRpm) / (e.p.maxRpm - e.p.idleRpm)
      : 0
    // oil thins as an overheating engine runs on, and its pressure falls
    const thinning =
      1 -
      OIL_THINNING *
        clamp((e.coolantC - OIL_THINS_FROM_C) / OIL_THINS_OVER_C, 0, 1)
    put(
      `${base}.oilPressure`,
      e.running
        ? Math.round(
            (1.8 + 2.5 * clamp(rpmShare, 0, 1) + e.pressureDrift.value) *
              thinning *
              PASCALS_PER_BAR
          )
        : 0
    )
    put(`${base}.fuel.rate`, e.fuelLph / LITRES_PER_M3 / SECONDS_PER_HOUR)
    const charged = this.alternatorBank()
    put(
      `${base}.alternatorVoltage`,
      e.running && charged ? round2(charged.voltage) : 0
    )
  }

  private putGenerator(
    g: GeneratorState,
    put: (path: string, value: unknown) => void
  ): void {
    const base = `propulsion.${g.p.id}`
    const share = g.running ? g.loadKw / g.p.powerKw : 0
    // an isochronous governor holds speed, with a little droop under load
    const rpm = g.running
      ? g.p.rpm * (1 - 0.01 * share) * (1 + g.rpmDrift.value)
      : 0
    put(`${base}.state`, g.running ? 'started' : 'stopped')
    put(`${base}.revolutions`, round3(rpm / 60))
    put(`${base}.engineLoad`, round3(share))
    put(`${base}.runTime`, Math.round(g.runS))
    put(
      `${base}.coolantTemperature`,
      round2(g.coolantC + g.tempDrift.value + KELVIN)
    )
    put(
      `${base}.oilPressure`,
      g.running
        ? Math.round((3.6 + g.pressureDrift.value) * PASCALS_PER_BAR)
        : 0
    )
    put(`${base}.fuel.rate`, g.fuelLph / LITRES_PER_M3 / SECONDS_PER_HOUR)
  }

  private putAc(
    id: string,
    kw: number,
    live: boolean,
    put: (path: string, value: unknown) => void
  ): void {
    const p = this.profile
    const generator = this.generators.find((g) => g.p.id === id)
    const frequency = live
      ? p.acFrequency *
        (generator
          ? (1 - 0.01 * (kw / generator.p.powerKw)) *
            (1 + generator.rpmDrift.value)
          : 1)
      : 0
    const voltage = live
      ? p.acVoltage * (1 - 0.01 * (generator ? kw / generator.p.powerKw : 0))
      : 0
    const phases = p.acPhases === 3 ? ['A', 'B', 'C'] : ['single']
    const perPhaseW = (kw * 1000) / phases.length
    for (const phase of phases) {
      const base = `electrical.ac.${id}.phase.${phase}`
      const current = voltage ? perPhaseW / (voltage * POWER_FACTOR) : 0
      put(`${base}.lineNeutralVoltage`, round2(voltage))
      if (p.acPhases === 3)
        put(`${base}.lineLineVoltage`, round2(voltage * Math.sqrt(3)))
      put(`${base}.frequency`, round3(frequency))
      put(`${base}.current`, round2(current))
      put(`${base}.realPower`, Math.round(perPhaseW))
      put(`${base}.apparentPower`, Math.round(perPhaseW / POWER_FACTOR))
      put(`${base}.powerFactor`, live ? POWER_FACTOR : 0)
    }
  }

  private putBank(
    b: BankState,
    put: (path: string, value: unknown) => void
  ): void {
    const base = `electrical.batteries.${b.p.id}`
    put(`${base}.voltage`, round2(b.voltage))
    put(`${base}.current`, round2(b.currentA))
    put(`${base}.temperature`, round2(b.tempC + KELVIN))
    put(`${base}.capacity.stateOfCharge`, round3(b.soc))
    put(`${base}.capacity.stateOfHealth`, round3(b.health))
    // a bank resting within a trickle of zero has no time remaining worth showing
    if (b.currentA < -RESTING_C * b.p.capacityAh) {
      const usableAh = Math.max(0, b.soc - 0.1) * b.p.capacityAh * b.health
      put(
        `${base}.capacity.timeRemaining`,
        Math.round((usableAh / -b.currentA) * SECONDS_PER_HOUR)
      )
    }
    if (b.chargerW > 0 || b.chargerTripped) {
      const charger = `electrical.chargers.${b.p.id}`
      put(`${charger}.voltage`, round2(b.voltage))
      put(`${charger}.current`, round2(b.chargerW / b.voltage))
      // the specification has no fault mode, so a tripped charger is `other`
      put(
        `${charger}.chargingMode`,
        b.chargerTripped ? 'other' : chargingMode(b)
      )
    }
  }

  private putSolar(
    s: SolarState,
    put: (path: string, value: unknown) => void
  ): void {
    const base = `electrical.solar.${s.p.id}`
    const bank = this.bank(s.p.bank)
    const bankV = bank ? bank.voltage : 0
    const panelV = s.powerW > 0 ? bankV * 1.25 : 0
    put(`${base}.controllerMode`, s.powerW > 0 ? 'MPPT' : 'idle')
    put(`${base}.panelVoltage`, round2(panelV))
    put(`${base}.panelCurrent`, round2(panelV ? s.powerW / panelV : 0))
    put(`${base}.panelPower`, Math.round(s.powerW))
    put(`${base}.yieldToday`, Math.round(s.yieldJ))
    put(`${base}.voltage`, round2(bankV))
    put(`${base}.current`, round2(bankV ? s.powerW / bankV : 0))
    if (bank && s.powerW > 0) put(`${base}.chargingMode`, chargingMode(bank))
  }

  private putTurbine(
    t: TurbineState,
    put: (path: string, value: unknown) => void
  ): void {
    const base = `electrical.alternators.${t.p.id}`
    const bank = this.bank(t.p.bank)
    const bankV = bank ? bank.voltage : 0
    put(`${base}.revolutions`, round3(t.revolutionsHz))
    put(`${base}.voltage`, round2(bankV))
    put(`${base}.current`, round2(bankV ? t.powerW / bankV : 0))
    if (bank && t.powerW > 0) put(`${base}.chargingMode`, chargingMode(bank))
  }

  private putTank(
    t: TankState,
    put: (path: string, value: unknown) => void
  ): void {
    const base = `tanks.${t.type}.${t.p.id}`
    const moving = this.motion.sogKn > 0.5 ? 1 : 0.2
    const level = clamp(t.litres / t.p.capacityL + t.slosh.value * moving, 0, 1)
    put(`${base}.capacity`, t.p.capacityL / LITRES_PER_M3)
    put(`${base}.currentLevel`, round3(level))
    put(
      `${base}.currentVolume`,
      Math.round(level * t.p.capacityL) / LITRES_PER_M3
    )
  }

  private putWind(put: (path: string, value: unknown) => void): void {
    const bow = this.navigation.heading * RADIANS
    const from = this.windDeg * RADIANS
    const apparent = this.apparentWind()
    put(
      'environment.wind.speedTrue',
      round2(this.windKn * METRES_PER_SECOND_PER_KNOT)
    )
    put('environment.wind.directionTrue', round3(from))
    put('environment.wind.angleTrueWater', roundAngle(wrapPi(from - bow)))
    put('environment.wind.speedApparent', round2(apparent.speedMs))
    put('environment.wind.angleApparent', roundAngle(apparent.angle))
  }

  /** a snapshot of the state behind the values, for the status line and the soak */
  summary(): SystemsSummary {
    const fresh = this.tanksOf('freshWater')
    return {
      enginesRunning: this.engines.filter((e) => e.running).length,
      generatorsRunning: this.generators.filter((g) => g.running).length,
      generators: Object.fromEntries(
        this.generators.map((g) => [g.p.id, g.running])
      ),
      sailing: this.sailing,
      fuelL: this.tanksOf('fuel').reduce((sum, t) => sum + t.litres, 0),
      houseSoc: this.banks.find((b) => b.p.role === 'house')?.soc,
      airC: this.airC,
      weather: {
        windKn: this.windKn,
        windDeg: this.windDeg,
        pressurePa: this.pressurePa,
        airC: this.airC,
        waterC: this.waterC,
        humidity: this.humidity,
        tideM: this.tide?.heightM
      },
      water: {
        currentKn: this.navigation.current.kn,
        currentToDeg: this.navigation.current.toDeg,
        sampled: this.sampledCurrent !== undefined,
        stwKn: this.navigation.speedThroughWaterKn,
        leewayDeg: this.navigation.leeway
      },
      sails: this.sail && {
        propulsion: this.sail.plan.propulsion,
        set: this.sail.sails
          .filter((s) => this.sail!.plan.sails.includes(s.id))
          .map((s) => ({ id: s.id, name: s.name })),
        activeAreaM2: this.sail.activeAreaM2,
        totalAreaM2: this.sail.fullAreaM2,
        performance: this.performance()
      },
      hotelKw: this.hotelKw,
      hvacKw: this.hvacKw,
      watermakerRunning: this.watermakerRunning,
      freshLevel: fresh.length ? fillLevel(fresh) : undefined,
      freshUsedL: this.freshUsedL,
      madeL: this.madeL,
      shoreWaterL: this.shoreWaterL,
      pumpOuts: Object.fromEntries(this.pumpOuts),
      thrusters: Object.fromEntries(
        this.thrusters.map((t) => [
          t.p.id,
          { running: t.running, runS: t.runS, peak: t.peak }
        ])
      ),
      apparentWindMs: this.apparentWind().speedMs,
      turbineW: this.turbines.reduce((sum, t) => sum + t.powerW, 0)
    }
  }
}

/** what the polar makes of her sailing now, degrees and knots */
export interface PerformanceNow {
  /** the true wind angle off the bow, positive to starboard */
  twaDeg: number
  polarKn: number
  /** her speed through the water over the polar's */
  ratio: number
  /** towards the wind, negative running away from it */
  vmgKn: number
  beat: OptimumAngle
  gybe: OptimumAngle
  /** the beat upwind, the gybe downwind */
  target: OptimumAngle
  /** her heading on the other tack, or gybe, at the same angle to the wind */
  tackDeg: number
}

export interface SystemsSummary {
  enginesRunning: number
  generatorsRunning: number
  generators: Record<string, boolean>
  sailing: boolean
  fuelL: number
  houseSoc?: number
  airC: number
  /** the true wind (with the seed's gusts and shifts), the air, the water and the tide */
  weather: {
    windKn: number
    windDeg: number
    pressurePa: number
    airC: number
    waterC: number
    humidity?: number
    tideM?: number
  }
  /** the water she moves through: the current, her speed through it and her leeway */
  water: {
    currentKn: number
    currentToDeg: number
    /** the current is the sample's, not the seeded one */
    sampled: boolean
    stwKn: number
    leewayDeg: number
  }
  /** a sailing boat's sails and what the polar makes of her sailing */
  sails?: {
    propulsion: 'sailing' | 'motor-sailing' | 'motoring' | null
    set: { id: string; name: string }[]
    activeAreaM2: number
    totalAreaM2: number
    performance?: PerformanceNow
  }
  hotelKw: number
  /** air conditioning load being carried */
  hvacKw: number
  watermakerRunning: boolean
  freshLevel?: number
  /** fresh water used, made by the water maker, and taken from the dock, litres so far */
  freshUsedL: number
  madeL: number
  shoreWaterL: number
  /** pump-outs started so far, by tank id */
  pumpOuts: Record<string, number>
  apparentWindMs: number
  turbineW: number
  /** each thruster: running now, seconds run, and its hardest burst on its bank */
  thrusters: Record<
    string,
    {
      running: boolean
      runS: number
      peak?: { drawW: number; currentA: number; voltage: number }
    }
  >
}

function tankKey(t: TankState): string {
  return `${t.type}.${t.p.id}`
}

function saveUnit<T extends object>(
  id: string,
  unit: T,
  fields: readonly (keyof T & string)[],
  drifts: readonly (keyof T & string)[]
): UnitState {
  const values: Record<string, Scalar> = {}
  for (const f of fields) values[f] = (unit[f] as Scalar | undefined) ?? null
  const saved: Record<string, DriftState> = {}
  for (const d of drifts) saved[d] = (unit[d] as Drift).save()
  return { id, values, drifts: saved }
}

/** a saved value fits where it has the type the fresh model gave it, or is empty where that is allowed */
function fits(value: unknown, fresh: Scalar | undefined): boolean {
  if (value === null || value === undefined) {
    return fresh === null || fresh === undefined
  }
  if (typeof value === 'number' && !Number.isFinite(value)) return false
  return fresh === null || fresh === undefined || typeof value === typeof fresh
}

function checkedDrift(saved: DriftState | undefined, name: string): DriftState {
  if (!Number.isFinite(saved?.value) || !Number.isInteger(saved?.rng)) {
    throw new StaleStateError(`saved systems state has a bad ${name} drift`)
  }
  return saved as DriftState
}

/** the saved units must be the profile's own, in its order, each with every field */
function restoreUnits<T extends object>(
  kind: string,
  units: T[],
  saved: UnitState[] | undefined,
  idOf: (unit: T) => string,
  fields: readonly (keyof T & string)[],
  drifts: readonly (keyof T & string)[]
): void {
  const ids = units.map(idOf)
  if (
    !Array.isArray(saved) ||
    saved.length !== ids.length ||
    saved.some((s, i) => s?.id !== ids[i])
  ) {
    throw new StaleStateError(`saved ${kind} do not match the profile's`)
  }
  units.forEach((unit, i) => {
    const s = saved[i]
    const record = unit as Record<string, unknown>
    for (const f of fields) {
      const value = s.values?.[f]
      if (!fits(value, record[f] as Scalar | undefined)) {
        throw new StaleStateError(`saved ${kind} ${s.id} has a bad ${f}`)
      }
    }
    for (const f of fields) record[f] = s.values[f] ?? undefined
    for (const d of drifts) {
      ;(record[d] as Drift).restore(checkedDrift(s.drifts?.[d], `${s.id} ${d}`))
    }
  })
}

/** a 12 V block's resistance times its capacity: 4 milliohms at 100 Ah */
const BLOCK_RESISTANCE_OHM_AH = 0.4
/** below this share of its capacity in amps, a bank is resting rather than discharging */
const RESTING_C = 0.001
/** a bank is never drawn below this state of charge */
const SOC_FLOOR = 0.02

/** a 12 V block's open-circuit voltage at a state of charge */
export function openCircuitVolts(chemistry: string, soc: number): number {
  return chemistry === 'LiFePO4'
    ? 12.9 + 0.5 * (soc - 0.5) + Math.max(0, soc - 0.97) * 15
    : 11.8 + 1.0 * soc
}

/** energy stored in a bank at a state of charge: its open-circuit voltage integrated over its charge */
export function storedEnergyJ(
  bank: BankProfile,
  health: number,
  soc: number
): number {
  const integral =
    bank.chemistry === 'LiFePO4'
      ? 12.9 * soc +
        0.25 * (soc - 0.5) ** 2 +
        7.5 * Math.max(0, soc - 0.97) ** 2
      : 11.8 * soc + 0.5 * soc * soc
  return (
    (bank.nominalVoltage / 12) *
    integral *
    bank.capacityAh *
    health *
    SECONDS_PER_HOUR
  )
}

/** charge power a bank will take: full rate until nearly full, tapering to nothing */
function acceptanceW(b: BankState): number {
  const fullRateA = 0.3 * b.p.capacityAh
  return fullRateA * b.p.nominalVoltage * clamp((1 - b.soc) / 0.08, 0, 1)
}

/** breakfast, lunch and dinner, local solar time */
function isMealTime(hour: number): boolean {
  return (
    (hour >= 7 && hour < 8.5) ||
    (hour >= 12 && hour < 13.5) ||
    (hour >= 18 && hour < 20)
  )
}

/** fresh water use through the day, as a multiple of the average rate */
function waterUse(hour: number): number {
  if (hour >= 6 && hour < 9) return 2
  if (hour >= 17 && hour < 21) return 1.6
  if (hour >= 23 || hour < 6) return 0.2
  return 1
}

function fillLevel(tanks: TankState[]): number {
  const capacity = tanks.reduce((sum, t) => sum + t.p.capacityL, 0)
  return tanks.reduce((sum, t) => sum + t.litres, 0) / capacity
}

function fillTanks(tanks: TankState[], litres: number): void {
  for (const t of tanks) {
    t.litres = Math.min(t.p.capacityL, t.litres + litres / tanks.length)
  }
}

function chargingMode(b: BankState): string {
  return b.soc < 0.9 ? 'bulk' : b.soc < 0.98 ? 'acceptance' : 'float'
}

/** first-order approach to a target with time constant `tauS` */
function relax(
  value: number,
  target: number,
  dtS: number,
  tauS: number
): number {
  return target + (value - target) * Math.exp(-dtS / tauS)
}

function clamp(x: number, low: number, high: number): number {
  return Math.min(high, Math.max(low, x))
}

function wrapPi(angle: number): number {
  return Math.atan2(Math.sin(angle), Math.cos(angle))
}

const round2 = (x: number) => Math.round(x * 100) / 100
const round3 = (x: number) => Math.round(x * 1000) / 1000
const round4 = (x: number) => Math.round(x * 10000) / 10000
const wrap180 = (deg: number) => ((((deg + 180) % 360) + 360) % 360) - 180
const norm360 = (deg: number) => ((deg % 360) + 360) % 360
/** rounded, and kept inside -pi to pi, which rounding alone can step outside */
const roundAngle = (x: number) => clamp(round3(x), -Math.PI, Math.PI)
const iso = (ms: number) => new Date(ms).toISOString()
