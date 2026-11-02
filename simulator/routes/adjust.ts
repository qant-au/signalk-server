import { distanceNm } from '../ais/reception'
import { Route, Waypoint } from './route'

/**
 * Moves a route off land and out of water too shallow for the boat. Each leg is sampled
 * against the depth; where part of a leg is too shallow, that stretch alone is re-routed
 * with an A* search over a grid of cells around it, and the path is straightened into as
 * few legs as stay in safe water. The new waypoints keep the leg's speed.
 *
 * Berths are inside marinas, which are shallower than a passage needs, and the coarser
 * grids cannot resolve a marina basin or a dredged channel at all. Within `harbourRadiusM`
 * of the first and last waypoint any surveyed water counts as passable, and, where the grid
 * cannot resolve the harbour (`harbourNoDataIsWater`), so does anywhere it has no data.
 * Charted dry land never does. Outside that radius the full depth applies.
 */
export interface Depths {
  depth(lat: number, lon: number): number | undefined
  elevation(lat: number, lon: number): number | undefined
}

export interface AdjustOptions {
  /** the boat's draft plus the minimum depth under the keel, metres */
  minDepthM: number
  /** routing grid cell size, metres */
  cellM: number
  harbourRadiusM: number
  harbourNoDataIsWater: boolean
}

export interface Adjustment {
  leg: number
  from: string
  to: string
  /** shallowest depth found on the original leg; undefined means land or no survey */
  shallowestM?: number
  added: number
  resolved: boolean
}

const METRES_PER_DEGREE = 111320
const METRES_PER_NM = 1852
const FIRST_MARGIN_M = 500
const MAX_MARGIN_M = 8000
const APPROACH_M = 300
const NEIGHBOURS: [number, number][] = [
  [1, 0],
  [-1, 0],
  [0, 1],
  [0, -1],
  [1, 1],
  [1, -1],
  [-1, 1],
  [-1, -1]
]

type Point = { lat: number; lon: number }

function lerp(a: Point, b: Point, f: number): Point {
  return { lat: a.lat + (b.lat - a.lat) * f, lon: a.lon + (b.lon - a.lon) * f }
}

function metres(a: Point, b: Point): number {
  return distanceNm(a.lat, a.lon, b.lat, b.lon) * METRES_PER_NM
}

export class DepthCheck {
  constructor(
    private readonly depths: Depths,
    private readonly options: AdjustOptions,
    private readonly berths: Point[]
  ) {}

  safe(p: Point): boolean {
    const nearest = Math.min(...this.berths.map((b) => metres(p, b)))
    if (nearest <= this.options.cellM) return true
    if (nearest <= this.options.harbourRadiusM) {
      const elevation = this.depths.elevation(p.lat, p.lon)
      return elevation === undefined
        ? this.options.harbourNoDataIsWater
        : elevation < 0
    }
    const d = this.depths.depth(p.lat, p.lon)
    return d !== undefined && d >= this.options.minDepthM
  }

  /** samples along a segment, at half a cell apart */
  samples(a: Point, b: Point): Point[] {
    const n = Math.max(2, Math.ceil(metres(a, b) / (this.options.cellM / 2)))
    return Array.from({ length: n + 1 }, (_, k) => lerp(a, b, k / n))
  }

  clear(a: Point, b: Point): boolean {
    return this.samples(a, b).every((p) => this.safe(p))
  }

  shallowest(a: Point, b: Point): number | undefined {
    let shallowest = Infinity
    for (const p of this.samples(a, b)) {
      const d = this.depths.depth(p.lat, p.lon)
      if (d === undefined) return undefined
      shallowest = Math.min(shallowest, d)
    }
    return shallowest
  }
}

/** A* over grid cells from a to b inside a box `marginM` around them. */
export function findPath(
  check: DepthCheck,
  a: Point,
  b: Point,
  cellM: number,
  marginM: number
): Point[] | undefined {
  const lat0 = (a.lat + b.lat) / 2
  const dLat = cellM / METRES_PER_DEGREE
  const dLon = cellM / (METRES_PER_DEGREE * Math.cos((lat0 * Math.PI) / 180))
  const marginLat = marginM / METRES_PER_DEGREE
  const marginLon = (marginLat * dLon) / dLat
  const south = Math.min(a.lat, b.lat) - marginLat
  const west = Math.min(a.lon, b.lon) - marginLon
  const rows =
    Math.ceil((Math.max(a.lat, b.lat) + marginLat - south) / dLat) + 1
  const cols = Math.ceil((Math.max(a.lon, b.lon) + marginLon - west) / dLon) + 1
  const centre = (r: number, c: number): Point => ({
    lat: south + r * dLat,
    lon: west + c * dLon
  })
  const cellOf = (p: Point) => [
    Math.round((p.lat - south) / dLat),
    Math.round((p.lon - west) / dLon)
  ]
  const [sr, sc] = cellOf(a)
  const [gr, gc] = cellOf(b)
  const index = (r: number, c: number) => r * cols + c

  const passable = new Int8Array(rows * cols) // 0 unknown, 1 safe, -1 not
  const isPassable = (r: number, c: number) => {
    const i = index(r, c)
    if (!passable[i]) passable[i] = check.safe(centre(r, c)) ? 1 : -1
    return passable[i] === 1
  }
  const g = new Float64Array(rows * cols).fill(Infinity)
  const from = new Int32Array(rows * cols).fill(-1)
  const closed = new Uint8Array(rows * cols)
  const heuristic = (r: number, c: number) => Math.hypot(r - gr, c - gc)

  // binary heap of [f, index]
  const heap: [number, number][] = []
  const push = (f: number, i: number) => {
    heap.push([f, i])
    let k = heap.length - 1
    while (k > 0) {
      const parent = (k - 1) >> 1
      if (heap[parent][0] <= heap[k][0]) break
      ;[heap[parent], heap[k]] = [heap[k], heap[parent]]
      k = parent
    }
  }
  const pop = () => {
    const top = heap[0]
    const last = heap.pop()!
    if (heap.length) {
      heap[0] = last
      let k = 0
      for (;;) {
        const l = 2 * k + 1
        const r = l + 1
        let m = k
        if (l < heap.length && heap[l][0] < heap[m][0]) m = l
        if (r < heap.length && heap[r][0] < heap[m][0]) m = r
        if (m === k) break
        ;[heap[m], heap[k]] = [heap[k], heap[m]]
        k = m
      }
    }
    return top
  }

  const start = index(sr, sc)
  const goal = index(gr, gc)
  g[start] = 0
  push(heuristic(sr, sc), start)
  while (heap.length) {
    const [, current] = pop()
    if (current === goal) break
    if (closed[current]) continue
    closed[current] = 1
    const r = Math.floor(current / cols)
    const c = current % cols
    for (const [dr, dc] of NEIGHBOURS) {
      const nr = r + dr
      const nc = c + dc
      if (nr < 0 || nc < 0 || nr >= rows || nc >= cols) continue
      const ni = index(nr, nc)
      if (closed[ni]) continue
      if (ni !== goal && !isPassable(nr, nc)) continue
      // the step itself, not just the cell it lands in, must stay in safe water
      if (ni !== goal && !check.clear(centre(r, c), centre(nr, nc))) continue
      const cost = g[current] + (dr && dc ? Math.SQRT2 : 1)
      if (cost < g[ni]) {
        g[ni] = cost
        from[ni] = current
        push(cost + heuristic(nr, nc), ni)
      }
    }
  }
  if (from[goal] < 0 && goal !== start) return undefined

  const cells: Point[] = []
  for (let i = goal; i >= 0; i = from[i]) {
    cells.push(centre(Math.floor(i / cols), i % cols))
    if (i === start) break
  }
  cells.reverse()
  cells[0] = a
  cells[cells.length - 1] = b
  return cells
}

/** Keeps the fewest points of a path such that every straight segment stays in safe water. */
export function straighten(check: DepthCheck, path: Point[]): Point[] {
  const out = [path[0]]
  let i = 0
  while (i < path.length - 1) {
    let j = path.length - 1
    while (j > i + 1 && !check.clear(path[i], path[j])) j--
    out.push(path[j])
    i = j
  }
  return out
}

function adjustOnce(
  route: Route,
  depths: Depths,
  options: AdjustOptions
): { route: Route; adjustments: Adjustment[] } {
  const wps = route.waypoints
  const check = new DepthCheck(depths, options, [wps[0], wps[wps.length - 1]])
  const out: Waypoint[] = []
  const adjustments: Adjustment[] = []

  for (let i = 0; i < wps.length - 1; i++) {
    const from = wps[i]
    const to = wps[i + 1]
    out.push(from)
    const samples = check.samples(from, to)
    const bad = samples.map((p) => !check.safe(p))
    if (!bad.includes(true)) continue

    const legM = metres(from, to)
    const step = legM / (samples.length - 1)
    const firstBad = bad.indexOf(true)
    const lastBad = bad.lastIndexOf(true)
    const back = Math.ceil(APPROACH_M / step)
    // anchors just outside the bad stretch, in safe water (or the leg ends themselves)
    let ai = Math.max(0, firstBad - back)
    while (ai > 0 && bad[ai]) ai--
    let bi = Math.min(samples.length - 1, lastBad + back)
    while (bi < samples.length - 1 && bad[bi]) bi++
    const a = ai === 0 ? { lat: from.lat, lon: from.lon } : samples[ai]
    const b =
      bi === samples.length - 1 ? { lat: to.lat, lon: to.lon } : samples[bi]

    let path: Point[] | undefined
    for (
      let margin = FIRST_MARGIN_M;
      !path && margin <= MAX_MARGIN_M;
      margin *= 2
    ) {
      path = findPath(check, a, b, options.cellM, margin)
    }
    const adjustment: Adjustment = {
      leg: i + 1,
      from: from.name ?? `waypoint ${i + 1}`,
      to: to.name ?? `waypoint ${i + 2}`,
      shallowestM: check.shallowest(from, to),
      added: 0,
      resolved: Boolean(path)
    }
    if (path) {
      const straight = straighten(check, path)
      const inner = [
        ...(ai === 0 ? [] : [a]),
        ...straight.slice(1, -1),
        ...(bi === samples.length - 1 ? [] : [b])
      ]
      for (const p of inner) {
        out.push({
          lat: Number(p.lat.toFixed(6)),
          lon: Number(p.lon.toFixed(6)),
          speedKn: from.speedKn,
          note: 'added to keep the boat in safe water'
        })
      }
      adjustment.added = inner.length
    }
    adjustments.push(adjustment)
  }
  out.push(wps[wps.length - 1])
  return { route: { ...route, waypoints: out }, adjustments }
}

/**
 * Adjusts until every leg checks clear. A second pass catches the odd point where a new
 * leg, sampled at its own spacing, clips a cell the grid search stepped around.
 */
export function adjustRoute(
  route: Route,
  depths: Depths,
  options: AdjustOptions
): { route: Route; adjustments: Adjustment[] } {
  const MAX_PASSES = 3
  let current = route
  const all: Adjustment[] = []
  for (let pass = 0; pass < MAX_PASSES; pass++) {
    const result = adjustOnce(current, depths, options)
    all.push(...result.adjustments)
    current = result.route
    if (!result.adjustments.length) break
  }
  return { route: current, adjustments: all }
}
