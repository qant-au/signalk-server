import { sunElevation } from '../systems/sun'
import type { NavigationStateValue } from '../systems/navigation'
import type { VesselProfile } from '../vessels/profile'

/**
 * What a boat does on deck that a display shows and a crew switches: the navigation
 * lights, the anchor windlass and its chain counter, an outboard's trim, the fin
 * stabilisers and the radars. Each follows what the boat is doing and the sun; their
 * draw goes to the house bank, or for the stabilisers to the AC supply, in the books.
 */

/** the value of `navigation.lights`, as the specification enumerates the ones a yacht shows */
export type LightsValue = 'off' | 'fault' | 'anchored' | 'sailing' | 'motoring'
const LIGHTS_VALUES = new Set<unknown>([
  'off',
  'fault',
  'anchored',
  'sailing',
  'motoring'
])

const RADIANS = Math.PI / 180
/** the sun's upper limb on the horizon, refraction included: sunset and sunrise */
const SUNSET_DEG = -0.833
/** navigation lights, watts: a few tens, more on a bigger boat */
const LIGHTS_W = 10
const LIGHTS_W_PER_M = 1.5
/** an anchor windlass's draw heaving in, watts per metre of length; paying out takes less */
const WINDLASS_W_PER_M = 80
const PAY_OUT_SHARE = 0.3
/** fin stabilisers' hydraulic pump, an AC load, kW per metre of length */
const STABILISERS_KW_PER_M = 0.2
/** stabilisers come on above this and go off below the lower figure, so they never chatter */
const STABILISERS_ON_KN = 6
const STABILISERS_OFF_KN = 5
/** the sea's roll left with the stabilisers working */
export const STABILISED_ROLL_SHARE = 1 / 3
/** an outboard tilted right up, and its trim at cruising speed */
const TILTED_UP = 1
const CRUISE_TRIM = 0.2
/** it trims up from this share of the boat's top speed, and is at cruising trim by the next */
const TRIM_FROM_SHARE = 0.4
const TRIM_FULL_SHARE = 0.7
/** the trim motor's pace, its full travel a second */
const TRIM_RATE_PER_S = 0.1

/** the sun is down: from sunset to sunrise, when a vessel shows her lights */
export function isNight(ms: number, lat: number, lon: number): boolean {
  return sunElevation(ms, lat, lon) < SUNSET_DEG * RADIANS
}

export interface DeckInput {
  nowMs: number
  lat: number
  lon: number
  sogKn: number
  /** what she is doing: alongside, at anchor, under sail alone, or under power */
  state: NavigationStateValue
  /** the lights have failed */
  lightsFailed: boolean
  /** the anchor chain at this step: paying out 1, heaving in -1, still 0 */
  chainWinding: number
}

export interface DeckState {
  lights: LightsValue
  windlassWinding: number
  /** each outboard's trim, by engine id */
  trims: Record<string, number>
  stabilisers: boolean
}

export class Deck {
  private lightsValue: LightsValue = 'off'
  private windlassWinding = 0
  private stabilisersOn = false
  private readonly trims = new Map<string, number>()

  constructor(private readonly profile: VesselProfile) {
    for (const e of profile.engines) {
      if (e.drive === 'outboard') this.trims.set(e.id, TILTED_UP)
    }
  }

  step(dt: number, m: DeckInput): void {
    const p = this.profile
    const night = isNight(m.nowMs, m.lat, m.lon)
    // alongside she shows none; at anchor her anchor light; under way, sailing or motoring
    this.lightsValue = m.lightsFailed
      ? 'fault'
      : !night || m.state === 'moored'
        ? 'off'
        : m.state
    this.windlassWinding = p.windlass ? m.chainWinding : 0

    const underWay = m.state === 'sailing' || m.state === 'motoring'
    const fast = this.stabilisersOn
      ? m.sogKn >= STABILISERS_OFF_KN
      : m.sogKn > STABILISERS_ON_KN
    this.stabilisersOn =
      p.stabilisers !== undefined &&
      ((underWay && fast) ||
        (p.stabilisers === 'zeroSpeed' && m.state === 'anchored'))

    // tilted up alongside or at anchor; down to leave and to come in, trimmed up at speed
    const speedShare = m.sogKn / p.maxSpeedKn
    const trimTo = underWay
      ? CRUISE_TRIM *
        Math.min(
          1,
          Math.max(
            0,
            (speedShare - TRIM_FROM_SHARE) / (TRIM_FULL_SHARE - TRIM_FROM_SHARE)
          )
        )
      : TILTED_UP
    for (const [id, trim] of this.trims) {
      const stepMax = TRIM_RATE_PER_S * dt
      this.trims.set(
        id,
        trim + Math.max(-stepMax, Math.min(stepMax, trimTo - trim))
      )
    }
  }

  get lights(): LightsValue {
    return this.lightsValue
  }

  /** the windlass is running, paying out or heaving in */
  get windlassOn(): boolean {
    return this.windlassWinding !== 0
  }

  get stabilisers(): boolean {
    return this.stabilisersOn
  }

  /** the radars transmit under way and stand by alongside and at anchor */
  radarsOn(state: NavigationStateValue): boolean {
    return state === 'sailing' || state === 'motoring'
  }

  /** each outboard's trim, 0 right down to 1 tilted right up */
  get trim(): Record<string, number> {
    return Object.fromEntries(this.trims)
  }

  /** watts the lights draw from the house bank */
  get lightsW(): number {
    return this.lightsValue === 'off' || this.lightsValue === 'fault'
      ? 0
      : LIGHTS_W + LIGHTS_W_PER_M * this.profile.lengthM
  }

  /** watts the windlass draws from the house bank */
  get windlassW(): number {
    const heaving = WINDLASS_W_PER_M * this.profile.lengthM
    return this.windlassWinding < 0
      ? heaving
      : this.windlassWinding > 0
        ? PAY_OUT_SHARE * heaving
        : 0
  }

  /** kW the stabilisers' pump takes from the AC supply */
  get stabilisersKw(): number {
    return this.stabilisersOn ? STABILISERS_KW_PER_M * this.profile.lengthM : 0
  }

  save(): DeckState {
    return {
      lights: this.lightsValue,
      windlassWinding: this.windlassWinding,
      trims: this.trim,
      stabilisers: this.stabilisersOn
    }
  }

  /** puts saved values back; `check` refuses one that does not fit */
  restore(s: DeckState, check: (ok: boolean, what: string) => void): void {
    check(typeof s === 'object' && s !== null, 'deck')
    check(typeof s.stabilisers === 'boolean', 'deck stabilisers')
    check(LIGHTS_VALUES.has(s.lights), 'deck lights')
    check([-1, 0, 1].includes(s.windlassWinding), 'deck windlass')
    for (const id of this.trims.keys()) {
      const trim = s.trims?.[id]
      check(Number.isFinite(trim), `deck trim ${id}`)
      this.trims.set(id, trim)
    }
    this.stabilisersOn = s.stabilisers
    this.lightsValue = s.lights
    this.windlassWinding = s.windlassWinding
  }
}
