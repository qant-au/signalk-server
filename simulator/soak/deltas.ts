import { RoutePosition, RouteVessel } from '../routes/route'

/**
 * Signal K deltas for the own boat. Signal K carries SI units: speeds in metres per
 * second and angles in radians.
 */
export const SOURCE_LABEL = 'simulator'
/** `src` tells apart devices of one kind, such as two depth sounders */
export interface DeltaSource {
  label: string
  type: string
  src?: string
}
export const SOURCE: DeltaSource = { label: SOURCE_LABEL, type: 'plugin' }
const METRES_PER_SECOND_PER_KNOT = 1852 / 3600
const RADIANS_PER_DEGREE = Math.PI / 180
/** the AIS ship types an own boat here broadcasts, named as the specification names them */
const AIS_TYPE_NAMES: Record<number, string> = { 36: 'Sailing', 37: 'Pleasure' }

export interface Delta {
  context: string
  updates: {
    source: DeltaSource
    timestamp: string
    values: { path: string; value: unknown }[]
    meta?: {
      path: string
      value: { displayName: string; description: string }
    }[]
  }[]
}

export function knotsToMetresPerSecond(knots: number): number {
  return knots * METRES_PER_SECOND_PER_KNOT
}

export function degreesToRadians(degrees: number): number {
  return degrees * RADIANS_PER_DEGREE
}

/**
 * The boat's position and its motion over the ground. `timestamp` is the wall-clock time
 * the delta is sent, so plugins that check data age treat it as live; the scenario's own
 * time goes in `navigation.datetime`, which is where a GNSS receiver puts the time it
 * reports. The heading is the course unless a systems model sends its own.
 */
export function ownBoatDelta(
  position: RoutePosition,
  scenarioTimeMs: number,
  sentAtMs: number,
  withHeading = true
): Delta {
  const course = degreesToRadians(position.cogDeg)
  const heading = withHeading
    ? [{ path: 'navigation.headingTrue', value: course }]
    : []
  return {
    context: 'vessels.self',
    updates: [
      {
        source: SOURCE,
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
          ...heading,
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
        source: SOURCE,
        timestamp: new Date(sentAtMs).toISOString(),
        values: [
          { path: '', value: { name } },
          { path: 'design.length', value: { overall: vessel.lengthM } },
          {
            path: 'design.aisShipType',
            value: {
              id: vessel.typeCode,
              name: AIS_TYPE_NAMES[vessel.typeCode]
            }
          }
        ]
      }
    ]
  }
}
