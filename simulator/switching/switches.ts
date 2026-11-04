import type { VesselProfile } from '../vessels/profile'

/**
 * The boat's digital switching: every switch she sends on `electrical.switches.<id>.state`,
 * as a switching system or an NMEA 2000 switch bank reports it, 1 on and 0 off, each one a
 * display can PUT to. The list is fixed by the profile, in the order a switch bank numbers
 * its channels, so `electrical.switches.bank.0.<n>` names the same switch on every run.
 */

/** the channels an NMEA 2000 switch bank instance carries that a display reads here */
export const BANK_CHANNELS = 16
/** the bank instance the converter numbers these switches under */
export const BANK_INSTANCE = 0

/** anchor lights, deck lights and a fresh water pump come with a boat this long */
const ANCHOR_LIGHT_FROM_M = 7
const DECK_LIGHTS_FROM_M = 9

export interface SwitchSpec {
  id: string
  displayName: string
  description: string
}

/** every switch on this boat, in its bank's order */
export function switchList(p: VesselProfile): SwitchSpec[] {
  const list: SwitchSpec[] = [
    {
      id: 'navLights',
      displayName: 'Navigation lights',
      description:
        p.lengthM < ANCHOR_LIGHT_FROM_M
          ? 'navigation lights, the all-round white serving at anchor'
          : 'navigation lights: sidelights, stern light and masthead light'
    }
  ]
  const add = (id: string, displayName: string, description: string) =>
    list.push({ id, displayName, description })
  if (p.lengthM >= ANCHOR_LIGHT_FROM_M)
    add('anchorLight', 'Anchor light', 'all-round white anchor light')
  if (p.lengthM >= DECK_LIGHTS_FROM_M)
    add('deckLights', 'Deck lights', 'deck floodlights')
  if (p.zones.some((z) => z.kind === 'living'))
    add('cabinLights', 'Cabin lights', 'lighting below')
  if (p.tanks.freshWater.length)
    add('freshWaterPump', 'Fresh water pump', 'fresh water pressure pump')
  if (p.zones.some((z) => z.kind === 'fridge'))
    add('fridge', 'Fridges', 'power to the fridges')
  if (p.zones.some((z) => z.kind === 'freezer'))
    add('freezer', 'Freezers', 'power to the freezers')
  if (p.tanks.fuel.some((t) => t.dayTank))
    add(
      'fuelTransferPump',
      'Fuel transfer pump',
      'tops the day tanks up from storage'
    )
  if (p.windlass) add('windlass', 'Windlass', 'anchor windlass')
  if (p.stabilisers)
    add(
      'stabilisers',
      'Stabilisers',
      p.stabilisers === 'zeroSpeed'
        ? 'zero-speed fin stabilisers'
        : 'fin stabilisers'
    )
  for (const r of p.radars)
    add(r.id, r.displayName, 'radar: 1 transmitting, 0 standby')
  add('bilgePump', 'Bilge pump', 'bilge pump: its float switch runs it')
  return list
}

/** a switch's path, by its id */
export const switchPath = (id: string) => `electrical.switches.${id}.state`

/** a switch bank channel's path, numbered from 1 */
export const bankPath = (channel: number) =>
  `electrical.switches.bank.${BANK_INSTANCE}.${channel}.state`

/** the bank channel each switch has, the first sixteen in the profile's order */
export function bankChannels(p: VesselProfile): Map<string, number> {
  return new Map(
    switchList(p)
      .slice(0, BANK_CHANNELS)
      .map((s, i) => [s.id, i + 1])
  )
}

/**
 * The value a display PUTs to a switch: 1 or 0, true or false, "on" or "off", as KIP and
 * the NMEA 2000 switch displays send them. Undefined for anything else.
 */
export function switchValue(value: unknown): boolean | undefined {
  if (value === 1 || value === true) return true
  if (value === 0 || value === false) return false
  if (typeof value === 'string') {
    const v = value.trim().toLowerCase()
    if (v === 'on') return true
    if (v === 'off') return false
  }
  return undefined
}

/** what a PUT to a switch did: done, perhaps with a word on it, or refused and why */
export type SwitchAnswer =
  { ok: true; message?: string } | { ok: false; message: string }

/**
 * A crew's hand on a switch: held at what was put until it is put back, or, where `until`
 * is set, until what the switch follows moves on from it (the lights to the next change of
 * state, a radar transmitting until she comes alongside).
 */
export interface SwitchHold {
  on: boolean
  until?: string
}

/** the holds by switch id, saved with the systems */
export type SwitchHolds = Record<string, SwitchHold>

export class Switchboard {
  private holds = new Map<string, SwitchHold>()

  /** the switch as the crew has it: its hold while that lasts, otherwise what it follows */
  state(id: string, follows: boolean, key?: string): boolean {
    const hold = this.holds.get(id)
    if (!hold) return follows
    if (hold.until !== undefined && hold.until !== key) {
      this.holds.delete(id)
      return follows
    }
    return hold.on
  }

  hold(id: string, on: boolean, until?: string): void {
    this.holds.set(id, until === undefined ? { on } : { on, until })
  }

  release(id: string): void {
    this.holds.delete(id)
  }

  held(id: string): SwitchHold | undefined {
    return this.holds.get(id)
  }

  save(): SwitchHolds {
    return Object.fromEntries([...this.holds].map(([id, h]) => [id, { ...h }]))
  }

  /** puts saved holds back; `check` refuses one that does not fit */
  restore(
    s: SwitchHolds,
    ids: Set<string>,
    check: (ok: boolean, what: string) => void
  ): void {
    check(typeof s === 'object' && s !== null, 'switches')
    this.holds.clear()
    for (const [id, h] of Object.entries(s)) {
      check(
        ids.has(id) &&
          typeof h?.on === 'boolean' &&
          (h.until === undefined || typeof h.until === 'string'),
        `switch ${id}`
      )
      this.hold(id, h.on, h.until)
    }
  }
}
