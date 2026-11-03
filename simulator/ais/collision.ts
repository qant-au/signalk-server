/**
 * Collision avoidance, as a plotter works it out: the closest point of approach between
 * the own boat and each target, and the time to it, from both boats' positions, courses
 * and speeds, held steady. Over the few miles AIS reaches, the sea is flat enough to work
 * on: positions go onto a plane about the own boat, metres east and north.
 */
const EARTH_RADIUS_M = 6371000
const RADIANS = Math.PI / 180
const METRES_PER_SECOND_PER_KNOT = 1852 / 3600
/** relative speeds below this, metres a second squared, are boats keeping station */
const STILL = 1e-6

export interface Mover {
  lat: number
  lon: number
  sogKn: number
  /** course over the ground; a boat with none is taken as still */
  cogDeg?: number
}

export interface Approach {
  /** the closest point of approach, metres */
  distanceM: number
  /** seconds until it */
  timeToS: number
}

/** the closest approach, or undefined when the two are not closing */
export function closestApproach(
  own: Mover,
  target: Mover
): Approach | undefined {
  const cos = Math.cos(own.lat * RADIANS)
  const x = (target.lon - own.lon) * RADIANS * EARTH_RADIUS_M * cos
  const y = (target.lat - own.lat) * RADIANS * EARTH_RADIUS_M
  const [ownE, ownN] = velocity(own)
  const [targetE, targetN] = velocity(target)
  const u = targetE - ownE
  const v = targetN - ownN
  const speed2 = u * u + v * v
  if (speed2 < STILL) return undefined
  const timeToS = -(x * u + y * v) / speed2
  if (!(timeToS > 0)) return undefined
  return {
    distanceM: Math.hypot(x + u * timeToS, y + v * timeToS),
    timeToS
  }
}

function velocity(m: Mover): [number, number] {
  if (m.cogDeg === undefined) return [0, 0]
  const speed = m.sogKn * METRES_PER_SECOND_PER_KNOT
  const c = m.cogDeg * RADIANS
  return [speed * Math.sin(c), speed * Math.cos(c)]
}

/** where a boat is `seconds` on, on her course and speed */
export function deadReckon<M extends Mover>(m: M, seconds: number): M {
  const [e, n] = velocity(m)
  if (!e && !n) return m
  return {
    ...m,
    lat: m.lat + (n * seconds) / EARTH_RADIUS_M / RADIANS,
    lon:
      m.lon +
      (e * seconds) / (EARTH_RADIUS_M * Math.cos(m.lat * RADIANS)) / RADIANS
  }
}

/** the plugin's collision alarm limits */
export interface CollisionLimits {
  /** a closest approach inside this, metres */
  distanceM: number
  /** coming within this, seconds; the alarm at half of it */
  timeS: number
}

export const DEFAULT_COLLISION_LIMITS: CollisionLimits = {
  distanceM: 15,
  timeS: 60
}
/**
 * A target making less than this, or reporting itself moored or at anchor, is lying to
 * its moorings or drifting, and raises no alarm, as a plotter's target filters keep a
 * waterway lined with berths quiet
 */
export const ALARM_MIN_SPEED_KN = 1
/** AIS navigational statuses: at anchor, moored */
const AT_REST = new Set([1, 5])
/** a raised alarm holds until its approach is this share wider, or this much later */
const DISTANCE_MARGIN_SHARE = 0.25
const TIME_MARGIN_S = 15
/**
 * Between a target's own reports its closest approach goes out every second while it is
 * inside this many times the alarm's limits, so a display sees it count down
 */
const WATCHED_WITHIN = 2

export const COLLISION_PATH = 'navigation.closestApproach'
export const COLLISION_NOTIFICATION = 'notifications.navigation.closestApproach'

export type CollisionState = 'warn' | 'alarm'

export interface WatchedTarget {
  context: string
  /** how the alarm names it: its name, or its MMSI */
  label: string
  sogKn: number
  /** its AIS navigational status */
  navStatus?: number
  approach?: Approach
}

export interface CollisionNote {
  context: string
  value: {
    state: CollisionState | 'normal'
    method: ('visual' | 'sound')[]
    message: string
  }
}

/**
 * The collision alarm: one notification per target, in the target's own context at
 * `notifications.navigation.closestApproach`, as the AIS target prioritizer plugin names
 * its own, so a display that reads those reads these. A warning while the target's
 * closest approach is inside the distance limit within the time limit, an alarm within
 * half the time; a raised one holds until the approach is back out by the margin, and
 * clears once the target is no longer closing, or is lost.
 */
export class CollisionWatch {
  private readonly raised = new Map<string, CollisionNote['value']>()
  /** targets with a closest approach out, which a null clears once they stop closing */
  private readonly sent = new Set<string>()

  constructor(readonly limits: CollisionLimits) {}

  private judge(t: WatchedTarget): CollisionState | undefined {
    const a = t.approach
    if (
      !a ||
      t.sogKn < ALARM_MIN_SPEED_KN ||
      (t.navStatus !== undefined && AT_REST.has(t.navStatus))
    )
      return undefined
    const { distanceM, timeS } = this.limits
    const inside = (d: number, s: number) => a.distanceM < d && a.timeToS < s
    const raw = inside(distanceM, timeS / 2)
      ? 'alarm'
      : inside(distanceM, timeS)
        ? 'warn'
        : undefined
    const held = this.raised.get(t.context)?.state
    if (!held || held === 'normal' || raw === 'alarm') return raw
    const wide = distanceM * (1 + DISTANCE_MARGIN_SHARE)
    if (held === 'alarm' && inside(wide, timeS / 2 + TIME_MARGIN_S))
      return 'alarm'
    return inside(wide, timeS + TIME_MARGIN_S) ? 'warn' : raw
  }

  /**
   * The approaches to send and the notifications that changed, for the targets now in
   * range. `heard` are those whose report goes out now, which carry their approach with
   * it; the rest carry theirs every second while inside the watched window.
   */
  update(
    targets: Iterable<WatchedTarget>,
    heard: ReadonlySet<string>
  ): {
    approaches: { context: string; value: Approach | null }[]
    notes: CollisionNote[]
  } {
    const approaches: { context: string; value: Approach | null }[] = []
    const notes: CollisionNote[] = []
    const { distanceM, timeS } = this.limits
    for (const t of targets) {
      const a = t.approach
      if (a) {
        if (
          heard.has(t.context) ||
          (a.distanceM < WATCHED_WITHIN * distanceM &&
            a.timeToS < WATCHED_WITHIN * timeS)
        ) {
          approaches.push({ context: t.context, value: a })
          this.sent.add(t.context)
        }
      } else if (this.sent.delete(t.context)) {
        approaches.push({ context: t.context, value: null })
      }
      const state = this.judge(t)
      const before = this.raised.get(t.context)
      if (state) {
        if (before?.state !== state) {
          const value = {
            state,
            method: methodFor(state),
            message: `${t.label}: closest approach ${state === 'alarm' ? 'alarm' : 'warning'}`
          }
          this.raised.set(t.context, value)
          notes.push({ context: t.context, value })
        }
      } else if (before) {
        notes.push(this.clear(t.context)!)
      }
    }
    return { approaches, notes }
  }

  /** a target lost: its alarm, if raised, cleared */
  lost(context: string): CollisionNote | undefined {
    this.sent.delete(context)
    return this.clear(context)
  }

  private clear(context: string): CollisionNote | undefined {
    const before = this.raised.get(context)
    if (!before) return undefined
    this.raised.delete(context)
    return {
      context,
      value: { state: 'normal', method: [], message: before.message }
    }
  }

  /** the collision alarms on now */
  active(): CollisionNote[] {
    return [...this.raised].map(([context, value]) => ({ context, value }))
  }
}

const methodFor = (state: CollisionState): ('visual' | 'sound')[] =>
  state === 'alarm' ? ['visual', 'sound'] : ['visual']
