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

/** the specification's ship type names, as the server's own AIS parsers name them */
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { getAISShipTypeName } = require('@signalk/signalk-schema') as {
  getAISShipTypeName(id: number): string | undefined
}

/**
 * AIS navigational status (ITU-R M.1371) to the specification's `navigation.state`
 * values. 0 to 8 are the ones the server's own AIS parser gives too; for 9 to 15 it gives
 * names outside the specification's list, so these use the specification's own.
 */
export const NAV_STATES: readonly string[] = [
  'motoring',
  'anchored',
  'not under command',
  'restricted manouverability',
  'constrained by draft',
  'moored',
  'aground',
  'fishing',
  'sailing',
  'Reserved for future amendment of Navigational Status for HSC',
  'Reserved for future amendment of Navigational Status for WIG',
  'Reserved for future use-11',
  'Reserved for future use-12',
  'Reserved for future use-13',
  'Reserved for future use-14',
  'not defined (example)'
]

const RADIANS_PER_DEG_MIN = Math.PI / 180 / 60

/**
 * One AIS target as a receiver would put it on the server, in the shapes the server's own
 * AIS parser gives: with every report its position, speed and course over ground, heading,
 * rate of turn and navigational state where the source has them, and its AIS class, which
 * every message carries by its type; and when static data is due, its name, MMSI, call
 * sign, IMO number, ship type, length, beam, draught, destination and ETA, where the
 * source has them. What the source lacks is left out, never made up.
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
  const put = (path: string, value: unknown) => {
    if (value !== undefined) values.push({ path, value })
  }
  if (target.cogDeg !== undefined)
    put('navigation.courseOverGroundTrue', degreesToRadians(target.cogDeg))
  if (target.headingDeg !== undefined)
    put('navigation.headingTrue', degreesToRadians(target.headingDeg))
  if (target.rotDegMin !== undefined)
    put('navigation.rateOfTurn', target.rotDegMin * RADIANS_PER_DEG_MIN)
  if (target.navStatus !== undefined)
    put('navigation.state', NAV_STATES[target.navStatus])
  put('sensors.ais.class', target.station.aisClass)
  if (target.withStatic) {
    const v = target.voyage
    const d = target.description
    const identity: Record<string, unknown> = {}
    if (target.name) identity.name = target.name
    if (target.mmsi) identity.mmsi = target.mmsi
    if (v.callSign) identity.communication = { callsignVhf: v.callSign }
    if (v.imo) identity.registrations = { imo: `IMO ${v.imo}` }
    if (Object.keys(identity).length) put('', identity)
    if (d.typeCode !== undefined) {
      const name = getAISShipTypeName(d.typeCode)
      put(
        'design.aisShipType',
        name ? { id: d.typeCode, name } : { id: d.typeCode }
      )
    }
    if (d.lengthM) put('design.length', { overall: d.lengthM })
    if (d.beamM) put('design.beam', d.beamM)
    if (d.draughtM) put('design.draft', { current: d.draughtM })
    put('navigation.destination.commonName', v.destination)
    if (v.etaMs !== undefined)
      put('navigation.destination.eta', new Date(v.etaMs).toISOString())
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
