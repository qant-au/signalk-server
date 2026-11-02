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
  /** speed over the ground on the leg from this waypoint to the next, knots */
  speedKn?: number
  /** time to wait here before leaving, seconds (a bridge opening, a lock) */
  holdS?: number
  /**
   * the boat lies at anchor here rather than holding under way or at a berth: while it
   * holds, before it leaves a first waypoint, or after it reaches a last one
   */
  anchor?: boolean
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

/**
 * The swing through a waypoint the boat passes without stopping: an arc tangent to both
 * legs, sailed at a steady rate of turn from `startMs` to `endMs`. It joins each leg
 * where the boat on the straight legs would be at those times, so the legs' timings stand.
 */
export interface Turn {
  startMs: number
  endMs: number
  /** the waypoint the arc rounds, and metres per degree of longitude there */
  lat: number
  lon: number
  metresPerDegLon: number
  /** arc centre, metres east and north of the waypoint */
  centreE: number
  centreN: number
  radiusM: number
  /** track at the start of the arc, and the change through it: positive to starboard */
  fromDeg: number
  deltaDeg: number
}

export interface Leg {
  from: Waypoint
  to: Waypoint
  distanceNm: number
  speedKn: number
  /** the direction of the straight line the boat sails between the waypoints */
  courseDeg: number
  /** when the boat leaves `from`, after any hold, ms since the epoch */
  departMs: number
  arriveMs: number
  /** the turn onto the next leg at `to`, when the boat passes it without stopping */
  turn?: Turn
}

export interface RoutePosition {
  lat: number
  lon: number
  sogKn: number
  cogDeg: number
  /** the track's rate of turn, degrees a second, positive to starboard */
  rateOfTurnDegS: number
  legIndex: number
  finished: boolean
  /** stopped at a waypoint marked `anchor` */
  anchored: boolean
}

const MS_PER_HOUR = 3600 * 1000
const METRES_PER_DEG_LAT = 111320
const METRES_PER_KNOT = 1852 / 3600
const RADIANS = Math.PI / 180
/** a boat turns on a radius of about this many of its lengths at a normal helm */
const TURN_RADIUS_LENGTHS = 5
/** however small and fast the boat, a route turn is taken no faster than this */
const MAX_TURN_RATE_DEG_S = 5
/** the most of a leg a turn at either end may take, so the two turns never meet */
const TURN_MAX_LEG_SHARE = 0.45
/** a smaller change of course is steered without a turn of its own */
const MIN_TURN_DEG = 0.5

/** the rate of turn a boat of this length takes at this speed, degrees a second */
export function turnRateDegS(lengthM: number, speedKn: number): number {
  const radiusM = TURN_RADIUS_LENGTHS * lengthM
  return Math.min(
    MAX_TURN_RATE_DEG_S,
    (speedKn * METRES_PER_KNOT) / radiusM / RADIANS
  )
}

function wrap180(deg: number): number {
  return ((((deg + 180) % 360) + 360) % 360) - 180
}

/** the direction of the line positionAt interpolates, which is straight in a local plane */
function lineCourseDeg(from: Waypoint, to: Waypoint): number {
  const midLat = ((from.lat + to.lat) / 2) * RADIANS
  const east = (to.lon - from.lon) * Math.cos(midLat)
  const north = to.lat - from.lat
  return (Math.atan2(east, north) / RADIANS + 360) % 360
}

/** the arc at the waypoint between two legs, or undefined where the boat stops there */
function turnAt(
  inbound: Leg,
  outbound: Leg,
  lengthM: number
): Turn | undefined {
  const w = inbound.to
  if (w.holdS || w.anchor) return undefined
  const deltaDeg = wrap180(outbound.courseDeg - inbound.courseDeg)
  if (Math.abs(deltaDeg) < MIN_TURN_DEG) return undefined
  const inMs = inbound.speedKn * METRES_PER_KNOT
  const outMs = outbound.speedKn * METRES_PER_KNOT
  const sweep = Math.abs(deltaDeg) * RADIANS
  // the arc is tangent to both legs the same distance from the waypoint, sailed in at the
  // inbound speed and out at the outbound one; at their mean speed it takes the boat's own
  // rate of turn, shortened on short legs
  const secondsPerMetre = 1 / inMs + 1 / outMs
  const meanKn = 2 / secondsPerMetre / METRES_PER_KNOT
  const rate = turnRateDegS(lengthM, meanKn) * RADIANS
  const shortestLegM = Math.min(inbound.distanceNm, outbound.distanceNm) * 1852
  const tangentM = Math.min(
    sweep / rate / secondsPerMetre,
    TURN_MAX_LEG_SHARE * shortestLegM
  )
  const radiusM = tangentM / Math.tan(sweep / 2)
  const side = Math.sign(deltaDeg)
  const inDeg = inbound.courseDeg * RADIANS
  const normal = inDeg + (side * Math.PI) / 2
  const centreE = -tangentM * Math.sin(inDeg) + radiusM * Math.sin(normal)
  const centreN = -tangentM * Math.cos(inDeg) + radiusM * Math.cos(normal)
  return {
    startMs: inbound.arriveMs - (tangentM / inMs) * 1000,
    endMs: inbound.arriveMs + (tangentM / outMs) * 1000,
    lat: w.lat,
    lon: w.lon,
    metresPerDegLon: METRES_PER_DEG_LAT * Math.cos(w.lat * RADIANS),
    centreE,
    centreN,
    radiusM,
    fromDeg: inbound.courseDeg,
    deltaDeg
  }
}

function positionInTurn(
  turn: Turn,
  timeMs: number,
  legIndex: number
): RoutePosition {
  const durationS = (turn.endMs - turn.startMs) / 1000
  const f = (timeMs - turn.startMs) / (turn.endMs - turn.startMs)
  const trackDeg = turn.fromDeg + turn.deltaDeg * f
  const side = Math.sign(turn.deltaDeg)
  // the boat is abeam of the centre, on the side away from the turn
  const fromCentre = (trackDeg - side * 90) * RADIANS
  const east = turn.centreE + turn.radiusM * Math.sin(fromCentre)
  const north = turn.centreN + turn.radiusM * Math.cos(fromCentre)
  const arcM = turn.radiusM * Math.abs(turn.deltaDeg) * RADIANS
  return {
    lat: turn.lat + north / METRES_PER_DEG_LAT,
    lon: turn.lon + east / turn.metresPerDegLon,
    sogKn: arcM / durationS / METRES_PER_KNOT,
    cogDeg: (trackDeg + 360) % 360,
    rateOfTurnDegS: turn.deltaDeg / durationS,
    legIndex,
    finished: false,
    anchored: false
  }
}

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
      courseDeg: lineCourseDeg(from, to),
      departMs: clock,
      arriveMs: clock + durationMs
    })
    clock += durationMs
  }
  for (let i = 0; i < legs.length - 1; i++) {
    legs[i].turn = turnAt(legs[i], legs[i + 1], route.vessel.lengthM)
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
      rateOfTurnDegS: 0,
      legIndex: 0,
      finished: false,
      anchored: first.from.anchor === true
    }
  }
  for (let i = 0; i < legs.length; i++) {
    const leg = legs[i]
    const next = legs[i + 1]
    const previous = legs[i - 1]
    if (previous?.turn && timeMs < previous.turn.endMs) {
      return positionInTurn(previous.turn, timeMs, i)
    }
    if (leg.turn && timeMs > leg.turn.startMs && timeMs <= leg.arriveMs) {
      return positionInTurn(leg.turn, timeMs, i)
    }
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
        rateOfTurnDegS: 0,
        legIndex: i,
        finished: false,
        anchored: false
      }
    }
    if (next && timeMs < next.departMs) {
      // holding at the next waypoint
      return {
        lat: leg.to.lat,
        lon: leg.to.lon,
        sogKn: 0,
        cogDeg: next.courseDeg,
        rateOfTurnDegS: 0,
        legIndex: i + 1,
        finished: false,
        anchored: leg.to.anchor === true
      }
    }
  }
  const last = legs[legs.length - 1]
  return {
    lat: last.to.lat,
    lon: last.to.lon,
    sogKn: 0,
    cogDeg: last.courseDeg,
    rateOfTurnDegS: 0,
    legIndex: legs.length - 1,
    finished: true,
    anchored: last.to.anchor === true
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
