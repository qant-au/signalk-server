import { Drift, DriftState, Rng } from './random'

/**
 * The boat at anchor. The anchor goes down where the route stops her at a waypoint marked
 * `anchor`, and she falls back on her chain as it pays out, to a scope of five times the
 * depth plus the height of the bow roller. She lies downwind of it, sheering from side to
 * side across the wind as a yacht does on her chain, nearer the anchor in a light air
 * with the chain's weight on the bottom, out to its full reach in a breeze; her bow points
 * at the anchor. Before she leaves, the crew heaves the chain in at the windlass's pace,
 * bringing her up to the anchor, which breaks out as she gets under way.
 *
 * What a display reads is what the anchor alarm plugin sends: `navigation.anchor.position`
 * where the anchor went down (its altitude the depth there, below the surface), the
 * `maxRadius` the scope gives, the chain's reach plus the GNSS antenna's distance aft of
 * the bow, and the `currentRadius`, the antenna's distance from the anchor.
 *
 * An anchor that drags moves downwind with the boat at a dragging boat's pace, while the
 * position the boat reports stays where it went down, so the radius grows. When the
 * dragging stops (the crew re-anchors) the anchor is set again where it now lies.
 *
 * Positions are worked on a flat plane about the anchor, which over a few hundred metres
 * is exact enough for anything a display or an alarm can show.
 */
export interface AnchorInput {
  /** the route stops the boat at an anchorage now */
  anchored: boolean
  /** where the route has the boat, and her motion along it */
  lat: number
  lon: number
  sogKn: number
  cogDeg: number
  /** seconds until the route has her leave, while she is stopped */
  leavesInS?: number
  windKn: number
  /** the direction the wind comes from */
  windDeg: number
  /** the anchor is dragging */
  dragging: boolean
  /** scenario time, for the depth with the tide on it */
  ms: number
}

export interface AnchorPosition {
  lat: number
  lon: number
  sogKn: number
  cogDeg: number
  /** the heading she lies to: her bow towards the anchor, while it is down */
  headDeg?: number
}

/** what the boat reports of her anchor, as the anchor alarm plugin sends it */
export interface AnchorReport {
  lat: number
  lon: number
  depthM: number
  maxRadiusM: number
  currentRadiusM: number
}

export interface AnchorageState {
  set: { lat: number; lon: number; depthM: number; maxRadiusM: number } | null
  /** where the anchor lies on the bottom, which a drag moves */
  bottom: { lat: number; lon: number } | null
  chainM: number
  /** the chain at the latest step: paying out 1, heaving in -1, still 0 */
  winding: number
  boat: { lat: number; lon: number } | null
  velE: number
  velN: number
  /** after weighing, how far she is off the route, which settles away */
  residualE: number
  residualN: number
  sheerRad: number
  dragging: boolean
  /** the anchor has come up since the last report, so its values are cleared */
  weighed: boolean
  sheer: DriftState
}

const RADIANS = Math.PI / 180
const METRES_PER_DEG_LAT = (6371000 * Math.PI) / 180
const KNOT_MS = 1852 / 3600
/** chain paid out per metre of depth plus bow height, as cruising yachts anchor on chain */
export const SCOPE = 5
/** the bow roller's height above the water, per metre of length */
const BOW_HEIGHT_PER_LENGTH = 0.08
/** the GNSS antenna sits aft of the bow by this share of the length */
const GNSS_AFT_SHARE = 0.5
/** with no depth data for the anchorage, the depth a crew would anchor in */
const DEFAULT_DEPTH_M = 6
/** in a calm she lies at this share of the chain's reach; at this wind, at all of it */
const SLACK_SHARE = 0.6
const TAUT_WIND_KN = 20
/** chain paid out and heaved in, metres a second, at a windlass's pace */
const PAY_OUT_M_S = 0.3
export const HEAVE_M_S = 0.3
/** she sheers this far either side of the wind, over this period for a 10 m boat */
const SHEER_DEG = 15
const SHEER_PERIOD_S_AT_10M = 240
/** however much chain is out, her sheer carries her across the wind no faster than this */
const SHEER_MAX_KN = 0.5
/** and the line she lies on wanders with the gusts */
const WANDER_DEG = 8
const WANDER_TAU_S = 300
/** she follows where the chain and the wind put her with this time constant */
const SETTLE_S = 25
const HEAVE_SETTLE_S = 4
/** and at no more than this, metres a second */
const MAX_ANCHORED_M_S = 0.45
/** a dragging anchor moves at this pace */
export const DRAG_KN = 0.5
/** after weighing she is back on the route's track with this time constant */
const REJOIN_S = 60
/** a residual this small is gone */
const REJOINED_M = 0.05

/** the anchor watch's radius goes this far past the scope's, unless it is set */
export const ANCHOR_WATCH_MARGIN_M = 10
/** a raised anchor alarm holds until the boat is back inside the radius by this much */
export const ANCHOR_WATCH_HOLD_M = 5

/** the anchor watch's radius: the one set, or the scope's radius and the margin */
export function watchRadiusM(report: AnchorReport, setM?: number): number {
  return setM !== undefined && setM > 0
    ? setM
    : report.maxRadiusM + ANCHOR_WATCH_MARGIN_M
}

/**
 * The anchor watch: raised once the boat is further from her anchor than the radius, and
 * held until she is back inside it by the margin
 */
export function anchorWatch(
  raised: boolean,
  currentRadiusM: number,
  radiusM: number
): boolean {
  return raised
    ? currentRadiusM > radiusM - ANCHOR_WATCH_HOLD_M
    : currentRadiusM > radiusM
}

export class Anchorage {
  private set: AnchorageState['set'] = null
  private bottom: AnchorageState['bottom'] = null
  private chainM = 0
  private winding = 0
  private boat: AnchorageState['boat'] = null
  private velE = 0
  private velN = 0
  private residualE = 0
  private residualN = 0
  private sheerRad = 0
  private dragging = false
  private weighed = false
  private readonly sheer: Drift
  private readonly bowHeightM: number
  private readonly gnssAftM: number
  private readonly sheerPeriodS: number
  private readonly sheerMaxM: number
  private out: AnchorPosition | undefined

  constructor(
    lengthM: number,
    seed: number,
    private readonly depthAt?: (
      lat: number,
      lon: number,
      ms: number
    ) => number | undefined
  ) {
    const rng = new Rng(seed, 'anchorage')
    this.sheerRad = rng.between(0, 2 * Math.PI)
    this.sheer = new Drift(rng, WANDER_DEG, WANDER_TAU_S)
    this.bowHeightM = BOW_HEIGHT_PER_LENGTH * lengthM
    this.gnssAftM = GNSS_AFT_SHARE * lengthM
    this.sheerPeriodS = SHEER_PERIOD_S_AT_10M * Math.sqrt(lengthM / 10)
    // the side to side distance at which a sine of this period peaks at that speed
    this.sheerMaxM =
      (SHEER_MAX_KN * KNOT_MS * this.sheerPeriodS) / (2 * Math.PI)
  }

  /** the anchor is down */
  get down(): boolean {
    return this.set !== null
  }

  /** what the boat reports of her anchor while it is down */
  get report(): AnchorReport | undefined {
    if (!this.set || !this.boat) return undefined
    return {
      lat: this.set.lat,
      lon: this.set.lon,
      depthM: this.set.depthM,
      maxRadiusM: this.set.maxRadiusM,
      currentRadiusM: metresBetween(this.boat, this.set)
    }
  }

  /**
   * Where the boat is, when the anchorage puts her somewhere other than the route: on her
   * chain, or rejoining the track after weighing
   */
  get position(): AnchorPosition | undefined {
    return this.out
  }

  /** the anchor came up since this was last asked, so a report clears its values */
  takeWeighed(): boolean {
    const w = this.weighed
    this.weighed = false
    return w
  }

  /** metres of chain out, as a windlass's chain counter reads it: 0 with the anchor up */
  get chainOutM(): number {
    return this.chainM
  }

  /** the chain at the latest step: paying out 1, heaving in -1, still 0 */
  get chainWinding(): number {
    return this.winding
  }

  /** the radius the boat swings in with this much chain out at this depth */
  maxRadiusFor(depthM: number): number {
    return this.reach(this.scopeM(depthM), depthM) + this.gnssAftM
  }

  private scopeM(depthM: number): number {
    return SCOPE * (depthM + this.bowHeightM)
  }

  /** how far the chain reaches along the bottom, with this much of it out */
  private reach(chainM: number, depthM: number): number {
    const h = depthM + this.bowHeightM
    return Math.sqrt(Math.max(0, chainM * chainM - h * h))
  }

  private depth(lat: number, lon: number, ms: number): number {
    const d = this.depthAt?.(lat, lon, ms)
    return d !== undefined && d > 0 ? d : DEFAULT_DEPTH_M
  }

  /** `first` is the run's first step, when a boat already at anchor is found lying to it */
  step(dt: number, m: AnchorInput, first: boolean): void {
    const before = this.chainM
    this.stepAnchor(dt, m, first)
    this.winding = first ? 0 : Math.sign(this.chainM - before)
  }

  private stepAnchor(dt: number, m: AnchorInput, first: boolean): void {
    if (!m.anchored) {
      if (this.set) this.weigh(m)
      this.rejoin(dt, m)
      return
    }
    if (!this.set) this.drop(m, first)
    const set = this.set!
    const bottom = this.bottom!
    const downwind = (m.windDeg + 180) * RADIANS
    if (m.dragging) {
      const d = DRAG_KN * KNOT_MS * dt
      Object.assign(
        bottom,
        offset(bottom, d * Math.sin(downwind), d * Math.cos(downwind))
      )
    } else if (this.dragging) {
      // the crew has re-anchored: the anchor is set again where it now lies
      const depthM = this.depth(bottom.lat, bottom.lon, m.ms)
      this.set = {
        lat: bottom.lat,
        lon: bottom.lon,
        depthM,
        maxRadiusM: this.maxRadiusFor(depthM)
      }
    }
    this.dragging = m.dragging
    const depthM = this.depth(bottom.lat, bottom.lon, m.ms)
    const full = this.scopeM(set.depthM)
    // heaving in, the windlass brings the chain up at its pace, timed so that the last of
    // it, from the bow roller straight down to the anchor, is in as she leaves
    const heaveTo =
      m.leavesInS === undefined
        ? Infinity
        : depthM + this.bowHeightM + Math.max(0, m.leavesInS) * HEAVE_M_S
    this.chainM =
      heaveTo < this.chainM
        ? heaveTo
        : Math.min(full, this.chainM + PAY_OUT_M_S * dt)

    this.sheerRad =
      (this.sheerRad + (2 * Math.PI * dt) / this.sheerPeriodS) % (2 * Math.PI)
    this.sheer.step(dt)
    const pull = Math.min(1, m.windKn / TAUT_WIND_KN)
    const lying =
      this.reach(this.chainM, depthM) *
      (m.dragging ? 1 : SLACK_SHARE + (1 - SLACK_SHARE) * pull)
    // heaving in, the windlass brings her up to the anchor at its own pace, timed so the
    // anchor breaks out as she leaves
    const heaving = m.leavesInS !== undefined && m.leavesInS * HEAVE_M_S < lying
    const lie = heaving ? Math.max(0, m.leavesInS! * HEAVE_M_S) : lying
    const from = lie + this.gnssAftM
    // on a long scope the same angle would carry her far, and fast, from side to side
    const swingRad = Math.min(
      SHEER_DEG * RADIANS,
      Math.asin(Math.min(1, this.sheerMaxM / Math.max(from, this.sheerMaxM)))
    )
    const bearing =
      downwind +
      (swingRad / SHEER_DEG / RADIANS) *
        (SHEER_DEG * Math.sin(this.sheerRad) + this.sheer.value) *
        RADIANS
    const target = offset(
      bottom,
      from * Math.sin(bearing),
      from * Math.cos(bearing)
    )
    const boat = this.boat ?? target
    const [e, n] = metresFrom(boat, target)
    // heaving in, the chain brings her up to the anchor as fast as it comes in
    const k = 1 - Math.exp(-dt / (heaving ? HEAVE_SETTLE_S : SETTLE_S))
    // on her chain, under the windlass or dragging, she never makes a passage's speed
    const stepM = Math.hypot(e, n) * k
    const cap =
      stepM > MAX_ANCHORED_M_S * dt ? (MAX_ANCHORED_M_S * dt) / stepM : 1
    this.boat = offset(boat, e * k * cap, n * k * cap)
    this.velE = (e * k * cap) / dt
    this.velN = (n * k * cap) / dt
    const [toE, toN] = metresFrom(this.boat, bottom)
    this.out = {
      lat: this.boat.lat,
      lon: this.boat.lon,
      ...motion(this.velE, this.velN),
      headDeg: norm360(Math.atan2(toE, toN) / RADIANS)
    }
  }

  private drop(m: AnchorInput, first: boolean): void {
    const depthM = this.depth(m.lat, m.lon, m.ms)
    this.set = {
      lat: m.lat,
      lon: m.lon,
      depthM,
      maxRadiusM: this.maxRadiusFor(depthM)
    }
    this.bottom = { lat: m.lat, lon: m.lon }
    this.dragging = false
    // a run that starts at anchor finds her lying to all her chain
    this.chainM = first ? this.scopeM(depthM) : depthM + this.bowHeightM
    this.boat = first ? null : { lat: m.lat, lon: m.lon }
    this.residualE = 0
    this.residualN = 0
  }

  /** the anchor is up: from here she makes back to the route's track */
  private weigh(m: AnchorInput): void {
    if (this.boat) {
      const [e, n] = metresFrom({ lat: m.lat, lon: m.lon }, this.boat)
      this.residualE = e
      this.residualN = n
    }
    this.set = null
    this.bottom = null
    this.boat = null
    this.chainM = 0
    this.dragging = false
    this.weighed = true
  }

  private rejoin(dt: number, m: AnchorInput): void {
    if (Math.hypot(this.residualE, this.residualN) < REJOINED_M) {
      this.residualE = 0
      this.residualN = 0
      this.out = undefined
      return
    }
    const k = Math.exp(-dt / REJOIN_S)
    const e = this.residualE * k
    const n = this.residualN * k
    const course = m.cogDeg * RADIANS
    const speed = m.sogKn * KNOT_MS
    const at = offset({ lat: m.lat, lon: m.lon }, e, n)
    this.out = {
      lat: at.lat,
      lon: at.lon,
      ...motion(
        speed * Math.sin(course) + (e - this.residualE) / dt,
        speed * Math.cos(course) + (n - this.residualN) / dt
      )
    }
    this.residualE = e
    this.residualN = n
  }

  save(): AnchorageState {
    return {
      set: this.set && { ...this.set },
      bottom: this.bottom && { ...this.bottom },
      chainM: this.chainM,
      winding: this.winding,
      boat: this.boat && { ...this.boat },
      velE: this.velE,
      velN: this.velN,
      residualE: this.residualE,
      residualN: this.residualN,
      sheerRad: this.sheerRad,
      dragging: this.dragging,
      weighed: this.weighed,
      sheer: this.sheer.save()
    }
  }

  /** puts saved values back; `check` refuses one that does not fit */
  restore(s: AnchorageState, check: (ok: boolean, what: string) => void): void {
    check(typeof s === 'object' && s !== null, 'anchorage')
    for (const k of [
      'chainM',
      'winding',
      'velE',
      'velN',
      'residualE',
      'residualN',
      'sheerRad'
    ] as const) {
      check(Number.isFinite(s[k]), `anchorage ${k}`)
    }
    const point = (p: unknown) =>
      p === null ||
      (typeof p === 'object' &&
        Number.isFinite((p as { lat: number }).lat) &&
        Number.isFinite((p as { lon: number }).lon))
    check(point(s.set) && point(s.bottom) && point(s.boat), 'anchorage points')
    check(Number.isFinite(s.sheer?.value), 'anchorage sheer')
    this.set = s.set && { ...s.set }
    this.bottom = s.bottom && { ...s.bottom }
    this.chainM = s.chainM
    this.winding = s.winding
    this.boat = s.boat && { ...s.boat }
    this.velE = s.velE
    this.velN = s.velN
    this.residualE = s.residualE
    this.residualN = s.residualN
    this.sheerRad = s.sheerRad
    this.dragging = s.dragging === true
    this.weighed = s.weighed === true
    this.sheer.restore(s.sheer)
    if (this.boat && this.bottom) {
      const [toE, toN] = metresFrom(this.boat, this.bottom)
      this.out = {
        lat: this.boat.lat,
        lon: this.boat.lon,
        ...motion(this.velE, this.velN),
        headDeg: norm360(Math.atan2(toE, toN) / RADIANS)
      }
    }
  }
}

/** metres east and north from one point to another */
export function metresFrom(
  from: { lat: number; lon: number },
  to: { lat: number; lon: number }
): [number, number] {
  return [
    (to.lon - from.lon) * METRES_PER_DEG_LAT * Math.cos(from.lat * RADIANS),
    (to.lat - from.lat) * METRES_PER_DEG_LAT
  ]
}

export function metresBetween(
  a: { lat: number; lon: number },
  b: { lat: number; lon: number }
): number {
  return Math.hypot(...metresFrom(a, b))
}

function offset(
  p: { lat: number; lon: number },
  east: number,
  north: number
): { lat: number; lon: number } {
  return {
    lat: p.lat + north / METRES_PER_DEG_LAT,
    lon: p.lon + east / (METRES_PER_DEG_LAT * Math.cos(p.lat * RADIANS))
  }
}

function motion(e: number, n: number): { sogKn: number; cogDeg: number } {
  return {
    sogKn: Math.hypot(e, n) / KNOT_MS,
    cogDeg: norm360(Math.atan2(e, n) / RADIANS)
  }
}

function norm360(deg: number): number {
  return ((deg % 360) + 360) % 360
}
