import {
  Delta,
  SOURCE,
  degreesToRadians,
  knotsToMetresPerSecond
} from '../soak/deltas'
import { HeardTarget } from './traffic'

/** Depth under the own boat, from the depth grid at its position. */
export function depthDelta(
  belowSurfaceM: number,
  draftM: number,
  sentAtMs: number
): Delta {
  return {
    context: 'vessels.self',
    updates: [
      {
        source: SOURCE,
        timestamp: new Date(sentAtMs).toISOString(),
        values: [
          { path: 'environment.depth.belowSurface', value: belowSurfaceM },
          { path: 'environment.depth.belowKeel', value: belowSurfaceM - draftM }
        ]
      }
    ]
  }
}

/**
 * One AIS target as a receiver would put it on the server: position and motion with every
 * report, and its name, MMSI, dimensions, type and AIS class when static data is due.
 */
export function targetDelta(target: HeardTarget, sentAtMs: number): Delta {
  const values: { path: string; value: unknown }[] = [
    {
      path: 'navigation.position',
      value: { latitude: target.lat, longitude: target.lon }
    },
    {
      path: 'navigation.speedOverGround',
      value: knotsToMetresPerSecond(target.sogKn)
    }
  ]
  if (target.cogDeg !== undefined) {
    values.push({
      path: 'navigation.courseOverGroundTrue',
      value: degreesToRadians(target.cogDeg)
    })
  }
  if (target.headingDeg !== undefined) {
    values.push({
      path: 'navigation.headingTrue',
      value: degreesToRadians(target.headingDeg)
    })
  }
  if (target.withStatic) {
    const identity: Record<string, string> = {}
    if (target.name) identity.name = target.name
    if (target.mmsi) identity.mmsi = target.mmsi
    if (Object.keys(identity).length) values.push({ path: '', value: identity })
    values.push({ path: 'sensors.ais.class', value: target.station.aisClass })
    if (target.description.lengthM) {
      values.push({
        path: 'design.length',
        value: { overall: target.description.lengthM }
      })
    }
    if (target.description.typeCode !== undefined) {
      values.push({
        path: 'design.aisShipType',
        value: { id: target.description.typeCode }
      })
    }
  }
  return {
    context: target.context,
    updates: [
      {
        source: SOURCE,
        timestamp: new Date(sentAtMs).toISOString(),
        values
      }
    ]
  }
}
