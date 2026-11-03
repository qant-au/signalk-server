import { RoutePosition, RouteVessel } from '../routes/route'
import { VesselProfile } from '../vessels/profile'

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
      value: {
        displayName?: string
        description?: string
        zones?: {
          lower?: number
          upper?: number
          state: string
          message: string
        }[]
        alertMethod?: string[]
        warnMethod?: string[]
        alarmMethod?: string[]
        emergencyMethod?: string[]
        zonesNotifiedBy?: string
      }
    }[]
  }[]
}

/**
 * The delta as the Signal K schema can check it: without `zonesNotifiedBy` in the
 * metadata, which this server reads (src/zones.ts) and the specification does not have,
 * and without the null that clears the anchor's values once it is weighed. The anchor
 * alarm plugin clears them so, and displays read it so, but the schema has no null for a
 * position.
 */
export function forSchema(delta: Delta): Delta {
  return {
    ...delta,
    updates: delta.updates.map((u) => {
      const values = u.values.filter(
        (v) => !(v.value === null && v.path.startsWith('navigation.anchor.'))
      )
      const meta = u.meta?.map((m) => {
        // eslint-disable-next-line @typescript-eslint/no-unused-vars
        const { zonesNotifiedBy, ...value } = m.value
        return { ...m, value }
      })
      return { ...u, values, ...(meta ? { meta } : {}) }
    })
  }
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

/**
 * Who the own boat is and its dimensions, from its route and its profile, for the paths
 * a chart plotter or an AIS plugin sizes and names a boat by.
 */
export interface VesselIdentity {
  name: string
  mmsi?: string
  lengthM: number
  beamM?: number
  draftM: number
  maxDraftM?: number
  airHeightM?: number
  displacementT?: number
  typeCode: number
  aisAntenna?: { fromBowM: number; fromCenterM: number }
  aisClass?: 'A' | 'B'
}

/** what the identity delta can carry, each a field an owner's own settings may already give */
export const IDENTITY_FIELDS = [
  'name',
  'mmsi',
  'design.length',
  'design.beam',
  'design.draft',
  'design.airHeight',
  'design.displacement',
  'design.aisShipType',
  'sensors.ais.fromBow',
  'sensors.ais.fromCenter',
  'sensors.ais.class'
] as const
export type IdentityField = (typeof IDENTITY_FIELDS)[number]

/**
 * The fields the server keeps for its own vessel settings: it drops them from any delta
 * not sourced `defaults` (src/staticDataFilter.ts), so a plugin cannot send them as itself.
 */
export const SERVER_KEPT_FIELDS: readonly IdentityField[] = [
  'name',
  'mmsi',
  'design.length',
  'design.beam',
  'design.draft',
  'design.aisShipType'
]

/** each identity field's value, as a delta carries it; a field with no value is absent */
export function identityValues(
  identity: VesselIdentity
): Map<IdentityField, unknown> {
  const id = identity
  const all: [IdentityField, unknown][] = [
    ['name', id.name],
    ['mmsi', id.mmsi],
    ['design.length', { overall: id.lengthM }],
    ['design.beam', id.beamM],
    [
      'design.draft',
      id.maxDraftM !== undefined
        ? { current: id.draftM, maximum: id.maxDraftM }
        : { current: id.draftM }
    ],
    ['design.airHeight', id.airHeightM],
    [
      'design.displacement',
      id.displacementT !== undefined
        ? id.displacementT * KG_PER_TONNE
        : undefined
    ],
    [
      'design.aisShipType',
      { id: id.typeCode, name: AIS_TYPE_NAMES[id.typeCode] }
    ],
    ['sensors.ais.fromBow', id.aisAntenna?.fromBowM],
    ['sensors.ais.fromCenter', id.aisAntenna?.fromCenterM],
    ['sensors.ais.class', id.aisClass]
  ]
  return new Map(all.filter(([, v]) => v !== undefined))
}

/** a field and its value as a delta's path and value: name and MMSI sit at the vessel's root */
export function identityPathValue(
  field: IdentityField,
  value: unknown
): { path: string; value: unknown } {
  return field === 'name' || field === 'mmsi'
    ? { path: '', value: { [field]: value } }
    : { path: field, value }
}

const IDENTITY_META: Partial<Record<IdentityField, [string, string]>> = {
  'design.length': ['Length', 'length overall, m'],
  'design.beam': ['Beam', 'beam, m'],
  'design.draft': [
    'Draft',
    'draft as she floats, and the deepest where the profile gives it, m'
  ],
  'design.airHeight': ['Air height', 'waterline to the highest point, m'],
  'design.displacement': ['Displacement', 'light displacement, kg'],
  'design.aisShipType': [
    'AIS ship type',
    'the ship type the own AIS transmits'
  ],
  'sensors.ais.fromBow': [
    'AIS antenna from bow',
    'AIS antenna aft of the bow, m'
  ],
  'sensors.ais.fromCenter': [
    'AIS antenna from centreline',
    'AIS antenna to starboard of the centreline, m'
  ],
  'sensors.ais.class': ['AIS class', 'the class of the own AIS transponder']
}

const KG_PER_TONNE = 1000

export function vesselIdentity(
  vessel: RouteVessel,
  profile?: VesselProfile
): VesselIdentity {
  return {
    name: vessel.name ?? vessel.description,
    mmsi: vessel.mmsi,
    lengthM: vessel.lengthM,
    draftM: vessel.draftM,
    typeCode: vessel.typeCode,
    beamM: profile?.beamM,
    maxDraftM: profile?.maxDraftM,
    airHeightM: profile?.airHeightM,
    displacementT: profile?.displacementT,
    aisAntenna: profile?.aisAntenna,
    aisClass: profile?.aisClass
  }
}

/**
 * The own boat's identity and dimensions as one delta, leaving out the fields in
 * `withheld` (the ones the server's own vessel settings already give), with metadata
 * saying what each is. Gives the fields it carries.
 */
export function identityDelta(
  identity: VesselIdentity,
  sentAtMs: number,
  withheld: ReadonlySet<string> = new Set()
): { delta: Delta; sent: IdentityField[] } {
  const values: { path: string; value: unknown }[] = []
  const meta: NonNullable<Delta['updates'][number]['meta']> = []
  const sent: IdentityField[] = []
  for (const [field, value] of identityValues(identity)) {
    if (withheld.has(field)) continue
    sent.push(field)
    values.push(identityPathValue(field, value))
    const named = IDENTITY_META[field]
    if (named)
      meta.push({
        path: field,
        value: { displayName: named[0], description: named[1] }
      })
  }
  const delta: Delta = {
    context: 'vessels.self',
    updates: [
      {
        source: SOURCE,
        timestamp: new Date(sentAtMs).toISOString(),
        values,
        ...(meta.length ? { meta } : {})
      }
    ]
  }
  return { delta, sent }
}
