import { RoutePosition, RouteVessel } from '../routes/route'

/**
 * Signal K deltas for the own boat. Signal K carries SI units: speeds in metres per
 * second and angles in radians.
 */
export const SOURCE_LABEL = 'simulator'
const METRES_PER_SECOND_PER_KNOT = 1852 / 3600
const RADIANS_PER_DEGREE = Math.PI / 180

export interface Delta {
  context: string
  updates: {
    source: { label: string }
    timestamp: string
    values: { path: string; value: unknown }[]
  }[]
}

export function knotsToMetresPerSecond(knots: number): number {
  return knots * METRES_PER_SECOND_PER_KNOT
}

export function degreesToRadians(degrees: number): number {
  return degrees * RADIANS_PER_DEGREE
}

/**
 * The boat's navigation state. `timestamp` is the wall-clock time the delta is sent, so
 * plugins that check data age treat it as live; the scenario's own time goes in
 * `navigation.datetime`, which is where a GNSS receiver puts the time it reports.
 */
export function ownBoatDelta(
  position: RoutePosition,
  scenarioTimeMs: number,
  sentAtMs: number
): Delta {
  const course = degreesToRadians(position.cogDeg)
  return {
    context: 'vessels.self',
    updates: [
      {
        source: { label: SOURCE_LABEL },
        timestamp: new Date(sentAtMs).toISOString(),
        values: [
          {
            path: 'navigation.position',
            value: { latitude: position.lat, longitude: position.lon }
          },
          {
            path: 'navigation.speedOverGround',
            value: knotsToMetresPerSecond(position.sogKn)
          },
          { path: 'navigation.courseOverGroundTrue', value: course },
          { path: 'navigation.headingTrue', value: course },
          {
            path: 'navigation.datetime',
            value: new Date(scenarioTimeMs).toISOString()
          }
        ]
      }
    ]
  }
}

/** Static details of the own boat, sent once at the start. */
export function vesselDelta(
  vessel: RouteVessel,
  name: string,
  sentAtMs: number
): Delta {
  return {
    context: 'vessels.self',
    updates: [
      {
        source: { label: SOURCE_LABEL },
        timestamp: new Date(sentAtMs).toISOString(),
        values: [
          { path: '', value: { name } },
          { path: 'design.length', value: { overall: vessel.lengthM } },
          { path: 'design.aisShipType', value: { id: vessel.typeCode } }
        ]
      }
    ]
  }
}
