import type {
  AlarmZone,
  BankProfile,
  TankType,
  VesselProfile,
  ZoneProfile
} from '../vessels/profile'
import { ZONE_STATES } from '../vessels/profile'

/**
 * The alarm bands of every value the boat sends that a panel would watch. Each is sent as
 * the specification's zones in the path's metadata, so a display colours its gauge by
 * them, and the plugin's alarm panel raises `notifications.<path>` from the same zones,
 * so the two always agree. A profile's `alarmZones` replaces the bands for a path where
 * the boat's own thresholds differ; everything else comes from the defaults here, by the
 * kind of thing (a lithium bank's voltages are not a lead-acid bank's) and its size.
 */
export interface AlarmBand {
  /** what the value is, sent with the zones, as the specification's metadata needs */
  description: string
  zones: AlarmZone[]
  /**
   * Once raised, an alarm holds until its value is back past the zone's edge by this
   * much, as a real panel's does, so a value wandering about the edge does not flicker it
   */
  margin: number
  /** the alarm is watched only while this path reads `started`, as an engine's oil pressure is */
  whileStarted?: string
}

const KELVIN = 273.15
const PASCALS_PER_BAR = 100000
const METRES_PER_SECOND_PER_KNOT = 1852 / 3600

/** a sounder's shallow alarm, metres under the keel, and how much deeper it clears */
export const DEFAULT_SHALLOW_M = 1.5
const SHALLOW_MARGIN_M = 0.3

/** an engine panel's coolant warning and alarm, degrees C */
export const COOLANT_WARN_C = 95
export const COOLANT_ALARM_C = 100
const COOLANT_MARGIN_C = 2
/** an engine panel's low oil pressure alarm, while running */
export const OIL_PRESSURE_ALARM_BAR = 1
const OIL_PRESSURE_MARGIN_BAR = 0.3
/** an exhaust gas temperature gauge's warning and alarm: full load runs near 500 degrees C */
const EXHAUST_WARN_C = 550
const EXHAUST_ALARM_C = 600
const EXHAUST_MARGIN_C = 10

/** a battery monitor's voltage alarms, per 12 V of the bank, by chemistry */
const VOLTS: Record<
  'lead' | 'LiFePO4',
  { lowAlarm: number; lowWarn: number; highWarn: number; highAlarm: number }
> = {
  // a resting lead-acid block is near 11.8 V flat; absorption is 14.4 V
  lead: { lowAlarm: 11.0, lowWarn: 11.8, highWarn: 15.0, highAlarm: 15.5 },
  // 2.9 and 3.0 V a cell low, 3.65 and 3.75 V high; absorption is 14.2 V
  LiFePO4: { lowAlarm: 11.6, lowWarn: 12.0, highWarn: 14.6, highAlarm: 15.0 }
}
const VOLTS_MARGIN = 0.2
/** state of charge alarms, by chemistry: lead-acid is not run below half */
const SOC: Record<'lead' | 'LiFePO4', { alarm: number; warn: number }> = {
  lead: { alarm: 0.3, warn: 0.4 },
  LiFePO4: { alarm: 0.1, warn: 0.2 }
}
const SOC_MARGIN = 0.02
/** tank alarms, as shares of the tank: low for what is used, high for what fills */
const TANK_LOW: Partial<Record<TankType, { alarm: number; warn: number }>> = {
  fuel: { alarm: 0.05, warn: 0.12 },
  freshWater: { alarm: 0.1, warn: 0.2 }
}
const TANK_HIGH: Partial<Record<TankType, { warn: number; alarm: number }>> = {
  wasteWater: { warn: 0.8, alarm: 0.95 },
  blackWater: { warn: 0.8, alarm: 0.95 }
}
/** well above a sender's slosh */
const TANK_MARGIN = 0.02
/** true wind warning by length, knots, the alarm this much above it */
const WIND_WARN_KN = { perM: 1, plusKn: 10, least: 20, most: 35 }
const WIND_ALARM_ABOVE_KN = 10
const WIND_MARGIN_KN = 2
/** inside temperature alarms, degrees C: fixed for living spaces and engine rooms, above the setpoint for cold stores */
const INSIDE_C: Record<
  ZoneProfile['kind'],
  { warn: number; alarm: number; overSetpoint?: true }
> = {
  living: { warn: 38, alarm: 45 },
  engineRoom: { warn: 60, alarm: 70 },
  fridge: { warn: 4, alarm: 7, overSetpoint: true },
  freezer: { warn: 6, alarm: 10, overSetpoint: true }
}
const INSIDE_MARGIN_C = 1
/** a living space's humidity warning: damp enough for mould */
const HUMIDITY_WARN = 0.8
const HUMIDITY_MARGIN = 0.03

/** zones for a value that is bad high: a warning from `warn`, an alarm from `alarm` */
function above(
  warn: number,
  alarm: number,
  warnMessage: string,
  alarmMessage: string
): AlarmZone[] {
  return [
    { lower: warn, upper: alarm, state: 'warn', message: warnMessage },
    { lower: alarm, state: 'alarm', message: alarmMessage }
  ]
}

/** zones for a value that is bad low: a warning below `warn`, an alarm below `alarm` */
function below(
  warn: number,
  alarm: number,
  warnMessage: string,
  alarmMessage: string
): AlarmZone[] {
  return [
    { upper: alarm, state: 'alarm', message: alarmMessage },
    { lower: alarm, upper: warn, state: 'warn', message: warnMessage }
  ]
}

const chemistryOf = (b: BankProfile) =>
  b.chemistry === 'LiFePO4' ? 'LiFePO4' : 'lead'

/** the default bands for every watched path this boat sends */
function defaultBands(
  p: VesselProfile,
  shallowM: number
): Map<string, AlarmBand> {
  const bands = new Map<string, AlarmBand>()
  const combustion = [
    ...p.engines.filter((e) => e.type !== 'electric'),
    ...p.generators
  ]
  for (const e of combustion) {
    const base = `propulsion.${e.id}`
    bands.set(`${base}.coolantTemperature`, {
      description: `${e.displayName} coolant temperature`,
      zones: above(
        COOLANT_WARN_C + KELVIN,
        COOLANT_ALARM_C + KELVIN,
        `${e.displayName} coolant temperature high`,
        `${e.displayName} overheating`
      ),
      margin: COOLANT_MARGIN_C
    })
    bands.set(`${base}.oilPressure`, {
      description: `${e.displayName} oil pressure`,
      zones: [
        {
          upper: OIL_PRESSURE_ALARM_BAR * PASCALS_PER_BAR,
          state: 'alarm',
          message: `${e.displayName} oil pressure low`
        }
      ],
      margin: OIL_PRESSURE_MARGIN_BAR * PASCALS_PER_BAR,
      whileStarted: `${base}.state`
    })
  }
  for (const e of p.engines.filter((x) => x.type !== 'electric')) {
    bands.set(`propulsion.${e.id}.exhaustTemperature`, {
      description: `${e.displayName} exhaust temperature`,
      zones: above(
        EXHAUST_WARN_C + KELVIN,
        EXHAUST_ALARM_C + KELVIN,
        `${e.displayName} exhaust temperature high`,
        `${e.displayName} exhaust overheating`
      ),
      margin: EXHAUST_MARGIN_C
    })
  }
  for (const b of p.banks) {
    const base = `electrical.batteries.${b.id}`
    const scale = b.nominalVoltage / 12
    const v = VOLTS[chemistryOf(b)]
    bands.set(`${base}.voltage`, {
      description: `${b.displayName} voltage`,
      zones: [
        ...below(
          v.lowWarn * scale,
          v.lowAlarm * scale,
          `${b.displayName} voltage low`,
          `${b.displayName} voltage very low`
        ),
        ...above(
          v.highWarn * scale,
          v.highAlarm * scale,
          `${b.displayName} voltage high`,
          `${b.displayName} voltage very high`
        )
      ],
      margin: VOLTS_MARGIN * scale
    })
    const soc = SOC[chemistryOf(b)]
    bands.set(`${base}.capacity.stateOfCharge`, {
      description: `${b.displayName} state of charge`,
      zones: below(
        soc.warn,
        soc.alarm,
        `${b.displayName} charge low`,
        `${b.displayName} charge very low`
      ),
      margin: SOC_MARGIN
    })
  }
  for (const [type, tanks] of Object.entries(p.tanks) as [
    TankType,
    VesselProfile['tanks'][TankType]
  ][]) {
    const low = TANK_LOW[type]
    const high = TANK_HIGH[type]
    for (const t of tanks) {
      const zones = low
        ? below(
            low.warn,
            low.alarm,
            `${t.displayName} tank low`,
            `${t.displayName} tank very low`
          )
        : high
          ? above(
              high.warn,
              high.alarm,
              `${t.displayName} tank nearly full`,
              `${t.displayName} tank full`
            )
          : []
      bands.set(`tanks.${type}.${t.id}.currentLevel`, {
        description: `${t.displayName} tank level`,
        zones,
        margin: TANK_MARGIN
      })
    }
  }
  if (p.sounders.length) {
    bands.set('environment.depth.belowKeel', {
      description: 'Depth under the keel',
      zones: [{ upper: shallowM, state: 'alarm', message: 'Shallow water' }],
      margin: SHALLOW_MARGIN_M
    })
  }
  if (p.wind) {
    const warnKn = Math.min(
      WIND_WARN_KN.most,
      Math.max(
        WIND_WARN_KN.least,
        WIND_WARN_KN.perM * p.lengthM + WIND_WARN_KN.plusKn
      )
    )
    bands.set('environment.wind.speedTrue', {
      description: 'True wind speed',
      zones: above(
        Math.round(warnKn) * METRES_PER_SECOND_PER_KNOT,
        Math.round(warnKn + WIND_ALARM_ABOVE_KN) * METRES_PER_SECOND_PER_KNOT,
        'Wind strong',
        'Wind very strong'
      ),
      margin: WIND_MARGIN_KN * METRES_PER_SECOND_PER_KNOT
    })
  }
  for (const z of p.zones) {
    const base = `environment.inside.${z.id}`
    const c = INSIDE_C[z.kind]
    const from = c.overSetpoint ? z.setpointC : 0
    const cold = z.kind === 'fridge' || z.kind === 'freezer'
    bands.set(`${base}.temperature`, {
      description: `${z.displayName} temperature`,
      zones: above(
        from + c.warn + KELVIN,
        from + c.alarm + KELVIN,
        `${z.displayName} ${cold ? 'warm' : 'temperature high'}`,
        `${z.displayName} ${cold ? 'too warm' : 'temperature very high'}`
      ),
      margin: INSIDE_MARGIN_C
    })
    if (z.kind === 'living') {
      bands.set(`${base}.relativeHumidity`, {
        description: `${z.displayName} relative humidity`,
        zones: [
          {
            lower: HUMIDITY_WARN,
            state: 'warn',
            message: `${z.displayName} humidity high`
          }
        ],
        margin: HUMIDITY_MARGIN
      })
    }
  }
  return bands
}

function checkZone(boat: string, path: string, z: AlarmZone): void {
  const where = `${boat}: alarm zone on ${path}`
  if (!ZONE_STATES.includes(z.state))
    throw new Error(
      `${where}: state ${z.state} is not one of ${ZONE_STATES.join(', ')}`
    )
  if (typeof z.message !== 'string')
    throw new Error(`${where}: needs a message`)
  for (const bound of [z.lower, z.upper]) {
    if (bound !== undefined && typeof bound !== 'number')
      throw new Error(`${where}: bounds are numbers`)
  }
  if (z.lower === undefined && z.upper === undefined)
    throw new Error(`${where}: needs a lower or an upper bound`)
  if (z.lower !== undefined && z.upper !== undefined && z.lower >= z.upper)
    throw new Error(`${where}: lower ${z.lower} is not below upper ${z.upper}`)
}

/**
 * Every watched path's band: the defaults, with the profile's own zones in place of them
 * where it gives any. Throws on a profile band for a path the boat has no alarm on, or a
 * malformed zone.
 */
export function alarmBands(
  p: VesselProfile,
  shallowM: number
): Map<string, AlarmBand> {
  const bands = defaultBands(p, shallowM)
  for (const [path, zones] of Object.entries(p.alarmZones ?? {})) {
    const band = bands.get(path)
    if (!band) throw new Error(`${p.id}: no alarm on ${path} to give zones to`)
    if (!Array.isArray(zones))
      throw new Error(`${p.id}: zones on ${path} are a list`)
    for (const z of zones) checkZone(p.id, path, z)
    bands.set(path, { ...band, zones })
  }
  return bands
}
