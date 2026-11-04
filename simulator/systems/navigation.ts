import { turnRateDegS } from '../routes/route'
import { VesselProfile } from '../vessels/profile'
import { Drift, DriftState, Rng } from './random'

/**
 * What the boat's navigation suite sends around the position: its state, heading true and
 * magnetic, speed through the water, rate of turn, rudder, roll and pitch, the logs and
 * the GNSS fix. The route gives the track over the ground; the current sets the boat off
 * it, so the heading carries the angle the helm holds against the current, and the speed
 * through the water differs from the speed over the ground by it. Under sail she makes
 * leeway too, growing with her heel, and the helm holds her up to windward by as much. The
 * current is the sample's where it has one, and otherwise a small seeded one. Everything
 * moves in the systems model's fixed steps, from its own seeded streams.
 */
export interface NavigationMotion {
  lat: number
  lon: number
  sogKn: number
  cogDeg: number
  rateOfTurnDegS: number
  atBerth: boolean
  anchored: boolean
  /** stopped, and leaving within a few minutes on the course `cogDeg` */
  leavingSoon: boolean
  /** at anchor, the heading she lies to on her chain, or is pointed on to leave */
  headDeg?: number
}

export interface TrueWind {
  kn: number
  /** the direction it comes from */
  deg: number
  /** the significant wave height where the sample measures it, in place of a sea built from the wind */
  waveHeightM?: number
}

/** the current: its speed and the direction it runs towards */
export interface Current {
  kn: number
  toDeg: number
}

/** what the sails are doing: sailing (not motor-sailing), and the sails set as a share of her full plan */
export interface SailsSet {
  sailing: boolean
  areaShare: number
}

export type NavigationStateValue =
  'moored' | 'anchored' | 'sailing' | 'motoring'

export interface NavigationState {
  trackDeg: number | null
  headingDeg: number | null
  rateOfTurnDegS: number
  stwKn: number
  rudderDeg: number
  rollDeg: number
  pitchDeg: number
  offsetM: number
  leewayDeg: number
  /** the sample's current at the latest step, or null where it has none */
  sampledCurrent: Current | null
  logM: number
  tripM: number
  tripResetMs: number
  state: NavigationStateValue | null
  satellites: number
  hdop: number
  drifts: Record<string, DriftState>
}

const KNOT_MS = 1852 / 3600
const RADIANS = Math.PI / 180
const NM_M = 1852
/** below this over the ground a boat is lying to the current, not steering a course */
const STEERAGE_KN = 0.3
/** a stopped boat swings at about this many degrees a second for a 10 m boat, slower when bigger */
const PIVOT_DEG_S_AT_10M = 2
const PIVOT_MIN_DEG_S = 0.75
/** helm and autopilot can always follow the route's own turn, with this to spare */
const SLEW_MARGIN = 1.05
const CURRENT_MIN_KN = 0.1
const CURRENT_MAX_KN = 0.4
const CURRENT_LIMIT_KN = 1
/** significant wave height per (wind speed, m/s) squared: a fetch-limited coastal sea */
const SEA_HS_PER_MS2 = 0.015
const SEA_HS_MAX_M = 4
/** how much of the open sea reaches a boat alongside, and one at anchor */
const BERTH_SHELTER = 0.1
const ANCHOR_SHELTER = 0.4
/** heading wander, degrees, in a sea of 1 m on a 10 m boat */
const YAW_DEG_PER_M = 1.5
const YAW_CALM_DEG = 0.2
/** rudder for a steady turn: gain times length over turning radius, as the rudder area works */
const RUDDER_GAIN = 1.5
const RUDDER_MAX_DEG = 35
const RUDDER_MIN_KN = 0.5
/** roll amplitude, radians, per metre of sea per metre of beam */
const ROLL_GAIN = 0.25
const ROLL_MAX_DEG = 15
/** natural roll period, seconds per square root of beam in metres */
const ROLL_PERIOD_PER_ROOT_BEAM = 2
const PITCH_GAIN = 0.5
const PITCH_MAX_DEG = 8
const PITCH_PERIOD_PER_ROOT_LENGTH = 0.8
const PITCH_MIN_PERIOD_S = 2
/** an irregular sea: the motion wanders with a time constant of this share of the period */
const MOTION_TAU_SHARE = 0.25
/** bow-up trim at full speed under power */
const TRIM_AT_FULL_DEG = 1.5
/** heel under sail: the most, reached by the full sail plan in this much apparent wind abeam */
const HEEL_MAX_DEG = 20
const HEEL_FULL_MS = 8
/** close-hauled the sails heel her nearly as hard as abeam: side force over its sine */
const HEEL_CLOSE_GAIN = 1.6
/** leeway, degrees, as this times the heel over the speed through the water squared */
const LEEWAY_PER_HEEL_KN2 = 10
const LEEWAY_MAX_DEG = 10
/** the leeway's speed is never taken below this, where the formula would run away */
const LEEWAY_MIN_KN = 2
/** off-track error: a few metres from the helm, more in a current or a sea */
const TRACK_ERROR_M = 1.5
const TRACK_ERROR_M_PER_KN = 4
const TRACK_ERROR_M_PER_M_SEA = 2
const TRACK_TAU_S = 240
/** how quickly the boat moves off or back onto the track */
const TRACK_SETTLE_S = 60
const LOG_MIN_NM = 500
const LOG_MAX_NM = 20000
const SATELLITES_MIN = 5
const SATELLITES_MAX = 16
/** HDOP falls with satellites in use, roughly as this over their number */
const HDOP_PER_SATELLITE = 4.5
const HDOP_FLOOR = 0.5
const PDOP_PER_HDOP = 1.7
const FIX_TYPE = 'Combined GPS/GLONASS'
const FIX_QUALITY = 'GNSS Fix'

export class Navigation {
  /** the heading the helm holds, before the wander a sea puts on it */
  private trackDeg: number | undefined
  private headingDeg: number | undefined
  private rateOfTurnDegS = 0
  private stwKn = 0
  private rudderDeg = 0
  private rollDeg = 0
  private pitchDeg = 0
  /** how far the boat is off its track, to starboard positive */
  private offsetM = 0
  /** to starboard positive: the way she slides through the water off her heading */
  private leewayDeg = 0
  private sampled: Current | undefined
  private logM: number
  private tripM = 0
  private tripResetMs: number
  private state: NavigationStateValue | undefined
  private satellites = 0
  private hdop = 0
  private cogDeg = 0
  private readonly currentKn: number
  private readonly currentSetDeg: number
  private readonly satellitesBase: number
  private readonly drifts: Record<string, Drift>

  constructor(
    private readonly profile: VesselProfile,
    seed: number,
    startMs: number
  ) {
    const water = new Rng(seed, 'navigation:current')
    this.currentKn = water.between(CURRENT_MIN_KN, CURRENT_MAX_KN)
    this.currentSetDeg = water.between(0, 360)
    const helm = new Rng(seed, 'navigation:helm')
    const sea = new Rng(seed, 'navigation:sea')
    const gnss = new Rng(seed, 'navigation:gnss')
    this.logM =
      new Rng(seed, 'navigation:log').between(LOG_MIN_NM, LOG_MAX_NM) * NM_M
    this.satellitesBase = gnss.between(9, 12)
    this.tripResetMs = startMs
    // unit spread: each is scaled where it is used, by the sea or the boat
    this.drifts = {
      currentSpeed: new Drift(water, 0.08, 1800),
      currentSet: new Drift(water, 25, 3600),
      yaw: new Drift(helm, 1, 15),
      track: new Drift(helm, 1, TRACK_TAU_S),
      roll: new Drift(
        sea,
        1,
        MOTION_TAU_SHARE * ROLL_PERIOD_PER_ROOT_BEAM * Math.sqrt(profile.beamM)
      ),
      pitch: new Drift(
        sea,
        1,
        MOTION_TAU_SHARE *
          Math.max(
            PITCH_MIN_PERIOD_S,
            PITCH_PERIOD_PER_ROOT_LENGTH * Math.sqrt(profile.lengthM)
          )
      ),
      satellites: new Drift(gnss, 1.5, 900),
      hdop: new Drift(gnss, 1, 120)
    }
  }

  /**
   * Metres off the route's track, positive to starboard: the helm holding the line against
   * the current and the sea never holds it exactly, and the error settles away when the
   * boat stops.
   */
  get trackOffsetM(): number {
    return this.offsetM
  }

  /** the current at the latest step: the sample's, or the seeded one where it has none */
  get current(): Current {
    return (
      this.sampled ?? {
        kn: clamp(
          this.currentKn + this.drifts.currentSpeed.value,
          0,
          CURRENT_LIMIT_KN
        ),
        toDeg: norm360(this.currentSetDeg + this.drifts.currentSet.value)
      }
    )
  }

  /** degrees, positive when she slides to starboard */
  get leeway(): number {
    return this.leewayDeg
  }

  get speedThroughWaterKn(): number {
    return this.stwKn
  }

  get heading(): number {
    return this.headingDeg ?? this.cogDeg
  }

  get navigationState(): NavigationStateValue | undefined {
    return this.state
  }

  step(
    dt: number,
    nowMs: number,
    m: NavigationMotion,
    wind: TrueWind,
    sails: SailsSet,
    sampledCurrent?: Current
  ): void {
    const p = this.profile
    for (const d of Object.values(this.drifts)) d.step(dt)
    this.sampled = sampledCurrent
    this.cogDeg = m.cogDeg

    const state: NavigationStateValue = m.atBerth
      ? 'moored'
      : m.anchored
        ? 'anchored'
        : sails.sailing
          ? 'sailing'
          : 'motoring'
    if (this.state === 'moored' && state !== 'moored') {
      this.tripM = 0
      this.tripResetMs = nowMs
    }
    this.state = state

    // the water moving over the ground, and the boat's motion through it
    const current = this.current
    const currentKn = current.kn
    const setRad = current.toDeg * RADIANS
    const cogRad = m.cogDeg * RADIANS
    const waterE = m.sogKn * Math.sin(cogRad) - currentKn * Math.sin(setRad)
    const waterN = m.sogKn * Math.cos(cogRad) - currentKn * Math.cos(setRad)
    let targetDeg: number
    if (m.atBerth) {
      // alongside: held by the lines on the berth's heading, nothing through the water
      targetDeg = m.cogDeg
      this.stwKn = 0
    } else if (m.anchored && m.headDeg !== undefined) {
      // lying to her chain: through the water only what her swing gives
      targetDeg = m.headDeg
      this.stwKn = m.sogKn
    } else if (m.sogKn < STEERAGE_KN) {
      // at anchor or holding: lying head to the current, which runs past the hull, until
      // the crew points her on the course she is about to leave on
      targetDeg = m.leavingSoon ? m.cogDeg : current.toDeg + 180
      this.stwKn = currentKn
    } else {
      // her track through the water, which she makes good with her heading up to windward
      // of it by the leeway she makes
      this.stwKn = Math.hypot(waterE, waterN)
      targetDeg = Math.atan2(waterE, waterN) / RADIANS - this.leewayDeg
    }

    const hs = this.seaHeightM(wind, m)
    const track = this.trackDeg
    this.trackDeg =
      track === undefined
        ? norm360(targetDeg)
        : norm360(track + this.slew(track, targetDeg, dt, m))
    const previous = this.headingDeg
    const headingDeg = norm360(this.trackDeg + this.yawDeg(hs))
    this.rateOfTurnDegS =
      previous === undefined ? 0 : wrap180(headingDeg - previous) / dt
    this.headingDeg = headingDeg

    // a steady turn needs rudder in proportion to length over turning radius
    const stwMs = this.stwKn * KNOT_MS
    this.rudderDeg =
      !m.atBerth && this.stwKn >= RUDDER_MIN_KN
        ? clamp(
            (RUDDER_GAIN * p.lengthM * this.rateOfTurnDegS) / stwMs,
            -RUDDER_MAX_DEG,
            RUDDER_MAX_DEG
          )
        : 0

    const rollAmpDeg = Math.min(
      ROLL_MAX_DEG,
      (ROLL_GAIN * hs) / p.beamM / RADIANS
    )
    const pitchAmpDeg = Math.min(
      PITCH_MAX_DEG,
      (PITCH_GAIN * hs) / p.lengthM / RADIANS
    )
    const heelDeg = this.heelDeg(wind, m, sails.areaShare)
    this.leewayDeg =
      steeringUnder(m) && heelDeg !== 0
        ? clamp(
            (LEEWAY_PER_HEEL_KN2 * heelDeg) /
              Math.max(LEEWAY_MIN_KN, this.stwKn) ** 2,
            -LEEWAY_MAX_DEG,
            LEEWAY_MAX_DEG
          )
        : 0
    this.rollDeg = heelDeg + rollAmpDeg * this.drifts.roll.value
    const powered = state === 'motoring' && p.rig === 'motor'
    // a short boat in a measured sea would otherwise pitch past what any boat does
    this.pitchDeg = clamp(
      (powered ? TRIM_AT_FULL_DEG * Math.min(1, m.sogKn / p.maxSpeedKn) : 0) +
        pitchAmpDeg * this.drifts.pitch.value,
      -PITCH_MAX_DEG,
      PITCH_MAX_DEG
    )

    const steering = steeringUnder(m)
    const offTrackM = steering
      ? this.drifts.track.value *
        (TRACK_ERROR_M +
          TRACK_ERROR_M_PER_KN * currentKn +
          TRACK_ERROR_M_PER_M_SEA * hs)
      : 0
    this.offsetM +=
      (offTrackM - this.offsetM) * (1 - Math.exp(-dt / TRACK_SETTLE_S))

    this.logM += stwMs * dt
    this.tripM += stwMs * dt

    this.satellites = Math.round(
      clamp(
        this.satellitesBase + this.drifts.satellites.value,
        SATELLITES_MIN,
        SATELLITES_MAX
      )
    )
    this.hdop = Math.max(
      HDOP_FLOOR,
      HDOP_PER_SATELLITE / this.satellites + 0.3 + 0.1 * this.drifts.hdop.value
    )
  }

  /** heading wander about the track: more in a bigger sea, less on a bigger boat */
  private yawDeg(hs: number): number {
    const sizeFactor = Math.sqrt(10 / this.profile.lengthM)
    return (
      this.drifts.yaw.value * (YAW_CALM_DEG + YAW_DEG_PER_M * hs * sizeFactor)
    )
  }

  /** the change towards the target heading this step, no faster than the boat can swing */
  private slew(
    fromDeg: number,
    targetDeg: number,
    dt: number,
    m: NavigationMotion
  ): number {
    const pivot = Math.max(
      PIVOT_MIN_DEG_S,
      PIVOT_DEG_S_AT_10M * Math.min(1.5, 10 / this.profile.lengthM)
    )
    const rate = Math.max(
      pivot,
      turnRateDegS(this.profile.lengthM, Math.max(m.sogKn, this.stwKn)),
      SLEW_MARGIN * Math.abs(m.rateOfTurnDegS)
    )
    return clamp(wrap180(targetDeg - fromDeg), -rate * dt, rate * dt)
  }

  private seaHeightM(wind: TrueWind, m: NavigationMotion): number {
    const ms = wind.kn * KNOT_MS
    const open =
      wind.waveHeightM ?? Math.min(SEA_HS_MAX_M, SEA_HS_PER_MS2 * ms * ms)
    return open * (m.atBerth ? BERTH_SHELTER : m.anchored ? ANCHOR_SHELTER : 1)
  }

  /**
   * Heel to leeward with sails set, motor-sailing too: growing with the apparent wind's
   * pressure, which goes with its square, and the area of sail set, so a reef takes some
   * of it off; hardest abeam and close-hauled, least running.
   */
  private heelDeg(
    wind: TrueWind,
    m: NavigationMotion,
    areaShare: number
  ): number {
    if (areaShare <= 0) return 0
    const from = wind.deg * RADIANS
    const course = m.cogDeg * RADIANS
    const boatMs = m.sogKn * KNOT_MS
    const windMs = wind.kn * KNOT_MS
    const east = -windMs * Math.sin(from) - boatMs * Math.sin(course)
    const north = -windMs * Math.cos(from) - boatMs * Math.cos(course)
    const apparentMs = Math.hypot(east, north)
    const angle = wrapPi(Math.atan2(-east, -north) - this.heading * RADIANS)
    const across = Math.abs(Math.sin(angle))
    const side =
      Math.abs(angle) <= Math.PI / 2
        ? Math.min(1, HEEL_CLOSE_GAIN * across)
        : across * across
    const strength = Math.min(
      1,
      (apparentMs / HEEL_FULL_MS) ** 2 * areaShare * side
    )
    // wind over the port side heels her to starboard, which is positive roll
    return -Math.sign(angle) * HEEL_MAX_DEG * strength
  }

  /** the current, as `environment.current`, magnetic too where the sample has the variation */
  putCurrent(
    put: (path: string, value: unknown) => void,
    variationDeg: number | undefined
  ): void {
    const c = this.current
    put('environment.current', {
      drift: round3(c.kn * KNOT_MS),
      setTrue: roundAngle(c.toDeg * RADIANS),
      ...(variationDeg === undefined
        ? {}
        : {
            setMagnetic: roundAngle(norm360(c.toDeg - variationDeg) * RADIANS)
          })
    })
  }

  /**
   * The navigation values. `variationDeg` is the magnetic variation at the boat, positive
   * east, when the sample has it; without it nothing magnetic is sent.
   */
  put(
    put: (path: string, value: unknown) => void,
    variationDeg: number | undefined
  ): void {
    const heading = this.heading
    put('navigation.state', this.state ?? 'moored')
    put('navigation.headingTrue', roundAngle(heading * RADIANS))
    if (variationDeg !== undefined) {
      put('navigation.magneticVariation', round5(variationDeg * RADIANS))
      put(
        'navigation.headingMagnetic',
        roundAngle(norm360(heading - variationDeg) * RADIANS)
      )
      put(
        'navigation.courseOverGroundMagnetic',
        roundAngle(norm360(this.cogDeg - variationDeg) * RADIANS)
      )
    }
    put('navigation.speedThroughWater', round3(this.stwKn * KNOT_MS))
    const leeway = this.leewayDeg * RADIANS
    put(
      'navigation.speedThroughWaterLongitudinal',
      round3(this.stwKn * KNOT_MS * Math.cos(leeway))
    )
    put(
      'navigation.speedThroughWaterTransverse',
      round3(this.stwKn * KNOT_MS * Math.sin(leeway))
    )
    put('navigation.leewayAngle', round4(leeway))
    put('navigation.rateOfTurn', round5(this.rateOfTurnDegS * RADIANS))
    // rounding alone can carry hard over a hair past the stops
    const stops = RUDDER_MAX_DEG * RADIANS
    put(
      'steering.rudderAngle',
      clamp(round4(this.rudderDeg * RADIANS), -stops, stops)
    )
    put('navigation.attitude', {
      roll: round4(this.rollDeg * RADIANS),
      pitch: round4(this.pitchDeg * RADIANS)
    })
    put('navigation.log', Math.round(this.logM))
    put('navigation.trip.log', Math.round(this.tripM))
    put('navigation.trip.lastReset', new Date(this.tripResetMs).toISOString())
    put('navigation.gnss.type', FIX_TYPE)
    put('navigation.gnss.methodQuality', FIX_QUALITY)
    put('navigation.gnss.satellites', this.satellites)
    put('navigation.gnss.horizontalDilution', round2(this.hdop))
    put('navigation.gnss.positionDilution', round2(PDOP_PER_HDOP * this.hdop))
  }

  save(): NavigationState {
    return {
      trackDeg: this.trackDeg ?? null,
      headingDeg: this.headingDeg ?? null,
      rateOfTurnDegS: this.rateOfTurnDegS,
      stwKn: this.stwKn,
      rudderDeg: this.rudderDeg,
      rollDeg: this.rollDeg,
      pitchDeg: this.pitchDeg,
      offsetM: this.offsetM,
      leewayDeg: this.leewayDeg,
      sampledCurrent: this.sampled ? { ...this.sampled } : null,
      logM: this.logM,
      tripM: this.tripM,
      tripResetMs: this.tripResetMs,
      state: this.state ?? null,
      satellites: this.satellites,
      hdop: this.hdop,
      drifts: Object.fromEntries(
        Object.entries(this.drifts).map(([k, d]) => [k, d.save()])
      )
    }
  }

  /** puts saved values back; `check` refuses one that does not fit */
  restore(
    s: NavigationState,
    check: (ok: boolean, what: string) => void,
    checkDrift: (d: DriftState | undefined, what: string) => DriftState
  ): void {
    const numbers = [
      'rateOfTurnDegS',
      'stwKn',
      'rudderDeg',
      'rollDeg',
      'pitchDeg',
      'offsetM',
      'leewayDeg',
      'logM',
      'tripM',
      'tripResetMs',
      'satellites',
      'hdop'
    ] as const
    check(typeof s === 'object' && s !== null, 'navigation')
    for (const k of numbers) check(Number.isFinite(s[k]), `navigation ${k}`)
    for (const k of ['trackDeg', 'headingDeg'] as const) {
      check(s[k] === null || Number.isFinite(s[k]), `navigation ${k}`)
    }
    check(
      s.state === null ||
        ['moored', 'anchored', 'sailing', 'motoring'].includes(s.state),
      'navigation state'
    )
    const sc = s.sampledCurrent
    check(
      sc === null ||
        (typeof sc === 'object' &&
          Number.isFinite(sc?.kn) &&
          Number.isFinite(sc?.toDeg)),
      'navigation sampled current'
    )
    const drifts = Object.entries(this.drifts).map(
      ([k, d]) => [d, checkDrift(s.drifts?.[k], `navigation ${k}`)] as const
    )
    for (const [d, saved] of drifts) d.restore(saved)
    this.trackDeg = s.trackDeg ?? undefined
    this.headingDeg = s.headingDeg ?? undefined
    this.rateOfTurnDegS = s.rateOfTurnDegS
    this.stwKn = s.stwKn
    this.rudderDeg = s.rudderDeg
    this.rollDeg = s.rollDeg
    this.pitchDeg = s.pitchDeg
    this.offsetM = s.offsetM
    this.leewayDeg = s.leewayDeg
    this.sampled = sc ? { ...sc } : undefined
    this.logM = s.logM
    this.tripM = s.tripM
    this.tripResetMs = s.tripResetMs
    this.state = s.state ?? undefined
    this.satellites = s.satellites
    this.hdop = s.hdop
  }
}

/** making way under her own steering: neither alongside, nor at anchor, nor stopped */
function steeringUnder(m: NavigationMotion): boolean {
  return !m.atBerth && !m.anchored && m.sogKn >= STEERAGE_KN
}

function clamp(x: number, low: number, high: number): number {
  return Math.min(high, Math.max(low, x))
}

function wrap180(deg: number): number {
  return ((((deg + 180) % 360) + 360) % 360) - 180
}

function norm360(deg: number): number {
  return ((deg % 360) + 360) % 360
}

function wrapPi(angle: number): number {
  return Math.atan2(Math.sin(angle), Math.cos(angle))
}

const round2 = (x: number) => Math.round(x * 100) / 100
const round3 = (x: number) => Math.round(x * 1000) / 1000
const round4 = (x: number) => Math.round(x * 10000) / 10000
const round5 = (x: number) => Math.round(x * 100000) / 100000
/** rounded and kept inside 0 to 2 pi, which rounding alone can step outside */
const roundAngle = (x: number) => {
  const r = round4(x)
  return r >= 2 * Math.PI ? 0 : r
}
