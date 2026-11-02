import { readFile } from 'fs/promises'
import path from 'path'
import { distanceNm } from '../ais/reception'
import { loadProfile } from '../vessels/profile'

/**
 * The own boat's planned passage: a list of waypoints, each carrying the speed for the leg
 * that leaves it. Speed belongs to the leg rather than the boat because it changes along the
 * way: dead slow through a marina, a few knots in a channel or no-wake zone, cruising speed
 * on open water.
 */
export interface Waypoint {
  name?: string
  lat: number
  lon: number
  /** speed through the water on the leg from this waypoint to the next, knots */
  speedKn?: number
  /** time to wait here before leaving, seconds (a bridge opening, a lock) */
  holdS?: number
  note?: string
}

export interface RouteVessel {
  description: string
  lengthM: number
  draftM: number
  /** AIS ship type code the own boat would broadcast */
  typeCode: number
  /** the profile in simulator/vessels the boat sails as; it supplies the fields above */
  profile?: string
}

export interface Route {
  name: string
  /** departure from the first waypoint, ISO 8601 UTC */
  departure: string
  vessel: RouteVessel
  /** how the waypoints were made, so the route can be reproduced */
  source: string
  waypoints: Waypoint[]
}

export interface Leg {
  from: Waypoint
  to: Waypoint
  distanceNm: number
  speedKn: number
  courseDeg: number
  /** when the boat leaves `from`, after any hold, ms since the epoch */
  departMs: number
  arriveMs: number
}

export interface RoutePosition {
  lat: number
  lon: number
  sogKn: number
  cogDeg: number
  legIndex: number
  finished: boolean
}

const MS_PER_HOUR = 3600 * 1000

export function initialCourseDeg(
  lat1: number,
  lon1: number,
  lat2: number,
  lon2: number
): number {
  const rad = Math.PI / 180
  const y = Math.sin((lon2 - lon1) * rad) * Math.cos(lat2 * rad)
  const x =
    Math.cos(lat1 * rad) * Math.sin(lat2 * rad) -
    Math.sin(lat1 * rad) * Math.cos(lat2 * rad) * Math.cos((lon2 - lon1) * rad)
  return (Math.atan2(y, x) / rad + 360) % 360
}

export function routeLegs(route: Route): Leg[] {
  const { waypoints } = route
  if (waypoints.length < 2) {
    throw new Error(`${route.name}: a route needs at least two waypoints`)
  }
  const legs: Leg[] = []
  let clock = Date.parse(route.departure)
  for (let i = 0; i < waypoints.length - 1; i++) {
    const from = waypoints[i]
    const to = waypoints[i + 1]
    if (!from.speedKn || from.speedKn <= 0) {
      throw new Error(
        `${route.name}: waypoint ${i} (${from.name ?? 'unnamed'}) has no leg speed`
      )
    }
    clock += (from.holdS ?? 0) * 1000
    const distance = distanceNm(from.lat, from.lon, to.lat, to.lon)
    const durationMs = (distance / from.speedKn) * MS_PER_HOUR
    legs.push({
      from,
      to,
      distanceNm: distance,
      speedKn: from.speedKn,
      courseDeg: initialCourseDeg(from.lat, from.lon, to.lat, to.lon),
      departMs: clock,
      arriveMs: clock + durationMs
    })
    clock += durationMs
  }
  return legs
}

/**
 * Where the boat is at a moment. Positions along a leg are interpolated linearly in
 * latitude and longitude, which over legs of a few miles differs from the great circle by
 * far less than a boat's own GPS error.
 */
export function positionAt(legs: Leg[], timeMs: number): RoutePosition {
  const first = legs[0]
  if (timeMs < first.departMs) {
    return {
      lat: first.from.lat,
      lon: first.from.lon,
      sogKn: 0,
      cogDeg: first.courseDeg,
      legIndex: 0,
      finished: false
    }
  }
  for (let i = 0; i < legs.length; i++) {
    const leg = legs[i]
    const next = legs[i + 1]
    if (timeMs <= leg.arriveMs) {
      const f =
        leg.arriveMs > leg.departMs
          ? (timeMs - leg.departMs) / (leg.arriveMs - leg.departMs)
          : 1
      return {
        lat: leg.from.lat + (leg.to.lat - leg.from.lat) * f,
        lon: leg.from.lon + (leg.to.lon - leg.from.lon) * f,
        sogKn: leg.speedKn,
        cogDeg: leg.courseDeg,
        legIndex: i,
        finished: false
      }
    }
    if (next && timeMs < next.departMs) {
      // holding at the next waypoint
      return {
        lat: leg.to.lat,
        lon: leg.to.lon,
        sogKn: 0,
        cogDeg: next.courseDeg,
        legIndex: i + 1,
        finished: false
      }
    }
  }
  const last = legs[legs.length - 1]
  return {
    lat: last.to.lat,
    lon: last.to.lon,
    sogKn: 0,
    cogDeg: last.courseDeg,
    legIndex: legs.length - 1,
    finished: true
  }
}

/** The profile library sits beside the samples, in simulator/vessels. */
export function vesselsDirFor(sampleDir: string): string {
  return path.join(sampleDir, '..', '..', 'vessels')
}

/**
 * A route naming a vessel profile takes its length, draft and AIS type from the profile;
 * a route without one gives them itself.
 */
export async function loadRoute(sampleDir: string): Promise<Route> {
  const route: Route = JSON.parse(
    await readFile(path.join(sampleDir, 'route.json'), 'utf8')
  )
  const id = route.vessel.profile
  if (id) {
    const profile = loadProfile(id, vesselsDirFor(sampleDir))
    route.vessel = {
      description: route.vessel.description ?? profile.name,
      lengthM: profile.lengthM,
      draftM: profile.draftM,
      typeCode: profile.typeCode,
      profile: id
    }
  }
  return route
}
