import { Delta, DeltaSource, SOURCE } from '../soak/deltas'
import {
  BankProfile,
  EngineProfile,
  GeneratorProfile,
  SolarProfile,
  TankProfile,
  TankType,
  VesselProfile,
  WindTurbineProfile,
  ZoneProfile
} from '../vessels/profile'
import { Drift, Rng } from './random'
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
}

export interface SystemsOptions {
  seed: number
  /** scenario time the model starts at, ms since the epoch */
  startMs: number
  /** depth below the surface at a position, metres, or undefined with no data */
  depthAt?: (lat: number, lon: number) => number | undefined
}

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
/** fuel an idling engine burns, as a share of rated power */
const IDLE_FUEL_SHARE = 0.005
/** a generator's fuel at no load, as a share of its full-load fuel */
const GENERATOR_NO_LOAD_FUEL = 0.25
const ELECTRIC_DRIVE_EFFICIENCY = 0.92
/** a hybrid drives on electric alone up to this share of the motor's rating */
const ELECTRIC_ONLY_SHARE = 0.6
const CHARGER_EFFICIENCY = 0.9
const POWER_FACTOR = 0.9
/** a generator is loaded to at most this share before another is started */
const GENERATOR_SHARE = 0.8
const SAIL_MIN_WIND_KN = 6
const SAIL_MIN_SPEED_KN = 3.5
/** grey water as a share of fresh water used */
const GREY_SHARE = 0.7
const BLACK_L_PER_PERSON_DAY = 15
const HOLDING_PUMP_OUT_LEVEL = 0.85
const HOLDING_PUMP_OUT_MIN_KN = 5
const HOLDING_PUMP_OUT_L_PER_H = 2000
const DAY_TANK_LOW = 0.5
const DAY_TANK_FULL = 0.95
/** on the inverter a boat sheds all but the occasional galley load */
const INVERTER_SHARE = 0.06
/** above this length every generator-equipped boat carries its AC load on generators */
const LARGE_YACHT_M = 24

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

export class SystemsModel {
  private nowMs: number
  private readonly engines: EngineState[]
  private readonly generators: GeneratorState[]
  private readonly banks: BankState[]
  private readonly tanks: TankState[]
  private readonly solar: SolarState[]
  private readonly turbines: TurbineState[]
  private readonly zones: ZoneState[]
  private readonly sounders: SounderState[]
  private readonly windBaseKn: number
  private readonly windBaseDeg: number
  private readonly windSpeedDrift: Drift
  private readonly windDirDrift: Drift
  private readonly airDrift: Drift
  private readonly pressureDrift: Drift
  private readonly loadDrift: Drift
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
  private hotelKw = 0
  private shoreKw = 0
  private hvacOn = false
  private sailing = false
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
              : r.between(0.55, 0.95)
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
      cloud: new Drift(rng(`solar:${p.id}`), 0.12, 900)
    }))
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
  }

  get scenarioMs(): number {
    return this.nowMs
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
    this.stepWeather(dt)
    this.stepPropulsion(dt)
    this.stepAc(dt)
    this.stepZones(dt)
    this.stepElectrical(dt)
    this.stepTanks(dt)
    this.stepSounders(dt)
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
    this.airC = baseC + 4 * diurnal + this.airDrift.step(dt)
    this.waterC = baseC
    this.pressurePa = 101325 + this.pressureDrift.step(dt)
    // a sea breeze freshens through the afternoon
    this.windKn = Math.max(
      0,
      this.windBaseKn + 3 * diurnal + this.windSpeedDrift.step(dt)
    )
    this.windDeg = (this.windBaseDeg + this.windDirDrift.step(dt) + 360) % 360
  }

  private stepPropulsion(dt: number): void {
    const p = this.profile
    const { sogKn, atBerth } = this.motion
    const speedShare = Math.min(1, sogKn / p.maxSpeedKn)
    this.sailing =
      p.rig === 'sail' &&
      !atBerth &&
      sogKn >= SAIL_MIN_SPEED_KN &&
      this.windKn >= SAIL_MIN_WIND_KN
    const underway = !atBerth && !this.sailing
    const ratedKw = p.engines.reduce((sum, e) => sum + e.powerKw, 0)
    // propeller law: power goes with the cube of speed
    const demandKw = (ratedKw * speedShare ** 3) / Math.max(1, p.engines.length)

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
        demandKw <= ELECTRIC_ONLY_SHARE * ep.electricKw &&
        bank &&
        bank.soc > 0.25
      ) {
        e.running = false
        e.electricMode = true
        e.bankKw = demandKw / ELECTRIC_DRIVE_EFFICIENCY
      } else {
        e.running = true
        e.shaftKw = Math.min(ep.powerKw, demandKw)
        if (ep.type === 'hybrid' && ep.electricKw && bank && bank.soc < 0.9) {
          // the inline drive runs as a generator, charging the bank off the diesel
          const regenKw = Math.min(0.25 * ep.electricKw, ep.powerKw - e.shaftKw)
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

  /** Hotel load, who carries it, and which generators run. */
  private stepAc(dt: number): void {
    const p = this.profile
    const { atBerth } = this.motion
    const hour = solarHour(this.nowMs, this.motion.lon)
    const meal =
      (hour >= 7 && hour < 8.5) ||
      (hour >= 12 && hour < 13.5) ||
      (hour >= 18 && hour < 20)
    const awake = hour >= 6.5 && hour < 22.5
    const baseKw =
      0.012 *
      p.lengthM ** 2.2 *
      (awake ? 1 : 0.6) *
      (meal ? 1.3 : 1) *
      (1 + this.loadDrift.step(dt))
    const hvacKw =
      0.4 * 0.012 * p.lengthM ** 2.2 * clamp((this.airC - 22) / 8, 0, 1)

    const hasGenerators = this.generators.length > 0
    const large = p.lengthM >= LARGE_YACHT_M
    this.shoreKw = 0
    for (const g of this.generators) g.loadKw = 0

    if (atBerth) {
      for (const g of this.generators) g.running = false
      this.hvacOn = hasGenerators
      this.shoreKw = hasGenerators ? baseKw + hvacKw : 0
    } else if (large && hasGenerators) {
      const totalKw = baseKw + hvacKw
      const each = this.generators[0].p.powerKw * GENERATOR_SHARE
      const needed = Math.min(
        this.generators.length,
        Math.max(1, Math.ceil(totalKw / each))
      )
      this.generators.forEach((g, i) => {
        g.running = i < needed
      })
      this.hvacOn = true
    } else if (hasGenerators) {
      // a smaller boat runs its generator to charge, and has the air conditioning while it runs
      for (const g of this.generators) {
        const bank = this.bank(g.p.chargesBank)
        if (!bank) continue
        const startAt = bank.p.role === 'propulsion' ? 0.3 : 0.45
        const stopAt = bank.p.role === 'propulsion' ? 0.8 : 0.9
        if (bank.soc < startAt) g.running = true
        else if (bank.soc > stopAt) g.running = false
      }
      this.hvacOn = this.generators.some((g) => g.running)
    } else {
      this.hvacOn = false
    }

    const running = this.generators.filter((g) => g.running)
    const inverterKw =
      hasGenerators && !atBerth && !running.length ? INVERTER_SHARE * baseKw : 0
    const acKw =
      atBerth || !running.length ? 0 : baseKw + (this.hvacOn ? hvacKw : 0)
    for (const g of running) g.loadKw = acKw / running.length

    // chargers run from whatever carries the AC
    for (const b of this.banks) b.chargerW = 0
    const chargeFrom = (bank: BankState | undefined, availableKw: number) => {
      if (!bank || bank.p.role === 'start') return 0
      const limitW = acceptanceW(bank)
      const w = Math.min(limitW, availableKw * 1000 * CHARGER_EFFICIENCY)
      bank.chargerW += w
      return w / CHARGER_EFFICIENCY / 1000
    }
    if (atBerth && hasGenerators) {
      for (const b of this.banks) this.shoreKw += chargeFrom(b, 0.2 * p.lengthM)
    }
    for (const g of running) {
      g.loadKw += chargeFrom(this.bank(g.p.chargesBank), g.p.powerKw - g.loadKw)
      g.loadKw = Math.min(g.p.powerKw, g.loadKw)
    }
    this.inverterKw = inverterKw

    for (const g of this.generators) {
      const share = g.running ? g.loadKw / g.p.powerKw : 0
      g.fuelLph = g.running
        ? FUEL_L_PER_KWH.diesel *
          g.p.powerKw *
          (GENERATOR_NO_LOAD_FUEL + (1 - GENERATOR_NO_LOAD_FUEL) * share)
        : 0
      if (g.running) g.runS += dt
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

  private stepElectrical(dt: number): void {
    const p = this.profile
    const sunSin = Math.max(
      0,
      Math.sin(sunElevation(this.nowMs, this.motion.lat, this.motion.lon))
    )
    const day = Math.floor(
      (this.nowMs / 1000 + (this.motion.lon / 15) * SECONDS_PER_HOUR) / DAY_S
    )
    const flowW = new Map<BankState, number>()
    const add = (bank: BankState | undefined, w: number) => {
      if (bank) flowW.set(bank, (flowW.get(bank) ?? 0) + w)
    }

    for (const s of this.solar) {
      if (s.day !== day) {
        s.day = day
        s.yieldJ = 0
      }
      const cloud = clamp(1 - Math.abs(s.cloud.step(dt)), 0.3, 1)
      const bank = this.bank(s.p.bank)
      s.powerW = bank
        ? Math.min(
            s.p.peakW * 0.85 * sunSin ** 1.2 * cloud,
            acceptanceW(bank) + 1
          )
        : 0
      s.yieldJ += s.powerW * dt
      add(bank, s.powerW)
    }
    const apparentMs = this.apparentWind().speedMs
    for (const t of this.turbines) {
      const bank = this.bank(t.p.bank)
      const share = clamp((apparentMs - 3) / (12.5 - 3), 0, 1)
      t.powerW = bank
        ? Math.min(t.p.ratedW * share ** 3, acceptanceW(bank) + 1)
        : 0
      t.revolutionsHz = apparentMs > 2 ? Math.min(25, 2 * apparentMs) : 0
      add(bank, t.powerW)
    }
    for (const e of this.engines) {
      add(this.bank(e.p.bank), -e.bankKw * 1000)
      if (e.running && e.p.type !== 'electric' && e.p.type !== 'hybrid') {
        // engine alternators: the start bank first, the house bank through a charge splitter
        for (const b of this.banks) {
          if (b.p.role === 'propulsion') continue
          add(b, Math.min(acceptanceW(b), 0.03 * e.p.powerKw * 1000))
        }
      }
    }
    for (const b of this.banks) add(b, b.chargerW)

    const house = this.bank(this.banks.find((b) => b.p.role === 'house')?.p.id)
    if (house) {
      let dcW = 3 * p.lengthM ** 1.4
      for (const z of this.zones) {
        if (
          z.compressorOn &&
          (z.p.kind === 'fridge' || z.p.kind === 'freezer')
        ) {
          dcW +=
            (z.p.kind === 'freezer' ? 80 : 50) * Math.max(1, p.lengthM / 15)
        }
      }
      add(house, -(dcW + (this.inverterKw * 1000) / CHARGER_EFFICIENCY))
    }
    for (const b of this.banks) {
      if (b.p.role === 'start') add(b, -2.5 * (b.p.nominalVoltage / 12))
    }

    for (const b of this.banks) {
      const w = flowW.get(b) ?? 0
      const scale = b.p.nominalVoltage / 12
      b.currentA = w / Math.max(1, b.voltage)
      b.soc = clamp(
        b.soc +
          (b.currentA * dt) / SECONDS_PER_HOUR / (b.p.capacityAh * b.health),
        0.02,
        1
      )
      const ocv =
        b.p.chemistry === 'LiFePO4'
          ? 12.9 + 0.5 * (b.soc - 0.5) + Math.max(0, b.soc - 0.97) * 15
          : 11.8 + 1.0 * b.soc
      const resistance = (0.004 * 100) / b.p.capacityAh
      const absorption = b.p.chemistry === 'LiFePO4' ? 14.2 : 14.4
      const perBlock = Math.min(
        ocv + (b.currentA / scale) * resistance * scale,
        b.currentA > 0 ? absorption : Infinity
      )
      b.voltage = scale * perBlock * (1 + b.drift.step(dt))
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

  private stepTanks(dt: number): void {
    const p = this.profile
    const tank = (type: TankType, id: string | undefined) =>
      this.tanks.find((t) => t.type === type && t.p.id === id)
    const ofType = (type: TankType) => this.tanks.filter((t) => t.type === type)
    const fuel = ofType('fuel')
    const draw = (t: TankState | undefined, litres: number) => {
      if (!t) return
      if (t.litres < litres) {
        // crossfeed from the fullest tank when this one runs dry
        const fullest = fuel.reduce((a, b) => (b.litres > a.litres ? b : a), t)
        fullest.litres = Math.max(0, fullest.litres - litres)
      } else {
        t.litres -= litres
      }
    }
    for (const e of this.engines)
      draw(tank('fuel', e.p.fuelTank), (e.fuelLph * dt) / SECONDS_PER_HOUR)
    for (const g of this.generators)
      draw(tank('fuel', g.p.fuelTank), (g.fuelLph * dt) / SECONDS_PER_HOUR)

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

    const hour = solarHour(this.nowMs, this.motion.lon)
    const busy =
      hour >= 6 && hour < 9
        ? 2
        : hour >= 17 && hour < 21
          ? 1.6
          : hour >= 23 || hour < 6
            ? 0.2
            : 1
    const perPerson =
      p.lengthM >= LARGE_YACHT_M ? 100 : p.lengthM >= 10 ? 60 : 30
    const freshL = (p.persons * perPerson * busy * dt) / DAY_S
    const fresh = ofType('freshWater')
    const source = fresh.find((t) => t.litres > 0.2 * t.p.capacityL) ?? fresh[0]
    if (source) source.litres = Math.max(0, source.litres - freshL)
    const fill = (tanks: TankState[], litres: number) => {
      for (const t of tanks)
        t.litres = Math.min(t.p.capacityL, t.litres + litres / tanks.length)
    }
    if (source) fill(ofType('wasteWater'), GREY_SHARE * freshL)
    fill(
      ofType('blackWater'),
      (p.persons * BLACK_L_PER_PERSON_DAY * busy * dt) / DAY_S
    )
    for (const t of [...ofType('wasteWater'), ...ofType('blackWater')]) {
      if (
        t.litres >= HOLDING_PUMP_OUT_LEVEL * t.p.capacityL &&
        this.motion.sogKn >= HOLDING_PUMP_OUT_MIN_KN
      ) {
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
      const depth = depthAt(lat + dLat, lon + dLon)
      s.reading =
        depth === undefined ? undefined : depth + s.bias + s.drift.value
    }
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
    return {
      speedMs: Math.hypot(east, north),
      angle: wrapPi(apparentFrom - course)
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
    for (const g of this.generators) this.putGenerator(g, put)
    if (this.profile.wind) this.putWind(put)
    put(
      'navigation.speedThroughWater',
      this.motion.sogKn * METRES_PER_SECOND_PER_KNOT
    )

    if (slow) {
      for (const g of this.generators)
        this.putAc(g.p.id, g.running ? g.loadKw : 0, g.running, put)
      if (this.shoreKw > 0) this.putAc('shore', this.shoreKw, true, put)
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
    put(`${base}.transmission.gear`, turning ? 'Forward' : 'Neutral')
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
    put(
      `${base}.oilPressure`,
      e.running
        ? Math.round(
            (1.8 + 2.5 * clamp(rpmShare, 0, 1) + e.pressureDrift.value) *
              PASCALS_PER_BAR
          )
        : 0
    )
    put(`${base}.fuel.rate`, e.fuelLph / LITRES_PER_M3 / SECONDS_PER_HOUR)
    const start = this.banks.find((b) => b.p.id === e.p.bank)
    put(
      `${base}.alternatorVoltage`,
      e.running && start ? round2(start.voltage) : 0
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
    if (b.currentA < 0) {
      const usableAh = Math.max(0, b.soc - 0.1) * b.p.capacityAh * b.health
      put(
        `${base}.capacity.timeRemaining`,
        Math.round((usableAh / -b.currentA) * SECONDS_PER_HOUR)
      )
    }
    if (b.chargerW > 0) {
      const charger = `electrical.chargers.${b.p.id}`
      put(`${charger}.voltage`, round2(b.voltage))
      put(`${charger}.current`, round2(b.chargerW / b.voltage))
      put(`${charger}.chargingMode`, chargingMode(b))
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
    const course = this.motion.cogDeg * RADIANS
    const from = this.windDeg * RADIANS
    const apparent = this.apparentWind()
    put(
      'environment.wind.speedTrue',
      round2(this.windKn * METRES_PER_SECOND_PER_KNOT)
    )
    put('environment.wind.directionTrue', round3(from))
    put('environment.wind.angleTrueWater', round3(wrapPi(from - course)))
    put('environment.wind.speedApparent', round2(apparent.speedMs))
    put('environment.wind.angleApparent', round3(apparent.angle))
  }

  /** a snapshot for tests and the status line */
  summary(): {
    enginesRunning: number
    generatorsRunning: number
    sailing: boolean
    fuelL: number
    houseSoc?: number
  } {
    return {
      enginesRunning: this.engines.filter((e) => e.running).length,
      generatorsRunning: this.generators.filter((g) => g.running).length,
      sailing: this.sailing,
      fuelL: this.tanks
        .filter((t) => t.type === 'fuel')
        .reduce((s, t) => s + t.litres, 0),
      houseSoc: this.banks.find((b) => b.p.role === 'house')?.soc
    }
  }
}

/** charge power a bank will take: full rate until nearly full, tapering to nothing */
function acceptanceW(b: BankState): number {
  const fullRateA = 0.3 * b.p.capacityAh
  return fullRateA * b.p.nominalVoltage * clamp((1 - b.soc) / 0.08, 0, 1)
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
const iso = (ms: number) => new Date(ms).toISOString()
