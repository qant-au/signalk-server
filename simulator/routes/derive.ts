import { AisReport } from '../ais/targets'
import { Waypoint } from './route'

/** [west, south, east, north] */
export type Box = [number, number, number, number]

/**
 * How to find a real vessel's passage in a sample's AIS and turn it into a route. The
 * route keeps only geometry and speeds: no identity from the source vessel survives.
 */
export interface DeriveConfig {
  /** where the route starts and ends; the source vessel may have run it either way */
  startBox: Box
  endBox: Box
  /** boxes the passage must also go through, to pick (say) the inside route over the outside */
  viaBoxes?: Box[]
  minLengthM: number
  maxLengthM: number
  /** Douglas-Peucker tolerance for simplifying the track, metres */
  simplifyM: number
  /** reports slower than this count as stopped */
  minMovingKn: number
  /** a stop at least this long becomes a hold at the waypoint before it, seconds */
  minHoldS: number
  /** leg speeds are clamped to this range and rounded to half a knot */
  minLegKn: number
  maxLegKn: number
}

const METRES_PER_DEGREE_LAT = 111_320
const HALF_KNOT = 0.5

function inBox(
  lat: number,
  lon: number,
  [west, south, east, north]: Box
): boolean {
  return lon >= west && lon <= east && lat >= south && lat <= north
}

/**
 * The part of a track that runs between the two boxes, in route order (start to end).
 * Returns undefined when the track never connects them.
 */
export function passageBetween(
  track: AisReport[],
  config: DeriveConfig
): AisReport[] | undefined {
  const lastIndexIn = (box: Box, before: number) => {
    for (let i = before - 1; i >= 0; i--)
      if (inBox(track[i].lat, track[i].lon, box)) return i
    return -1
  }
  const firstIndexIn = (box: Box) =>
    track.findIndex((r) => inBox(r.lat, r.lon, box))

  const candidates: AisReport[][] = []
  for (const [from, to, reverse] of [
    [config.startBox, config.endBox, false],
    [config.endBox, config.startBox, true]
  ] as const) {
    const arrive = firstIndexIn(to)
    if (arrive < 0) continue
    const leave = lastIndexIn(from, arrive)
    if (leave < 0) continue
    const segment = track.slice(leave, arrive + 1)
    candidates.push(reverse ? [...segment].reverse() : segment)
  }
  return candidates
    .filter((segment) =>
      (config.viaBoxes ?? []).every((box) =>
        segment.some((r) => inBox(r.lat, r.lon, box))
      )
    )
    .sort((a, b) => b.length - a.length)[0]
}

function toMetres(lat0: number, lat: number, lon: number): [number, number] {
  return [
    lon * METRES_PER_DEGREE_LAT * Math.cos((lat0 * Math.PI) / 180),
    lat * METRES_PER_DEGREE_LAT
  ]
}

/** Indices of the points Douglas-Peucker keeps, at a tolerance in metres. */
export function simplify(
  points: { lat: number; lon: number }[],
  toleranceM: number,
  mustKeep: Iterable<number> = []
): number[] {
  if (points.length < 3) return points.map((_, i) => i)
  const lat0 = points[0].lat
  const xy = points.map((p) => toMetres(lat0, p.lat, p.lon))
  const fixed = [...new Set([0, ...mustKeep, points.length - 1])].sort(
    (x, y) => x - y
  )
  const keep = new Set<number>(fixed)
  const stack: [number, number][] = fixed.slice(1).map((b, i) => [fixed[i], b])
  while (stack.length) {
    const [a, b] = stack.pop()!
    const [ax, ay] = xy[a]
    const [bx, by] = xy[b]
    const length = Math.hypot(bx - ax, by - ay)
    let worst = -1
    let worstDistance = 0
    for (let i = a + 1; i < b; i++) {
      const [px, py] = xy[i]
      const d =
        length === 0
          ? Math.hypot(px - ax, py - ay)
          : Math.abs((bx - ax) * (ay - py) - (ax - px) * (by - ay)) / length
      if (d > worstDistance) {
        worstDistance = d
        worst = i
      }
    }
    if (worst >= 0 && worstDistance > toleranceM) {
      keep.add(worst)
      stack.push([a, worst], [worst, b])
    }
  }
  return [...keep].sort((x, y) => x - y)
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2
}

/**
 * Waypoints from a passage: the simplified track, each leg's speed the median speed the
 * source vessel actually made along it, so slow stretches (marinas, no-wake zones) stay
 * slow and open stretches stay fast. Where the vessel stopped for a while (on the
 * Intracoastal Waterway, usually waiting for a bridge to open) the waypoint before the stop
 * is kept and holds for as long as the vessel waited.
 */
export function waypointsFromPassage(
  passage: AisReport[],
  config: DeriveConfig
): Waypoint[] {
  const moving: AisReport[] = []
  const holds = new Map<number, number>()
  let stoppedSince: number | undefined
  for (const r of passage) {
    if (r.sogKn < config.minMovingKn) {
      stoppedSince ??= r.timeMs
      continue
    }
    if (stoppedSince !== undefined && moving.length) {
      // a passage taken in reverse runs backwards in time
      const waitedS = Math.abs(r.timeMs - stoppedSince) / 1000
      if (waitedS >= config.minHoldS)
        holds.set(moving.length - 1, Math.round(waitedS))
    }
    stoppedSince = undefined
    moving.push(r)
  }

  const kept = simplify(moving, config.simplifyM, holds.keys())
  return kept.map((index, k) => {
    const waypoint: Waypoint = {
      lat: Number(moving[index].lat.toFixed(5)),
      lon: Number(moving[index].lon.toFixed(5))
    }
    const hold = holds.get(index)
    if (hold) waypoint.holdS = hold
    const next = kept[k + 1]
    if (next !== undefined) {
      const speeds = moving.slice(index, next + 1).map((r) => r.sogKn)
      const clamped = Math.min(
        config.maxLegKn,
        Math.max(config.minLegKn, median(speeds))
      )
      waypoint.speedKn = Math.round(clamped / HALF_KNOT) * HALF_KNOT
    }
    return waypoint
  })
}
