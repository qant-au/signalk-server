/**
 * Which AIS reports a simulated boat would actually hear.
 *
 * Source data (AMSA, NOAA, Piraeus) holds every report a shore network collected, from
 * receivers far better placed than a boat's masthead. A boat hears a target only while it
 * is within radio range, and range depends on both antenna heights and the transmitter's
 * power. This module estimates each target's station, the range between it and the
 * receiver, the chance a given report gets through, how often the target transmits, and
 * how long a receiver waits before treating it as lost. The model is described, with its
 * references, in README.md beside this file.
 */

export type AisClass = 'A' | 'B'

export interface AisStation {
  aisClass: AisClass
  txPowerW: number
  antennaHeightM: number
}

export interface Receiver {
  antennaHeightM: number
  /** receiver sensitivity, dBm (IEC 61993-2 / 62287 require -107 dBm or better) */
  sensitivityDbm?: number
  /** antenna, cable and connector losses for the whole link, dB */
  systemLossDb?: number
}

export interface TargetDescription {
  /** 'A' or 'B' when the source says (NOAA's `transceiver` column) */
  transceiver?: string
  /** AIS ship and cargo type code, 0 to 99 (ITU-R M.1371) */
  typeCode?: number
  /** ship type as text (AMSA's `type` column) */
  typeText?: string
  lengthM?: number
}

// ITU-R M.1371: Class A transmits at 12.5 W; Class B "CS" units, which nearly all
// recreational fits are, at 2 W.
export const CLASS_A_POWER_W = 12.5
export const CLASS_B_POWER_W = 2
export const DEFAULT_SENSITIVITY_DBM = -107
export const DEFAULT_SYSTEM_LOSS_DB = 6

// Radio horizon over a smooth sea with the standard 4/3 Earth-radius refraction:
// d (nm) = 2.23 * (sqrt(h1) + sqrt(h2)), heights in metres.
const RADIO_HORIZON_NM_PER_SQRT_M = 2.23
const METRES_PER_NM = 1852
const EARTH_RADIUS_NM = 3440.065

// Reception falls off around the range rather than stopping dead at it. The logistic
// width is a fraction of the range: half the reports arrive at the range itself, about
// 90% at 80% of it and about 7% at 120%.
const RANGE_FADE_FRACTION = 0.08
// Reports lost to slot collisions and interference even well inside range.
export const DEFAULT_BASE_LOSS = 0.02

// Reporting intervals, ITU-R M.1371-5 Table 1 (Class A) and Class B "CS".
const CLASS_A_MOORED_S = 180
const CLASS_A_SLOW_S = 10
const CLASS_A_MEDIUM_S = 6
const CLASS_A_FAST_S = 2
const CLASS_A_MOORED_MAX_KN = 3
const CLASS_A_SLOW_MAX_KN = 14
const CLASS_A_MEDIUM_MAX_KN = 23
const CLASS_B_SLOW_S = 180
const CLASS_B_UNDERWAY_S = 30
const CLASS_B_SLOW_MAX_KN = 2
// Navigational status codes for "at anchor" and "moored".
const STATUS_AT_ANCHOR = 1
const STATUS_MOORED = 5
// With no status in the source, a Class A target this slow is treated as moored.
const STATIONARY_KN = 0.5

// A receiver treats a target as lost after missing several expected reports, and never
// sooner than this floor, so one missed report from a fast ship does not drop it. Both
// keep a lost target well inside the server's own hourly clean-up (pruneContextsMinutes,
// default 60), which no real boat has.
export const LOST_AFTER_REPORTS = 3
export const LOST_FLOOR_S = 180

type Category = 'large' | 'workboat' | 'sailing' | 'pleasure' | 'unknown'

const LARGE_SHIP_MIN_M = 50
const CLASS_A_MIN_LENGTH_M = 20

function categorise(t: TargetDescription): Category {
  const code = t.typeCode
  const text = (t.typeText ?? '').toLowerCase()
  if (code === 36 || text.includes('sail')) return 'sailing'
  if (code === 37 || text.includes('pleasure')) return 'pleasure'
  const largeType =
    (code !== undefined && code >= 60 && code <= 89) ||
    /cargo|tanker|passenger/.test(text)
  if (largeType) {
    return t.lengthM !== undefined &&
      t.lengthM > 0 &&
      t.lengthM < LARGE_SHIP_MIN_M
      ? 'workboat'
      : 'large'
  }
  const workType =
    (code !== undefined &&
      code >= 30 &&
      code <= 59 &&
      code !== 36 &&
      code !== 37) ||
    /tug|fish|pilot|sar|law|dredg|tow|military|port|high speed/.test(text)
  if (workType) return 'workboat'
  return 'unknown'
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

/**
 * Antenna height above the water, estimated from what the source data gives. Ships carry
 * their VHF and AIS antennas on the mast above the bridge, sailing yachts at the masthead,
 * and motor cruisers on a short whip above the flybridge or hardtop.
 */
function antennaHeight(
  category: Category,
  lengthM: number | undefined
): number {
  const length = lengthM && lengthM > 0 ? lengthM : undefined
  switch (category) {
    case 'large':
      return length ? clamp(0.1 * length + 10, 12, 45) : 25
    case 'workboat':
      return length ? clamp(0.25 * length + 4, 6, 20) : 10
    case 'sailing':
      return length ? clamp(1.2 * length, 6, 30) : 14
    case 'pleasure':
      return length ? clamp(0.2 * length + 2.5, 3, 10) : 4
    default:
      return length ? clamp(0.2 * length + 3, 3, 20) : 4
  }
}

export function estimateStation(t: TargetDescription): AisStation {
  const category = categorise(t)
  const stated = t.transceiver?.trim().toUpperCase()
  const aisClass: AisClass =
    stated === 'A' || stated === 'B'
      ? stated
      : category === 'large' ||
          (category === 'workboat' && (t.lengthM ?? 0) >= CLASS_A_MIN_LENGTH_M)
        ? 'A'
        : 'B'
  return {
    aisClass,
    txPowerW: aisClass === 'A' ? CLASS_A_POWER_W : CLASS_B_POWER_W,
    antennaHeightM: antennaHeight(category, t.lengthM)
  }
}

export function radioHorizonNm(heightAM: number, heightBM: number): number {
  return (
    RADIO_HORIZON_NM_PER_SQRT_M * (Math.sqrt(heightAM) + Math.sqrt(heightBM))
  )
}

/**
 * The distance at which the received signal falls to the receiver's sensitivity, using
 * the two-ray ground-reflection model that applies over open water at these distances:
 * received power = Pt * (ht * hr)^2 / d^4, with unity antenna gains and the system loss
 * taken off the transmitted power.
 */
export function powerLimitedRangeNm(
  txPowerW: number,
  txHeightM: number,
  rxHeightM: number,
  sensitivityDbm = DEFAULT_SENSITIVITY_DBM,
  systemLossDb = DEFAULT_SYSTEM_LOSS_DB
): number {
  const sensitivityW = 10 ** ((sensitivityDbm - 30) / 10)
  const effectiveTxW = txPowerW * 10 ** (-systemLossDb / 10)
  const metres =
    ((effectiveTxW * (txHeightM * rxHeightM) ** 2) / sensitivityW) ** 0.25
  return metres / METRES_PER_NM
}

/** The usual range between a station and a receiver: whichever limit comes first. */
export function receptionRangeNm(
  station: AisStation,
  receiver: Receiver
): number {
  return Math.min(
    radioHorizonNm(station.antennaHeightM, receiver.antennaHeightM),
    powerLimitedRangeNm(
      station.txPowerW,
      station.antennaHeightM,
      receiver.antennaHeightM,
      receiver.sensitivityDbm,
      receiver.systemLossDb
    )
  )
}

export function receptionProbability(
  distanceNm: number,
  rangeNm: number,
  baseLoss = DEFAULT_BASE_LOSS
): number {
  const width = RANGE_FADE_FRACTION * rangeNm
  return (1 - baseLoss) / (1 + Math.exp((distanceNm - rangeNm) / width))
}

export function reportingIntervalSeconds(
  aisClass: AisClass,
  sogKn: number,
  navStatus?: number
): number {
  if (aisClass === 'B') {
    return sogKn <= CLASS_B_SLOW_MAX_KN ? CLASS_B_SLOW_S : CLASS_B_UNDERWAY_S
  }
  const mooredStatus =
    navStatus === STATUS_AT_ANCHOR || navStatus === STATUS_MOORED
  if (
    (mooredStatus && sogKn <= CLASS_A_MOORED_MAX_KN) ||
    (navStatus === undefined && sogKn < STATIONARY_KN)
  ) {
    return CLASS_A_MOORED_S
  }
  if (sogKn <= CLASS_A_SLOW_MAX_KN) return CLASS_A_SLOW_S
  if (sogKn <= CLASS_A_MEDIUM_MAX_KN) return CLASS_A_MEDIUM_S
  return CLASS_A_FAST_S
}

export function lostAfterSeconds(reportingInterval: number): number {
  return Math.max(LOST_AFTER_REPORTS * reportingInterval, LOST_FLOOR_S)
}

export function distanceNm(
  lat1: number,
  lon1: number,
  lat2: number,
  lon2: number
): number {
  const rad = Math.PI / 180
  const dLat = (lat2 - lat1) * rad
  const dLon = (lon2 - lon1) * rad
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * rad) * Math.cos(lat2 * rad) * Math.sin(dLon / 2) ** 2
  return 2 * EARTH_RADIUS_NM * Math.asin(Math.sqrt(a))
}

/**
 * A repeatable draw in [0, 1) for one report, so a scenario run twice hears exactly the
 * same reports. FNV-1a over the key, finished with a murmur3-style mix.
 */
export function reportDraw(targetId: string, timeMs: number): number {
  let h = 0x811c9dc5
  const key = `${targetId}@${timeMs}`
  for (let i = 0; i < key.length; i++) {
    h ^= key.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  h ^= h >>> 16
  h = Math.imul(h, 0x85ebca6b)
  h ^= h >>> 13
  h = Math.imul(h, 0xc2b2ae35)
  h ^= h >>> 16
  return (h >>> 0) / 0x100000000
}

export function isReportReceived(
  targetId: string,
  timeMs: number,
  distance: number,
  rangeNm: number,
  baseLoss = DEFAULT_BASE_LOSS
): boolean {
  return (
    reportDraw(targetId, timeMs) <
    receptionProbability(distance, rangeNm, baseLoss)
  )
}
