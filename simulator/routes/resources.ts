import { createHash } from 'crypto'
import { Route, Waypoint } from './route'

/**
 * What a sample's route knows, as Signal K Resources API resources (the standard types in
 * packages/server-api/src/resourcetypes.ts), so a chart plotter (Freeboard on the rig)
 * draws the passage, its berths, bridges and anchorages, and the stretches taken dead slow
 * beside the boat sailing it:
 *
 * - a route: the passage as sailed, after any adjustment for depth
 * - waypoints: each named waypoint of the planned route, and each bridge, named for it
 * - notes: one at each bridge and one at each anchorage
 * - regions: each run of legs planned at `DEAD_SLOW_KN` or less, `REGION_HALF_WIDTH_M`
 *   either side of the legs sailed. These come from the leg speeds, not from a chart.
 *
 * Every id is a UUID made from the route's name, the type and the resource's name, so a
 * run started again replaces its own resources rather than adding copies.
 */

export interface RouteResource {
  name: string
  description: string
  feature: {
    type: 'Feature'
    geometry: { type: 'LineString'; coordinates: [number, number][] }
    properties: Record<string, never>
  }
}

export type WaypointKind = 'berth' | 'anchorage' | 'bridge' | 'waypoint'

export interface WaypointResource {
  name: string
  description?: string
  type: WaypointKind
  feature: {
    type: 'Feature'
    geometry: { type: 'Point'; coordinates: [number, number] }
    properties: {
      type: WaypointKind
      /** a bridge's vertical clearance closed, metres */
      closedClearanceM?: number
      /** how long the boat waits here, seconds */
      holdS?: number
    }
  }
}

export interface NoteResource {
  name: string
  description: string
  position: { latitude: number; longitude: number }
}

export interface RegionResource {
  name: string
  description: string
  feature: {
    type: 'Feature'
    geometry: { type: 'Polygon'; coordinates: [number, number][][] }
    properties: Record<string, never>
  }
}

export interface Published<T> {
  id: string
  value: T
}

export interface SampleResources {
  routes: Published<RouteResource>[]
  waypoints: Published<WaypointResource>[]
  notes: Published<NoteResource>[]
  regions: Published<RegionResource>[]
}

export type ResourceType = keyof SampleResources

export type ResourceCounts = Record<ResourceType, number>

export const RESOURCE_TYPES: ResourceType[] = [
  'routes',
  'waypoints',
  'notes',
  'regions'
]

/** a leg planned at this speed or less is a dead slow stretch */
export const DEAD_SLOW_KN = 4
/** a dead slow region reaches this far either side of its legs */
export const REGION_HALF_WIDTH_M = 100
/**
 * At a sharp bend the corner of the region is cut on the line bisecting it, no further
 * than this from the waypoint, so the region never reaches far from the legs.
 */
const MAX_CORNER_FACTOR = Math.SQRT2
const METRES_PER_DEG_LAT = (6371000 * Math.PI) / 180
const RADIANS = Math.PI / 180

/** a UUID made from its parts, so the same parts always give the same id */
function stableId(...parts: string[]): string {
  const h = createHash('sha256').update(parts.join(':')).digest('hex')
  return [
    h.slice(0, 8),
    h.slice(8, 12),
    '4' + h.slice(13, 16),
    ((parseInt(h[16], 16) & 0x3) | 0x8).toString(16) + h.slice(17, 20),
    h.slice(20, 32)
  ].join('-')
}

export function routeResourceId(route: Route): string {
  return stableId(`simulator-route`, route.name)
}

function resourceId(
  route: Route,
  type: Exclude<ResourceType, 'routes'>,
  name: string
): string {
  return stableId(`simulator-${type}`, route.name, name)
}

export function routeResource(route: Route): RouteResource {
  return {
    name: route.name,
    description: `Simulator route: ${route.vessel.description}, departing ${route.departure}`,
    feature: {
      type: 'Feature',
      geometry: {
        type: 'LineString',
        coordinates: route.waypoints.map((w) => [w.lon, w.lat])
      },
      properties: {}
    }
  }
}

/** the route's resources: the route as sailed, the rest from the plan and its leg speeds */
export function sampleResources(
  planned: Route,
  sailed: Route
): SampleResources {
  const waypoints: Published<WaypointResource>[] = []
  const notes: Published<NoteResource>[] = []
  const bridges = new Map((planned.bridges ?? []).map((b) => [b.waypoint, b]))
  const last = planned.waypoints.length - 1
  const named = new Set<string>()
  planned.waypoints.forEach((w, i) => {
    const bridge = bridges.get(i)
    const name = bridge?.name ?? w.name
    // a loop ends where it began: the place is published once
    if (!name || named.has(name)) return
    named.add(name)
    const type: WaypointKind = bridge
      ? 'bridge'
      : w.anchor
        ? 'anchorage'
        : i === 0 || i === last
          ? 'berth'
          : 'waypoint'
    const properties: WaypointResource['feature']['properties'] = { type }
    if (bridge) properties.closedClearanceM = bridge.closedClearanceM
    if (w.holdS) properties.holdS = w.holdS
    const description = bridge
      ? `bridge; ${bridge.closedClearanceM} m clearance closed, at the centre of the span`
      : w.note
    waypoints.push({
      id: resourceId(planned, 'waypoints', name),
      value: {
        name,
        ...(description ? { description } : {}),
        type,
        feature: {
          type: 'Feature',
          geometry: { type: 'Point', coordinates: [w.lon, w.lat] },
          properties
        }
      }
    })
    const position = { latitude: w.lat, longitude: w.lon }
    if (bridge) {
      notes.push({
        id: resourceId(planned, 'notes', name),
        value: {
          name,
          description: `${bridge.closedClearanceM} m clearance closed. The boat holds here up to ${durationWords(w.holdS ?? 0)} for the bridge to open.`,
          position
        }
      })
    } else if (w.anchor) {
      notes.push({
        id: resourceId(planned, 'notes', name),
        value: {
          name,
          description: [
            w.note,
            w.holdS ? `She stays ${durationWords(w.holdS)}.` : ''
          ]
            .filter(Boolean)
            .join('. '),
          position
        }
      })
    }
  })
  return {
    routes: [{ id: routeResourceId(sailed), value: routeResource(sailed) }],
    waypoints,
    notes,
    regions: deadSlowRegions(sailed)
  }
}

export function resourceCounts(resources: SampleResources): ResourceCounts {
  return {
    routes: resources.routes.length,
    waypoints: resources.waypoints.length,
    notes: resources.notes.length,
    regions: resources.regions.length
  }
}

/** "1 route, 9 waypoints, 5 notes, 3 regions" */
export function countWords(counts: ResourceCounts): string {
  const one: Record<ResourceType, string> = {
    routes: 'route',
    waypoints: 'waypoint',
    notes: 'note',
    regions: 'region'
  }
  return RESOURCE_TYPES.map(
    (t) => `${counts[t]} ${counts[t] === 1 ? one[t] : t}`
  ).join(', ')
}

/**
 * The runs of consecutive legs planned at `DEAD_SLOW_KN` or less, each as a polygon around
 * the legs sailed, named for the nearest named waypoint at or before its start.
 */
function deadSlowRegions(sailed: Route): Published<RegionResource>[] {
  const wps = sailed.waypoints
  const runs: [number, number][] = []
  for (let i = 0; i < wps.length - 1; i++) {
    if ((wps[i].speedKn ?? Infinity) > DEAD_SLOW_KN) continue
    const run = runs[runs.length - 1]
    if (run && run[1] === i) run[1] = i + 1
    else runs.push([i, i + 1])
  }
  return runs.map(([from, to]) => {
    const start = namedAtOrBefore(wps, from)
    const end = namedAtOrAfter(wps, to)
    const name = `${start}, dead slow`
    return {
      id: resourceId(sailed, 'regions', name),
      value: {
        name,
        description: `Legs planned at ${DEAD_SLOW_KN} kn or less, from ${start} to ${end}, ${REGION_HALF_WIDTH_M} m either side. Derived from the simulator route's leg speeds, not from a chart.`,
        feature: {
          type: 'Feature',
          geometry: {
            type: 'Polygon',
            coordinates: [buffer(wps.slice(from, to + 1), REGION_HALF_WIDTH_M)]
          },
          properties: {}
        }
      }
    }
  })
}

function namedAtOrBefore(wps: Waypoint[], i: number): string {
  for (let j = i; j >= 0; j--) if (wps[j].name) return wps[j].name!
  return 'the start'
}

function namedAtOrAfter(wps: Waypoint[], i: number): string {
  for (let j = i; j < wps.length; j++) if (wps[j].name) return wps[j].name!
  return 'the end'
}

/**
 * A closed ring `halfWidthM` either side of a line of points: each end squared off across
 * the line, each bend on the line bisecting it.
 */
export function buffer(
  points: { lat: number; lon: number }[],
  halfWidthM: number
): [number, number][] {
  // consecutive duplicates have no direction
  const pts = points.filter(
    (p, i) =>
      i === 0 || p.lat !== points[i - 1].lat || p.lon !== points[i - 1].lon
  )
  const lat0 = pts[0].lat
  const mPerDegLon = METRES_PER_DEG_LAT * Math.cos(lat0 * RADIANS)
  const xy = pts.map((p) => [
    (p.lon - pts[0].lon) * mPerDegLon,
    (p.lat - lat0) * METRES_PER_DEG_LAT
  ])
  const direction = (a: number[], b: number[]) => {
    const d = Math.hypot(b[0] - a[0], b[1] - a[1])
    return [(b[0] - a[0]) / d, (b[1] - a[1]) / d]
  }
  const left: number[][] = []
  const right: number[][] = []
  for (let i = 0; i < xy.length; i++) {
    const before = i > 0 ? direction(xy[i - 1], xy[i]) : undefined
    const after = i < xy.length - 1 ? direction(xy[i], xy[i + 1]) : undefined
    // the left normal of each leg either side, and the line halfway between them
    const n1 = before && [-before[1], before[0]]
    const n2 = after && [-after[1], after[0]]
    let nx: number
    let ny: number
    let scale = 1
    if (n1 && n2) {
      nx = n1[0] + n2[0]
      ny = n1[1] + n2[1]
      const len = Math.hypot(nx, ny)
      if (len < 1e-9) {
        // the line doubles back on itself: the bend is squared off along the leg
        nx = n1[0]
        ny = n1[1]
      } else {
        nx /= len
        ny /= len
        const cosHalf = nx * n1[0] + ny * n1[1]
        scale = Math.min(1 / cosHalf, MAX_CORNER_FACTOR)
      }
    } else {
      const n = (n1 ?? n2)!
      nx = n[0]
      ny = n[1]
    }
    const d = halfWidthM * scale
    left.push([xy[i][0] + nx * d, xy[i][1] + ny * d])
    right.push([xy[i][0] - nx * d, xy[i][1] - ny * d])
  }
  // counter-clockwise, as GeoJSON has an outer ring
  const ring = [...right, ...left.reverse()]
  ring.push(ring[0])
  return ring.map(([x, y]) => [
    round7(pts[0].lon + x / mPerDegLon),
    round7(lat0 + y / METRES_PER_DEG_LAT)
  ])
}

/** "2 min 21 s", "2 h 30 min" */
function durationWords(s: number): string {
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const sec = Math.round(s % 60)
  if (h) return m ? `${h} h ${m} min` : `${h} h`
  if (m) return sec ? `${m} min ${sec} s` : `${m} min`
  return `${sec} s`
}

const round7 = (x: number) => Math.round(x * 1e7) / 1e7

export async function publishRoute(
  serverUrl: string,
  route: Route
): Promise<string> {
  const id = routeResourceId(route)
  const response = await fetch(
    `${serverUrl}/signalk/v2/api/resources/routes/${id}`,
    {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(routeResource(route))
    }
  )
  if (!response.ok) {
    throw new Error(`publishing the route returned HTTP ${response.status}`)
  }
  return id
}
