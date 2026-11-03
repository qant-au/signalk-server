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
  /** the boat's name, sent as the own vessel's name */
  name?: string
  /** its MMSI, nine digits beginning with its flag's MID */
  mmsi?: string
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
  /** the great circle's direction leaving `from`, and arriving at `to` */
  courseDeg: number
  finalCourseDeg: number
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
const METRES_PER_NM = 1852
/** the sphere the leg distances are measured on, as the server's Course API measures them */
const EARTH_RADIUS_M = 6371000
const METRES_PER_DEG_LAT = (EARTH_RADIUS_M * Math.PI) / 180
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

/** the point a share `f` of the way along the great circle from one waypoint to another */
function alongGreatCircle(
  from: Waypoint,
  to: Waypoint,
  f: number
): { lat: number; lon: number } {
  const lat1 = from.lat * RADIANS
  const lon1 = from.lon * RADIANS
  const lat2 = to.lat * RADIANS
  const lon2 = to.lon * RADIANS
  const d =
    2 *
    Math.asin(
      Math.sqrt(
        Math.sin((lat2 - lat1) / 2) ** 2 +
          Math.cos(lat1) * Math.cos(lat2) * Math.sin((lon2 - lon1) / 2) ** 2
      )
    )
  if (d === 0) return { lat: from.lat, lon: from.lon }
  const a = Math.sin((1 - f) * d) / Math.sin(d)
  const b = Math.sin(f * d) / Math.sin(d)
  const x =
    a * Math.cos(lat1) * Math.cos(lon1) + b * Math.cos(lat2) * Math.cos(lon2)
  const y =
    a * Math.cos(lat1) * Math.sin(lon1) + b * Math.cos(lat2) * Math.sin(lon2)
  const z = a * Math.sin(lat1) + b * Math.sin(lat2)
  return {
    lat: Math.atan2(z, Math.hypot(x, y)) / RADIANS,
    lon: Math.atan2(y, x) / RADIANS
  }
}

/**
 * The arc at the waypoint between two legs, or undefined where the boat stops there.
 * `tangentLimitM` keeps the arc within that distance of the waypoint, where the water
 * further out is too shallow for it (see turns.ts).
 */
export function turnAt(
  inbound: Leg,
  outbound: Leg,
  lengthM: number,
  tangentLimitM = Infinity
): Turn | undefined {
  const w = inbound.to
  if (w.holdS || w.anchor) return undefined
  const deltaDeg = wrap180(outbound.courseDeg - inbound.finalCourseDeg)
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
    TURN_MAX_LEG_SHARE * shortestLegM,
    tangentLimitM
  )
  const radiusM = tangentM / Math.tan(sweep / 2)
  const side = Math.sign(deltaDeg)
  const inDeg = inbound.finalCourseDeg * RADIANS
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
    fromDeg: inbound.finalCourseDeg,
    deltaDeg
  }
}

/**
 * Halfway round the arc, where the boat comes abeam of the waypoint. The arc turns at a
 * steady rate, so this is halfway through its time; it falls at the straight legs'
 * arrival time only when both legs have the same speed.
 */
export function turnMiddleMs(turn: Turn): number {
  return (turn.startMs + turn.endMs) / 2
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
      courseDeg: initialCourseDeg(from.lat, from.lon, to.lat, to.lon),
      finalCourseDeg:
        (initialCourseDeg(to.lat, to.lon, from.lat, from.lon) + 180) % 360,
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
 * Where the boat is at a moment. Along a leg the boat sails the great circle between the
 * waypoints, the line the Course API measures cross track error from, its course turning
 * with the great circle's bearing.
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
    const turn = leg.turn
    if (turn && timeMs > turn.startMs && timeMs < turn.endMs) {
      // on the next leg from the middle of the arc, abeam of the waypoint
      const onNext = timeMs >= turnMiddleMs(turn)
      return positionInTurn(turn, timeMs, onNext ? i + 1 : i)
    }
    if (timeMs <= leg.arriveMs) {
      const f =
        leg.arriveMs > leg.departMs
          ? (timeMs - leg.departMs) / (leg.arriveMs - leg.departMs)
          : 1
      const at = alongGreatCircle(leg.from, leg.to, f)
      return {
        lat: at.lat,
        lon: at.lon,
        sogKn: leg.speedKn,
        cogDeg:
          f < 1
            ? initialCourseDeg(at.lat, at.lon, leg.to.lat, leg.to.lon)
            : leg.finalCourseDeg,
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
    cogDeg: last.finalCourseDeg,
    rateOfTurnDegS: 0,
    legIndex: legs.length - 1,
    finished: true,
    anchored: last.to.anchor === true
  }
}

/**
 * The route point the boat is heading for at a moment, as the Course API counts them
 * (the index of the waypoint in the route): the end of the leg it is on. At the start it
 * is already on its first leg. A waypoint the boat holds at under way stays the next point
 * while she holds there, and is passed when she leaves; an anchorage is reached when she
 * anchors, and the point after it is the next point through the stay, held until she
 * weighs, so her swing about the anchor never crosses the point she is making for. One she
 * turns through is passed at the middle of the arc, when the boat comes abeam of it.
 * Undefined once the boat has arrived.
 */
export function nextPointIndex(
  legs: Leg[],
  timeMs: number
): number | undefined {
  if (timeMs < legs[0].departMs) return 1
  for (let i = 0; i < legs.length; i++) {
    const next = legs[i + 1]
    const turn = legs[i].turn
    if (turn && timeMs > turn.startMs && timeMs < turn.endMs) {
      return timeMs < turnMiddleMs(turn) ? i + 1 : i + 2
    }
    if (timeMs < legs[i].arriveMs) return i + 1
    if (next && timeMs < next.departMs) return legs[i].to.anchor ? i + 2 : i + 1
    if (timeMs === legs[i].arriveMs) return i + 1
  }
  return undefined
}

/**
 * Metres from the berth the boat is leaving, on the first leg, or coming to, on the last;
 * undefined elsewhere, and at an end that is an anchorage. A berthing manoeuvre belongs to
 * its own end of the passage: a boat that passes the spot where it will berth later, on its
 * way out, is not coming alongside.
 */
export function berthApproachM(
  legs: Leg[],
  p: RoutePosition
): number | undefined {
  const metres = (w: Waypoint) =>
    distanceNm(p.lat, p.lon, w.lat, w.lon) * METRES_PER_NM
  const first = legs[0].from
  const last = legs[legs.length - 1].to
  const distances: number[] = []
  if (p.legIndex === 0 && !first.anchor) distances.push(metres(first))
  if (p.legIndex === legs.length - 1 && !last.anchor)
    distances.push(metres(last))
  return distances.length ? Math.min(...distances) : undefined
}

/** a position moved `metres` across its course, to starboard positive */
export function offTrack(p: RoutePosition, metres: number): RoutePosition {
  if (!metres) return p
  const across = (p.cogDeg + 90) * RADIANS
  return {
    ...p,
    lat: p.lat + (metres * Math.cos(across)) / METRES_PER_DEG_LAT,
    lon:
      p.lon +
      (metres * Math.sin(across)) /
        (METRES_PER_DEG_LAT * Math.cos(p.lat * RADIANS))
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
      name: route.vessel.name,
      mmsi: route.vessel.mmsi,
      lengthM: profile.lengthM,
      draftM: profile.draftM,
      typeCode: profile.typeCode,
      profile: id
    }
  }
  return route
}
