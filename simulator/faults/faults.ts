import { Delta } from '../soak/deltas'
import { SystemFaults } from '../systems/model'
import { Rng } from '../systems/random'
import { VesselProfile } from '../vessels/profile'

/**
 * Things that go wrong on a real boat. A fault comes on, develops at the rate it would,
 * and clears on its own when it would (a crew clearing a blocked intake, a receiver
 * regaining its fix) or when cleared by hand. The paths carry it the way a real sensor
 * would: the value goes wrong, and where the boat's own alarm would sound, the plugin
 * raises the specification's notification for that path, and clears it when the value is
 * back.
 *
 * A fault touches the boat in one of two places. Those that change what happens on board
 * (an overheating engine, a dead cell, a charger tripping, a generator that will not
 * start, water coming in) work inside the systems model, through `SystemFaults`, in the
 * model's own fixed steps. Those that change only what a sensor says (a stuck gauge, a
 * silent sounder, a lost fix, a frozen wind instrument, a stale value) are applied to
 * the deltas as they go out. Either way a run depends only on the seed, the scenario
 * times and the faults raised, never on the time multiplier.
 */
export const FAULT_KINDS = [
  'engineOverheat',
  'generatorNoStart',
  'batteryCellFailure',
  'chargerFailure',
  'alternatorFailure',
  'bilgeFlooding',
  'fuelGaugeStuck',
  'depthSounderSilent',
  'gnssLost',
  'windInstrumentFrozen',
  'staleSensor'
] as const
export type FaultKind = (typeof FAULT_KINDS)[number]

const MINUTE_MS = 60000
const KELVIN = 273.15
const PASCALS_PER_BAR = 100000
const SECONDS_PER_HOUR = 3600

/** the engine panel's coolant warning and alarm, degrees C */
const COOLANT_WARN_C = 95
const COOLANT_ALARM_C = 100
/** an overheat is over once the coolant is back below this */
const COOLANT_NORMAL_C = 90
/** the engine panel's low oil pressure alarm, running */
const OIL_PRESSURE_ALARM_BAR = 1
/** a failing cell takes this long to fail completely */
const CELL_FAILURE_MIN = 60
/** a battery monitor's low voltage warning and alarm, per 12 V */
const BATTERY_WARN_V = 11.8
const BATTERY_ALARM_V = 11
/** bilge sump litres per (length in metres)^1.5, and pump litres an hour */
const SUMP_L_PER_M15 = 2
const PUMP_L_PER_H = 1000
const PUMP_L_PER_H_PER_M = 150
/** watts a bilge pump draws per litre an hour it moves */
const PUMP_W_PER_L_PER_H = 0.05
/** the leak outruns the pump by this much, reached over this many minutes */
const LEAK_SHARE_OF_PUMP = 1.3
const LEAK_RISE_MIN = 5
/** float switch on and off, and the high water switch, as shares of the sump */
const PUMP_ON_SHARE = 0.3
const PUMP_OFF_SHARE = 0.05
const HIGH_WATER_SHARE = 0.8
/** the bilge pump has run this long without stopping */
const PUMP_RUNNING_WARN_S = 120
/** a receiver regaining its fix: tracking satellites, then a fix, then settled */
const FIX_ACQUIRE_S = 20
const FIX_SETTLE_S = 60
const SATELLITES_WITHOUT_FIX = 2
const SATELLITES_FOR_FIX = 4

/** what a notification carries */
export interface NotificationValue {
  state: 'normal' | 'warn' | 'alarm'
  method: ('visual' | 'sound')[]
  message: string
}

interface KindSpec {
  title: string
  /** what it does, for the list of faults available */
  description: string
  /** what on this boat it can happen to */
  targets(p: VesselProfile): string[]
  /** scenario minutes until it clears on its own, low and high; none: cleared by hand */
  lastsMin?: [number, number]
}

const combustion = (p: VesselProfile) =>
  p.engines.filter((e) => e.type !== 'electric').map((e) => e.id)

const STALE_PATHS = (p: VesselProfile) => [
  'environment.outside.temperature',
  'environment.outside.pressure',
  'environment.water.temperature',
  ...p.banks.map((b) => `electrical.batteries.${b.id}.voltage`),
  ...combustion(p).map((id) => `propulsion.${id}.coolantTemperature`)
]

export const FAULT_SPECS: Record<FaultKind, KindSpec> = {
  engineOverheat: {
    title: 'Engine overheating',
    description:
      'Raw-water intake blocked: coolant climbs past its alarm while the engine runs, oil pressure falls if it is run on; clears when the crew clears the intake',
    targets: combustion,
    lastsMin: [20, 40]
  },
  generatorNoStart: {
    title: 'Generator fails to start',
    description:
      'The generator cranks and will not start when it is next wanted, so nothing it would carry or charge is carried or charged',
    targets: (p) => p.generators.map((g) => g.id),
    lastsMin: [30, 60]
  },
  batteryCellFailure: {
    title: 'Battery cell failing',
    description:
      'A cell failing over an hour: the bank loses charge faster than its load accounts for, and its voltage sags under load',
    targets: (p) => p.banks.map((b) => b.id)
  },
  chargerFailure: {
    title: 'Charger drops out',
    description:
      "A bank's charger trips: it stops charging, on shore power or a generator, until it is reset",
    targets: (p) => p.banks.filter((b) => b.role !== 'start').map((b) => b.id),
    lastsMin: [20, 45]
  },
  alternatorFailure: {
    title: 'Alternator drops out',
    description:
      "An engine's alternator stops charging (a broken belt): the engine runs on and its bank is not charged",
    targets: combustion
  },
  bilgeFlooding: {
    title: 'Bilge flooding',
    description:
      'Water coming in faster than the bilge pump clears it: the pump runs, the water rises past the high water switch; clears when the leak is found and stopped and the pump has cleared the bilge',
    targets: () => ['bilge'],
    lastsMin: [15, 30]
  },
  fuelGaugeStuck: {
    title: 'Fuel gauge stuck',
    description:
      'A fuel tank sender sticks: the tank keeps reading what it read while the fuel goes on being used',
    targets: (p) => (p.tanks.fuel ?? []).map((t) => t.id)
  },
  depthSounderSilent: {
    title: 'Depth sounder silent',
    description:
      'A depth sounder stops sending (aeration, a loose transducer lead) and comes back',
    targets: (p) => p.sounders.map((s) => s.id),
    lastsMin: [5, 15]
  },
  gnssLost: {
    title: 'GNSS fix lost',
    description:
      'The receiver loses its fix: position, speed and course over ground stop, quality goes to no GPS; on regaining it tracks satellites, fixes and settles',
    targets: () => ['gnss'],
    lastsMin: [2, 8]
  },
  windInstrumentFrozen: {
    title: 'Wind instrument frozen',
    description:
      'The masthead unit stops turning: wind speed and angle keep the values they had',
    targets: (p) => (p.wind ? ['wind'] : [])
  },
  staleSensor: {
    title: 'Stale sensor value',
    description:
      'A gateway keeps sending a sensor value it has cached, at the time it was read',
    targets: STALE_PATHS,
    lastsMin: [10, 20]
  }
}

/** one fault on the boat, as saved */
export interface Fault {
  kind: FaultKind
  target: string
  /** raised by hand (the REST surface or the page) or by the seed */
  by: 'hand' | 'seed'
  raisedMs: number
  /** when it clears on its own, if it does */
  clearsMs?: number
  /** when it was cleared; its effects then wind down, and it is gone once they have */
  clearedMs?: number
  clearedBy?: 'hand' | 'course'
  /** the values a stuck or frozen sensor keeps sending, by path */
  held?: Record<string, unknown>
  /** the time a stale value was read */
  heldAt?: string
  /** a start was asked of a generator and it would not start */
  crankedMs?: number
}

export interface FaultsState {
  version: number
  seed: number
  perDay: number
  nowMs: number
  /** scenario time the seed throws its next fault, when it throws them */
  nextMs: number | null
  rng: number
  faults: Fault[]
  bilge: { litres: number; pumpOn: boolean; pumpRunS: number }
  /** the notifications last sent, by path, so a restart clears what has cleared */
  notified: Record<string, NotificationValue>
}

export const FAULTS_STATE_VERSION = 1

export interface FaultsOptions {
  seed: number
  /** faults the seed throws on its own, on average, per day of scenario time */
  perDay: number
  startMs: number
  state?: FaultsState
}

/** a request the faults cannot meet: an unknown kind or target, or one already active */
export class FaultError extends Error {}

/** a fault as the REST surface and the page show it */
export interface FaultView extends Fault {
  id: string
  title: string
  /** developing, or winding down after it was cleared */
  phase: 'developing' | 'clearing'
  /** where it has got to, in a few words */
  course: string
}

const faultId = (f: { kind: string; target: string }) => `${f.kind}:${f.target}`

const methodFor = (
  state: NotificationValue['state']
): NotificationValue['method'] =>
  state === 'alarm' ? ['visual', 'sound'] : state === 'warn' ? ['visual'] : []

export class Faults implements SystemFaults {
  private nowMs: number
  private faults: Fault[] = []
  private nextMs: number | undefined
  private readonly rng: Rng
  private readonly sumpL: number
  private readonly pumpLph: number
  private bilge = { litres: 0, pumpOn: false, pumpRunS: 0 }
  private notified = new Map<string, NotificationValue>()
  /** the latest value sent on each path, as an alarm panel reads it */
  private readonly lastSent = new Map<string, unknown>()
  /** the systems model's satellites and dilution, before a lost fix changes them */
  private readonly receiver = { satellites: 0, hdop: 0 }

  constructor(
    readonly profile: VesselProfile,
    private readonly options: FaultsOptions
  ) {
    this.nowMs = options.startMs
    this.rng = new Rng(options.seed, 'faults')
    this.sumpL = SUMP_L_PER_M15 * profile.lengthM ** 1.5
    this.pumpLph = PUMP_L_PER_H + PUMP_L_PER_H_PER_M * profile.lengthM
    const state = options.state
    if (
      state?.version === FAULTS_STATE_VERSION &&
      state.seed === options.seed &&
      Array.isArray(state.faults)
    ) {
      this.nowMs = state.nowMs
      this.faults = state.faults.filter(
        (f) =>
          FAULT_KINDS.includes(f.kind) &&
          this.targetsOf(f.kind).includes(f.target)
      )
      this.rng.restore(state.rng)
      // the rate is the setting's, so a changed rate takes effect from here
      this.nextMs =
        state.perDay === options.perDay
          ? (state.nextMs ?? undefined)
          : undefined
      this.bilge = { ...state.bilge }
      this.notified = new Map(Object.entries(state.notified ?? {}))
    }
  }

  save(): FaultsState {
    return {
      version: FAULTS_STATE_VERSION,
      seed: this.options.seed,
      perDay: this.options.perDay,
      nowMs: this.nowMs,
      nextMs: this.nextMs ?? null,
      rng: this.rng.save(),
      faults: this.faults.map((f) => ({ ...f })),
      bilge: { ...this.bilge },
      notified: Object.fromEntries(this.notified)
    }
  }

  private targetsOf(kind: FaultKind): string[] {
    return FAULT_SPECS[kind].targets(this.profile)
  }

  /** every fault this boat can have, with what it can happen to */
  available(): {
    kind: FaultKind
    title: string
    description: string
    targets: string[]
    lastsMin?: [number, number]
  }[] {
    return FAULT_KINDS.map((kind) => ({
      kind,
      title: FAULT_SPECS[kind].title,
      description: FAULT_SPECS[kind].description,
      targets: this.targetsOf(kind),
      lastsMin: FAULT_SPECS[kind].lastsMin
    })).filter((k) => k.targets.length)
  }

  /** the faults on the boat now, developing or winding down */
  active(): FaultView[] {
    return this.faults.map((f) => ({
      ...f,
      id: faultId(f),
      title: FAULT_SPECS[f.kind].title,
      phase: f.clearedMs === undefined ? 'developing' : 'clearing',
      course: this.course(f)
    }))
  }

  private find(kind: string, target: string): Fault | undefined {
    return this.faults.find((f) => f.kind === kind && f.target === target)
  }

  /**
   * Raises a fault now, on the first thing it can happen to when no target is given.
   * Throws FaultError for a kind or target this boat does not have, or one already on.
   */
  raise(kind: string, target?: string, by: Fault['by'] = 'hand'): FaultView {
    if (!FAULT_KINDS.includes(kind as FaultKind)) {
      throw new FaultError(`no fault called ${kind}`)
    }
    const k = kind as FaultKind
    const targets = this.targetsOf(k)
    const on = target ?? targets[0]
    if (on === undefined || !targets.includes(on)) {
      throw new FaultError(
        targets.length
          ? `${kind} can happen to ${targets.join(', ')}, not ${target}`
          : `this boat has nothing ${kind} can happen to`
      )
    }
    const existing = this.find(k, on)
    if (existing && existing.clearedMs === undefined) {
      throw new FaultError(`${faultId(existing)} is already on`)
    }
    if (existing) this.faults.splice(this.faults.indexOf(existing), 1)
    const lasts = FAULT_SPECS[k].lastsMin
    const fault: Fault = {
      kind: k,
      target: on,
      by,
      raisedMs: this.nowMs,
      clearsMs: lasts
        ? this.nowMs +
          Math.round(this.rng.between(lasts[0], lasts[1])) * MINUTE_MS
        : undefined
    }
    this.faults.push(fault)
    return this.active().find((v) => v.id === faultId(fault))!
  }

  /** clears a fault by hand; its effects wind down as they would. Throws FaultError if it is not on. */
  clear(kind: string, target: string): FaultView {
    const f = this.find(kind, target)
    if (!f || f.clearedMs !== undefined) {
      throw new FaultError(`${kind}:${target} is not on`)
    }
    f.clearedMs = this.nowMs
    f.clearedBy = 'hand'
    const view = this.active().find((v) => v.id === faultId(f))!
    this.retire()
    return view
  }

  // ---- inside the systems model, at each of its steps -------------------------------

  step(nowMs: number, dt: number): void {
    this.nowMs = nowMs
    for (const f of this.faults) {
      if (
        f.clearedMs === undefined &&
        f.clearsMs !== undefined &&
        nowMs >= f.clearsMs
      ) {
        f.clearedMs = f.clearsMs
        f.clearedBy = 'course'
      }
    }
    this.stepBilge(dt)
    this.throwFromSeed()
    this.retire()
  }

  private on(kind: FaultKind, target: string): Fault | undefined {
    const f = this.find(kind, target)
    return f && f.clearedMs === undefined ? f : undefined
  }

  intakeBlocked(engineId: string): boolean {
    return this.on('engineOverheat', engineId) !== undefined
  }

  refusesStart(generatorId: string): boolean {
    const f = this.on('generatorNoStart', generatorId)
    if (f) f.crankedMs = this.nowMs
    return f !== undefined
  }

  cellFailure(bankId: string): number {
    const f = this.on('batteryCellFailure', bankId)
    if (!f) return 0
    return Math.min(
      1,
      (this.nowMs - f.raisedMs) / (CELL_FAILURE_MIN * MINUTE_MS)
    )
  }

  alternatorFailed(engineId: string): boolean {
    return this.on('alternatorFailure', engineId) !== undefined
  }

  chargerFailed(bankId: string): boolean {
    return this.on('chargerFailure', bankId) !== undefined
  }

  bilgePumpW(): number {
    return this.bilge.pumpOn ? PUMP_W_PER_L_PER_H * this.pumpLph : 0
  }

  private stepBilge(dt: number): void {
    const f = this.find('bilgeFlooding', 'bilge')
    if (!f && this.bilge.litres === 0 && !this.bilge.pumpOn) return
    const leakLph =
      f && f.clearedMs === undefined
        ? LEAK_SHARE_OF_PUMP *
          this.pumpLph *
          Math.min(1, (this.nowMs - f.raisedMs) / (LEAK_RISE_MIN * MINUTE_MS))
        : 0
    const b = this.bilge
    const share = b.litres / this.sumpL
    if (share >= PUMP_ON_SHARE) b.pumpOn = true
    else if (share <= PUMP_OFF_SHARE) b.pumpOn = false
    const pumpedLph = b.pumpOn ? this.pumpLph : 0
    b.litres = Math.max(
      0,
      b.litres + ((leakLph - pumpedLph) * dt) / SECONDS_PER_HOUR
    )
    b.pumpRunS = b.pumpOn ? b.pumpRunS + dt : 0
    // what is left under the float switch's off point stays in the sump
    if (!b.pumpOn && !f) b.litres = 0
  }

  /** the seed's own faults, at the set rate: a fault at random times, on a random target */
  private throwFromSeed(): void {
    const perDay = this.options.perDay
    if (!(perDay > 0)) return
    const gap = () =>
      (-Math.log(1 - this.rng.next()) / perDay) * 24 * 60 * MINUTE_MS
    if (this.nextMs === undefined) this.nextMs = this.nowMs + gap()
    if (this.nowMs < this.nextMs) return
    this.nextMs = this.nowMs + gap()
    const free = this.available().flatMap((k) =>
      k.targets
        .filter((t) => !this.find(k.kind, t))
        .map((t) => ({ kind: k.kind, target: t }))
    )
    if (!free.length) return
    const pick = free[Math.floor(this.rng.next() * free.length)]
    this.raise(pick.kind, pick.target, 'seed')
  }

  /** a cleared fault goes once its effects have wound down */
  private retire(): void {
    this.faults = this.faults.filter(
      (f) => f.clearedMs === undefined || !this.woundDown(f)
    )
  }

  private woundDown(f: Fault): boolean {
    switch (f.kind) {
      case 'engineOverheat': {
        const c = this.lastSent.get(`propulsion.${f.target}.coolantTemperature`)
        return typeof c !== 'number' || c - KELVIN < COOLANT_NORMAL_C
      }
      case 'bilgeFlooding':
        return !this.bilge.pumpOn
      case 'gnssLost':
        return this.nowMs - f.clearedMs! >= FIX_SETTLE_S * 1000
      default:
        return true
    }
  }

  // ---- on the deltas as they go out ---------------------------------------------------

  /**
   * The boat's deltas as its faulty sensors send them. Records every value that goes out,
   * which is what the alarms read.
   */
  filter(delta: Delta): Delta {
    if (!this.faults.length) {
      this.record(delta)
      return delta
    }
    const updates: Delta['updates'] = []
    for (const update of delta.updates) {
      if (
        update.source.src !== undefined &&
        this.on('depthSounderSilent', update.source.src)
      )
        continue
      const values: { path: string; value: unknown }[] = []
      for (const v of update.values) {
        const sent = this.sensor(v.path, v.value, updates, update)
        if (sent !== undefined) values.push({ path: v.path, value: sent })
      }
      if (values.length || update.meta?.length)
        updates.push({ ...update, values })
    }
    const out = { ...delta, updates }
    this.record(out)
    return out
  }

  private record(delta: Delta): void {
    for (const update of delta.updates) {
      for (const v of update.values) this.lastSent.set(v.path, v.value)
    }
    const s = this.lastSent.get('navigation.gnss.satellites')
    if (typeof s === 'number' && !this.gnssDown()) {
      this.receiver.satellites = s
      const h = this.lastSent.get('navigation.gnss.horizontalDilution')
      if (typeof h === 'number') this.receiver.hdop = h
    }
  }

  /** where a lost fix has got to: lost or tracking, fixed and settling, or settled */
  private gnssPhase(): 'lost' | 'acquiring' | 'settling' | undefined {
    const f = this.find('gnssLost', 'gnss')
    if (!f) return undefined
    if (f.clearedMs === undefined) return 'lost'
    const since = (this.nowMs - f.clearedMs) / 1000
    return since < FIX_ACQUIRE_S
      ? 'acquiring'
      : since < FIX_SETTLE_S
        ? 'settling'
        : undefined
  }

  private gnssDown(): boolean {
    const phase = this.gnssPhase()
    return phase === 'lost' || phase === 'acquiring'
  }

  /** the value a faulty sensor sends for a path, or undefined to send nothing */
  private sensor(
    path: string,
    value: unknown,
    updates: Delta['updates'],
    update: Delta['updates'][number]
  ): unknown {
    const fuel = /^tanks\.fuel\.([^.]+)\.(currentLevel|currentVolume)$/.exec(
      path
    )
    if (fuel) {
      const f = this.on('fuelGaugeStuck', fuel[1])
      if (f) return this.hold(f, path, value)
    }
    if (path.startsWith('environment.wind.')) {
      const f = this.on('windInstrumentFrozen', 'wind')
      if (f) return this.hold(f, path, value)
    }
    const stale = this.on('staleSensor', path)
    if (stale) {
      if (stale.heldAt === undefined) stale.heldAt = update.timestamp
      const held = this.hold(stale, path, value)
      updates.push({
        source: update.source,
        timestamp: stale.heldAt,
        values: [{ path, value: held }]
      })
      return undefined
    }
    const phase = this.gnssPhase()
    if (phase) return this.gnss(path, value, phase)
    return value
  }

  private hold(f: Fault, path: string, value: unknown): unknown {
    f.held ??= {}
    if (!(path in f.held)) f.held[path] = value
    return f.held[path]
  }

  private gnss(
    path: string,
    value: unknown,
    phase: 'lost' | 'acquiring' | 'settling'
  ): unknown {
    const fromFix = [
      'navigation.position',
      'navigation.speedOverGround',
      'navigation.courseOverGroundTrue',
      'navigation.courseOverGroundMagnetic',
      'navigation.datetime',
      'navigation.gnss.horizontalDilution',
      'navigation.gnss.positionDilution'
    ]
    const f = this.find('gnssLost', 'gnss')!
    const since =
      f.clearedMs === undefined ? 0 : (this.nowMs - f.clearedMs) / 1000
    const settled = this.receiver.satellites || SATELLITES_FOR_FIX
    if (phase !== 'settling') {
      if (fromFix.includes(path)) return undefined
      if (path === 'navigation.gnss.methodQuality') return 'no GPS'
      if (path === 'navigation.gnss.satellites') {
        return phase === 'lost'
          ? SATELLITES_WITHOUT_FIX
          : Math.round(
              SATELLITES_WITHOUT_FIX +
                ((SATELLITES_FOR_FIX - SATELLITES_WITHOUT_FIX) * since) /
                  FIX_ACQUIRE_S
            )
      }
      return value
    }
    // fixed on the first few satellites, more coming in until it has them all
    const share = (since - FIX_ACQUIRE_S) / (FIX_SETTLE_S - FIX_ACQUIRE_S)
    const satellites = Math.round(
      SATELLITES_FOR_FIX + (settled - SATELLITES_FOR_FIX) * share
    )
    if (path === 'navigation.gnss.satellites') return satellites
    if (
      typeof value === 'number' &&
      (path === 'navigation.gnss.horizontalDilution' ||
        path === 'navigation.gnss.positionDilution')
    ) {
      return Math.round(((value * settled) / satellites) * 100) / 100
    }
    return value
  }

  /** the bilge switches, while the bilge has a fault or water to clear, and once more as they open */
  deltas(
    sentAtMs: number,
    source: Delta['updates'][number]['source']
  ): Delta[] {
    const closed =
      this.lastSent.get('electrical.switches.bilgePump.state') === 1 ||
      this.lastSent.get('electrical.switches.bilgeHighWater.state') === 1
    if (!this.find('bilgeFlooding', 'bilge') && !this.bilge.pumpOn && !closed)
      return []
    const highWater = this.bilge.litres >= HIGH_WATER_SHARE * this.sumpL
    const delta: Delta = {
      context: 'vessels.self',
      updates: [
        {
          source,
          timestamp: new Date(sentAtMs).toISOString(),
          values: [
            {
              path: 'electrical.switches.bilgePump.state',
              value: this.bilge.pumpOn ? 1 : 0
            },
            {
              path: 'electrical.switches.bilgeHighWater.state',
              value: highWater ? 1 : 0
            }
          ]
        }
      ]
    }
    this.record(delta)
    return [delta]
  }

  // ---- alarms ------------------------------------------------------------------------

  /** each alarm the boat's own panel would raise now, by its notification path */
  private alarms(): Map<string, Omit<NotificationValue, 'method'>> {
    const out = new Map<string, Omit<NotificationValue, 'method'>>()
    const num = (path: string) => {
      const v = this.lastSent.get(path)
      return typeof v === 'number' ? v : undefined
    }
    const raise = (path: string, state: 'warn' | 'alarm', message: string) =>
      out.set(`notifications.${path}`, { state, message })
    const name = (id: string) =>
      [...this.profile.engines, ...this.profile.generators].find(
        (u) => u.id === id
      )?.displayName ?? id
    for (const f of this.faults) {
      const t = f.target
      switch (f.kind) {
        case 'engineOverheat': {
          const c = num(`propulsion.${t}.coolantTemperature`)
          if (c !== undefined && c - KELVIN >= COOLANT_WARN_C) {
            const hot = c - KELVIN >= COOLANT_ALARM_C
            raise(
              `propulsion.${t}.coolantTemperature`,
              hot ? 'alarm' : 'warn',
              `${name(t)} coolant ${Math.round(c - KELVIN)} °C${hot ? ': overheating' : ', high'}`
            )
          }
          const p = num(`propulsion.${t}.oilPressure`)
          if (
            this.lastSent.get(`propulsion.${t}.state`) === 'started' &&
            p !== undefined &&
            p < OIL_PRESSURE_ALARM_BAR * PASCALS_PER_BAR
          ) {
            raise(
              `propulsion.${t}.oilPressure`,
              'alarm',
              `${name(t)} oil pressure low: ${(p / PASCALS_PER_BAR).toFixed(1)} bar`
            )
          }
          break
        }
        case 'generatorNoStart':
          if (f.crankedMs !== undefined && f.clearedMs === undefined) {
            raise(
              `propulsion.${t}.state`,
              'alarm',
              `${name(t)} failed to start`
            )
          }
          break
        case 'batteryCellFailure': {
          const bank = this.profile.banks.find((b) => b.id === t)!
          const v = num(`electrical.batteries.${t}.voltage`)
          const scale = bank.nominalVoltage / 12
          if (v !== undefined && v < BATTERY_WARN_V * scale) {
            raise(
              `electrical.batteries.${t}.voltage`,
              v < BATTERY_ALARM_V * scale ? 'alarm' : 'warn',
              `${bank.displayName} voltage low: ${v.toFixed(1)} V`
            )
          }
          break
        }
        case 'chargerFailure':
          if (
            this.lastSent.get(`electrical.chargers.${t}.chargingMode`) ===
            'other'
          ) {
            raise(
              `electrical.chargers.${t}.chargingMode`,
              'warn',
              `${this.profile.banks.find((b) => b.id === t)!.displayName} charger not charging`
            )
          }
          break
        case 'alternatorFailure':
          if (
            f.clearedMs === undefined &&
            this.lastSent.get(`propulsion.${t}.state`) === 'started'
          ) {
            raise(
              `propulsion.${t}.alternatorVoltage`,
              'warn',
              `${name(t)} alternator not charging`
            )
          }
          break
        case 'bilgeFlooding':
          if (this.bilge.litres >= HIGH_WATER_SHARE * this.sumpL) {
            raise(
              'electrical.switches.bilgeHighWater.state',
              'alarm',
              'Bilge high water'
            )
          }
          if (this.bilge.pumpRunS >= PUMP_RUNNING_WARN_S) {
            raise(
              'electrical.switches.bilgePump.state',
              'warn',
              `Bilge pump running for ${Math.floor(this.bilge.pumpRunS / 60)} min`
            )
          }
          break
        case 'depthSounderSilent':
          if (
            f.clearedMs === undefined &&
            this.profile.sounders.every((s) =>
              this.on('depthSounderSilent', s.id)
            )
          ) {
            raise(
              'environment.depth.belowTransducer',
              'warn',
              'No depth: sounder not sending'
            )
          }
          break
        case 'gnssLost':
          if (this.gnssDown()) {
            raise('navigation.position', 'alarm', 'GNSS fix lost')
          }
          break
      }
    }
    return out
  }

  /**
   * The notifications that have changed since the last call: each alarm raised or changed,
   * and each one that has cleared, sent once as `normal`. `all` sends every one raised,
   * as after a restart, when the server may not have them.
   */
  notifications(
    sentAtMs: number,
    source: Delta['updates'][number]['source'],
    all = false
  ): Delta | undefined {
    const now = this.alarms()
    const values: { path: string; value: NotificationValue }[] = []
    for (const [path, a] of now) {
      const before = this.notified.get(path)
      if (all || before?.state !== a.state || before.message !== a.message) {
        const value = {
          state: a.state,
          method: methodFor(a.state),
          message: a.message
        }
        values.push({ path, value })
        this.notified.set(path, value)
      }
    }
    for (const [path, before] of this.notified) {
      if (now.has(path)) continue
      values.push({
        path,
        value: { state: 'normal', method: [], message: before.message }
      })
      this.notified.delete(path)
    }
    if (!values.length) return undefined
    return {
      context: 'vessels.self',
      updates: [{ source, timestamp: new Date(sentAtMs).toISOString(), values }]
    }
  }

  // ---- for the page -----------------------------------------------------------------

  private course(f: Fault): string {
    const t = f.target
    const num = (path: string) => {
      const v = this.lastSent.get(path)
      return typeof v === 'number' ? v : undefined
    }
    const parts: string[] = []
    switch (f.kind) {
      case 'engineOverheat': {
        const c = num(`propulsion.${t}.coolantTemperature`)
        if (c !== undefined) parts.push(`coolant ${Math.round(c - KELVIN)} °C`)
        const p = num(`propulsion.${t}.oilPressure`)
        if (p !== undefined)
          parts.push(`oil ${(p / PASCALS_PER_BAR).toFixed(1)} bar`)
        break
      }
      case 'generatorNoStart':
        parts.push(
          f.crankedMs !== undefined
            ? 'failed to start'
            : 'not yet asked to start'
        )
        break
      case 'batteryCellFailure':
        parts.push(`${Math.round(this.cellFailure(t) * 100)} % failed`)
        break
      case 'bilgeFlooding':
        parts.push(
          `${Math.round(this.bilge.litres)} l in a ${Math.round(this.sumpL)} l sump`,
          this.bilge.pumpOn ? 'pump running' : 'pump off'
        )
        break
      case 'gnssLost':
        parts.push(this.gnssPhase() ?? 'settled')
        break
    }
    return parts.join(', ')
  }
}
