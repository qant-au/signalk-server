import { Polar, PolarTable } from './polar'

/**
 * How a sailing boat makes her way on each leg, from her polar and her sails: under sail
 * when the polar gives the speed the leg wants or near it, motor-sailing (engine on, sails
 * up) when it gives some of it, and motoring with the sails down when it cannot help or
 * she is close to a stop. Which sails are set follows the true wind: each kind of sail
 * the largest of its entries whose wind range takes the wind, so full sail to a fresh
 * breeze and reefed above it. A change waits until it has been wanted for a while, as a
 * crew would, so a gust does not have the engine started and stopped; she gets under way
 * under power and changes to sail once the wait is over.
 */
export interface SailProfile {
  /** the key under `sails.inventory`, letters and digits */
  id: string
  /** what the crew calls it */
  name: string
  /** main, genoa or jib; a reef is an entry of the main's type with the area it leaves */
  type: string
  areaM2: number
  /** the true wind it is set in, knots */
  minWindKn: number
  maxWindKn: number
}

export type Propulsion = 'sailing' | 'motor-sailing' | 'motoring'

export interface SailPlan {
  /** none while she lies alongside or at anchor */
  propulsion: Propulsion | null
  /** the ids of the sails set */
  sails: string[]
}

export interface SailingInput {
  /** neither alongside nor at anchor */
  underWay: boolean
  /** close to a stop, coming or going: a berth, an anchorage or a hold */
  nearStop: boolean
  twsKn: number
  /** the direction the true wind comes from, degrees */
  twdDeg: number
  /** the speed through the water the leg wants, knots */
  stwKn: number
  /** her course through the water, degrees */
  waterTrackDeg: number
}

export interface SailingSaved {
  plan: SailPlan
  /** a different plan the conditions call for, and since when, seconds of model time */
  wanted: SailPlan | null
  wantedForS: number
}

/** she sails when the polar gives this share of the leg's speed, and motor-sails from the next */
export const SAIL_SHARE = 0.85
export const MOTOR_SAIL_SHARE = 0.5
/** she motors with the sails down within this of a stop: a berth, an anchorage, a hold */
export const NEAR_STOP_M = 300
/** below this through the water she is manoeuvring, under power */
const MIN_SAILING_STW_KN = 1.5
/** a new plan waits this long, wanted all the while, before the crew changes to it */
export const PLAN_HOLD_S = 300

const NONE: SailPlan = { propulsion: null, sails: [] }

const samePlan = (a: SailPlan, b: SailPlan) =>
  a.propulsion === b.propulsion &&
  a.sails.length === b.sails.length &&
  a.sails.every((s, i) => s === b.sails[i])

export class Sailing {
  readonly polar: Polar
  /** each kind of sail's largest entry: the full sail plan */
  readonly fullAreaM2: number
  private s: SailingSaved = { plan: NONE, wanted: null, wantedForS: 0 }

  constructor(
    readonly sails: SailProfile[],
    polar: PolarTable
  ) {
    this.polar = new Polar(polar)
    const largest = new Map<string, number>()
    for (const sail of sails)
      largest.set(sail.type, Math.max(largest.get(sail.type) ?? 0, sail.areaM2))
    this.fullAreaM2 = [...largest.values()].reduce((a, b) => a + b, 0)
  }

  get plan(): SailPlan {
    return this.s.plan
  }

  /** the area of the sails set, square metres */
  get activeAreaM2(): number {
    return this.sails
      .filter((s) => this.s.plan.sails.includes(s.id))
      .reduce((sum, s) => sum + s.areaM2, 0)
  }

  /** the sails set as a share of the full sail plan, for the heel */
  get areaShare(): number {
    return this.fullAreaM2 ? this.activeAreaM2 / this.fullAreaM2 : 0
  }

  /** the sails for a true wind: of each kind, the largest entry whose range takes it */
  sailsFor(twsKn: number): string[] {
    const chosen = new Map<string, SailProfile>()
    for (const sail of this.sails) {
      if (twsKn < sail.minWindKn || twsKn > sail.maxWindKn) continue
      const had = chosen.get(sail.type)
      if (!had || sail.areaM2 > had.areaM2) chosen.set(sail.type, sail)
    }
    return this.sails.filter((s) => chosen.get(s.type) === s).map((s) => s.id)
  }

  /** what the conditions call for now, before the crew's wait */
  wanted(input: SailingInput): SailPlan {
    if (!input.underWay) return NONE
    const motoring: SailPlan = { propulsion: 'motoring', sails: [] }
    if (input.nearStop || input.stwKn < MIN_SAILING_STW_KN) return motoring
    const sails = this.sailsFor(input.twsKn)
    if (!sails.length) return motoring
    const twa = input.twdDeg - input.waterTrackDeg
    const share = this.polar.speedKn(input.twsKn, twa) / input.stwKn
    if (share >= SAIL_SHARE) return { propulsion: 'sailing', sails }
    if (share >= MOTOR_SAIL_SHARE) return { propulsion: 'motor-sailing', sails }
    return motoring
  }

  step(dt: number, input: SailingInput): void {
    const wanted = this.wanted(input)
    // she gets under way, from a berth or her anchor, under power
    if (this.s.plan.propulsion === null && wanted.propulsion !== null)
      this.s.plan = { propulsion: 'motoring', sails: [] }
    const plan = this.s.plan
    if (samePlan(wanted, plan)) {
      this.s.wanted = null
      this.s.wantedForS = 0
      return
    }
    // stopping, and handing the sails coming in to a stop, are done at once
    const atOnce =
      wanted.propulsion === null ||
      (input.nearStop && wanted.propulsion === 'motoring')
    if (!this.s.wanted || !samePlan(this.s.wanted, wanted)) {
      this.s.wanted = wanted
      this.s.wantedForS = 0
    }
    this.s.wantedForS += dt
    if (atOnce || this.s.wantedForS >= PLAN_HOLD_S) {
      this.s.plan = wanted
      this.s.wanted = null
      this.s.wantedForS = 0
    }
  }

  save(): SailingSaved {
    return structuredClone(this.s)
  }

  /** puts a saved plan back; `check` refuses one that does not fit */
  restore(s: SailingSaved, check: (ok: boolean, what: string) => void): void {
    const ids = new Set(this.sails.map((x) => x.id))
    const fits = (p: SailPlan | null | undefined) =>
      typeof p === 'object' &&
      p !== null &&
      [null, 'sailing', 'motor-sailing', 'motoring'].includes(p.propulsion) &&
      Array.isArray(p.sails) &&
      p.sails.every((x) => ids.has(x))
    check(typeof s === 'object' && s !== null, 'sailing')
    check(fits(s.plan), 'sailing plan')
    check(s.wanted === null || fits(s.wanted), 'sailing wanted plan')
    check(Number.isFinite(s.wantedForS), 'sailing wait')
    this.s = structuredClone(s)
  }
}
