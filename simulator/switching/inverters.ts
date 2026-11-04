import type { VesselProfile } from '../vessels/profile'

/**
 * The boat's inverter, where she has one: a hybrid's, which carries her hotel load off the
 * propulsion bank, and a smaller boat's with a generator, which carries the sockets off the
 * house bank while no generator runs. A yacht of 24 m or more runs a generator whenever she
 * is away from the berth, so she has none.
 */
export const INVERTER_ID = 'inverter'
const NO_INVERTER_FROM_M = 24

export type InverterMode = 'idle' | 'inverting' | 'standby' | 'faulted'

export function hasInverter(p: VesselProfile): boolean {
  return (
    p.generators.length > 0 &&
    (p.hybrid !== undefined || p.lengthM < NO_INVERTER_FROM_M)
  )
}

/** the inverters on this boat, by id */
export const inverterIds = (p: VesselProfile): string[] =>
  hasInverter(p) ? [INVERTER_ID] : []
