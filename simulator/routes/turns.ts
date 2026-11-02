import { Leg, positionAt, turnAt } from './route'

/**
 * Keeps the arcs at waypoints in safe water. An arc cuts inside the corner it rounds, by
 * up to its radius times (1 / cos(turn / 2) - 1); the legs either side are already clear
 * of shallow water and land, but the water inside the corner may not be. Each arc is
 * sampled against the depth, and one that crosses unsafe water is tightened, closer to the
 * waypoint, until it stays clear: a tighter turn at a faster rate, as a helmsman takes a
 * corner by a shoal.
 */
export interface TurnCheck {
  /** index of the waypoint the arc rounds */
  waypoint: number
  name?: string
  lat: number
  lon: number
  deltaDeg: number
  radiusM: number
  /** the radius the boat would have taken, where the arc was tightened */
  plannedRadiusM?: number
  /** clear of shallow water and land as sailed */
  clear: boolean
}

/** how closely the arc is sampled, and how finely its size is searched */
const SAMPLE_M = 5
const SEARCH_STEPS = 16
/** an arc is not tightened below this distance from the waypoint */
const MIN_TANGENT_M = 0.5

function arcClear(
  legs: Leg[],
  index: number,
  safe: (lat: number, lon: number) => boolean,
  sampleM: number
): boolean {
  const turn = legs[index].turn
  if (!turn) return true
  const arcM = turn.radiusM * Math.abs(turn.deltaDeg) * (Math.PI / 180)
  const n = Math.max(2, Math.ceil(arcM / sampleM))
  for (let k = 0; k <= n; k++) {
    const t = turn.startMs + ((turn.endMs - turn.startMs) * k) / n
    const p = positionAt(legs, t)
    if (!safe(p.lat, p.lon)) return false
  }
  return true
}

function tangentM(legs: Leg[], index: number): number {
  const turn = legs[index].turn!
  return turn.radiusM * Math.tan((Math.abs(turn.deltaDeg) * Math.PI) / 360)
}

/**
 * Checks every arc and tightens the ones that cut a corner, in place. `safe` is the
 * depth check the route was adjusted with; `sampleM` is how far apart it is read.
 */
export function clearTurns(
  legs: Leg[],
  lengthM: number,
  safe: (lat: number, lon: number) => boolean,
  sampleM = SAMPLE_M
): TurnCheck[] {
  const checks: TurnCheck[] = []
  for (let i = 0; i < legs.length - 1; i++) {
    const turn = legs[i].turn
    if (!turn) continue
    const check: TurnCheck = {
      waypoint: i + 1,
      name: legs[i].to.name,
      lat: legs[i].to.lat,
      lon: legs[i].to.lon,
      deltaDeg: turn.deltaDeg,
      radiusM: turn.radiusM,
      clear: arcClear(legs, i, safe, sampleM)
    }
    if (!check.clear) {
      // the largest arc that stays clear, between the waypoint and the planned one
      const planned = tangentM(legs, i)
      const sized = (t: number) => {
        legs[i].turn = turnAt(legs[i], legs[i + 1], lengthM, t)
        return arcClear(legs, i, safe, sampleM)
      }
      let low = MIN_TANGENT_M
      let high = planned
      if (sized(low)) {
        for (let k = 0; k < SEARCH_STEPS; k++) {
          const mid = (low + high) / 2
          if (sized(mid)) low = mid
          else high = mid
        }
        sized(low)
        check.clear = true
      } else {
        // the waypoint itself is in unsafe water: a leg the route could not clear
        sized(planned)
      }
      check.plannedRadiusM = turn.radiusM
      check.radiusM = legs[i].turn!.radiusM
    }
    checks.push(check)
  }
  return checks
}
