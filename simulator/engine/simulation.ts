import {
  RoutePosition,
  berthApproachM,
  offTrack,
  positionAt
} from '../routes/route'
import { ScenarioClock } from '../soak/clock'
import {
  Delta,
  IdentityField,
  SOURCE,
  identityDelta,
  ownBoatDelta,
  vesselIdentity
} from '../soak/deltas'
import { depthDelta, targetDelta } from './deltas'
import { Scenario } from './scenario'
import { SystemsModel, SystemsState } from '../systems/model'
import { Faults, FaultsState } from '../faults/faults'

/**
 * Runs a scenario: each tick works out the scenario time from the clock, moves the own
 * boat along its route, reports the depth under it, and passes on the AIS reports the boat
 * would have heard since the last tick. When the route names a vessel profile, the
 * boat's systems run alongside, and its depth sounders take over reporting the depth.
 *
 * With systems, everything the boat sends is the state at the systems model's latest
 * step, position and scenario time included, so a delta carries the same values for the
 * same scenario time at any multiplier: a faster clock only sends fewer of them.
 */
export interface SimulationOptions {
  timeMultiplier: number
  showTraffic: boolean
  /** scenario time to start from, ms since the epoch */
  scenarioStartMs: number
  /** seed for the systems model: the same seed repeats a run */
  seed: number
  /** the boat's systems as a previous run saved them; throws StaleStateError if they do not fit */
  systemsState?: SystemsState
  /**
   * Called with a target's context when the receiver loses it, so whatever holds the
   * targets can drop it, as the plugin drops it from the server
   */
  forget?: (context: string) => void
  /** identity fields not to send, because the server's own vessel settings give them */
  identityWithheld?: readonly string[]
  /** faults the seed throws on its own, per day of scenario time; none when 0 or unset */
  faultsPerDay?: number
  /** the faults as a previous run saved them, carried on with the systems */
  faultsState?: FaultsState
}

/** an AIS target as last heard, for the plugin's page */
export interface TargetSeen {
  context: string
  mmsi?: string
  name?: string
  lat: number
  lon: number
  sogKn: number
  cogDeg?: number
}

/** electrical, tanks and the spaces inside are sent every this many ticks */
const SLOW_EVERY_TICKS = 5

/** how long before leaving a stop the crew swings the boat onto her course */
const SWING_BEFORE_LEAVING_MS = 5 * 60000

export interface TickResult {
  scenarioMs: number
  position: RoutePosition
  depthM?: number
  heard: number
  finished: boolean
}

export class Simulation {
  private clock: ScenarioClock
  private paused = false
  private lastScenarioMs: number
  /** the clock's scenario time at the last `advance` */
  private pendingMs: number
  private readonly heardContexts = new Set<string>()
  readonly systems?: SystemsModel
  readonly faults?: Faults
  /** the targets heard, as last heard */
  readonly targets = new Map<string, TargetSeen>()
  /** what the latest send sent */
  last?: TickResult
  /** the next send carries every raised notification, as after a start */
  private notifyAll = true
  /** the identity fields this run sent, all but those withheld */
  readonly identitySent: IdentityField[]
  private ticks = 0

  constructor(
    readonly scenario: Scenario,
    readonly options: SimulationOptions,
    private readonly emit: (delta: Delta) => void,
    wallStartMs: number
  ) {
    this.clock = new ScenarioClock(
      options.scenarioStartMs,
      wallStartMs,
      options.timeMultiplier
    )
    this.lastScenarioMs = options.scenarioStartMs
    this.pendingMs = options.scenarioStartMs
    if (scenario.profile) {
      const depth = scenario.depth
      this.faults = new Faults(scenario.profile, {
        seed: options.seed,
        perDay: options.faultsPerDay ?? 0,
        startMs: options.scenarioStartMs,
        state: options.systemsState ? options.faultsState : undefined
      })
      this.systems = new SystemsModel(scenario.profile, {
        faults: this.faults,
        seed: options.seed,
        startMs: options.scenarioStartMs,
        depthAt: depth ? (lat, lon) => depth.depth(lat, lon) : undefined,
        variationAt: scenario.variation
          ? (lat, lon) => scenario.variation!.at(lat, lon)
          : undefined,
        state: options.systemsState
      })
    }
    const identity = identityDelta(
      vesselIdentity(scenario.route.vessel, scenario.profile),
      wallStartMs,
      new Set(options.identityWithheld ?? [])
    )
    this.identitySent = identity.sent
    this.emit(identity.delta)
    if (this.systems) this.emit(this.systems.metaDelta(wallStartMs))
  }

  /** forgets every target still heard, as a receiver switched off does */
  forgetAll(): void {
    for (const context of this.heardContexts) this.options.forget?.(context)
    this.heardContexts.clear()
    this.targets.clear()
  }

  /** the scenario time the clock has reached, or a jump has set */
  get scenarioMs(): number {
    return this.pendingMs
  }

  get timeMultiplier(): number {
    return this.clock.rate
  }

  get isPaused(): boolean {
    return this.paused
  }

  /**
   * Pauses or resumes the clock, or changes its multiplier, from the scenario time it has
   * reached. A paused run keeps sending the boat as it is, as a boat stopped in time.
   */
  retime(wallMs: number, change: { paused?: boolean; rate?: number }): void {
    const at = this.paused ? this.pendingMs : this.clock.scenarioTime(wallMs)
    if (change.paused !== undefined) this.paused = change.paused
    this.clock = new ScenarioClock(at, wallMs, change.rate ?? this.clock.rate)
  }

  /**
   * Moves the run forward to a later scenario time: the systems run through every step
   * to it, as they would have, and the receiver hears the traffic afresh from there. A
   * jump back needs systems started fresh, which only a new Simulation gives.
   */
  jump(wallMs: number, scenarioMs: number): void {
    if (scenarioMs < this.pendingMs) {
      throw new RangeError(
        'a run only jumps forward; start a new one to go back'
      )
    }
    this.clock = new ScenarioClock(scenarioMs, wallMs, this.clock.rate)
    this.pendingMs = scenarioMs
    this.forgetAll()
    this.scenario.traffic?.restart()
    this.lastScenarioMs = scenarioMs
  }

  /** targets currently heard (not yet lost) */
  get trafficCount(): number {
    return this.heardContexts.size
  }

  /** a tick: the model moved on to the clock's time, then everything sent */
  tick(wallMs: number): TickResult {
    this.advance(wallMs)
    return this.send(wallMs)
  }

  /**
   * The first half of a tick: moves the model on to the clock's time, and gives the
   * scenario time the next send will carry, so a caller can act on it before anything
   * goes out (the plugin sets the course for it).
   */
  advance(wallMs: number): number {
    const scenarioMs = this.paused
      ? this.pendingMs
      : this.clock.scenarioTime(wallMs)
    this.pendingMs = scenarioMs
    const legs = this.scenario.legs
    if (this.systems) {
      this.systems.advance(scenarioMs, (ms) => {
        const p = positionAt(legs, ms)
        return {
          lat: p.lat,
          lon: p.lon,
          sogKn: p.sogKn,
          cogDeg: p.cogDeg,
          rateOfTurnDegS: p.rateOfTurnDegS,
          atBerth: !p.anchored && (p.finished || ms < legs[0].departMs),
          anchored: p.anchored,
          nearBerthM: p.sogKn > 0 ? berthApproachM(legs, p) : undefined,
          leavingSoon:
            p.sogKn === 0 &&
            !p.finished &&
            positionAt(legs, ms + SWING_BEFORE_LEAVING_MS).sogKn > 0
        }
      })
    }
    return this.systems ? this.systems.scenarioMs : scenarioMs
  }

  /** The second half of a tick: sends the boat as it was at the time `advance` gave. */
  send(wallMs: number): TickResult {
    const scenarioMs = this.pendingMs
    const legs = this.scenario.legs
    const sentMs = this.systems ? this.systems.scenarioMs : scenarioMs
    const onTrack = positionAt(legs, sentMs)
    const position = this.systems
      ? offTrack(onTrack, this.systems.trackOffsetM)
      : onTrack
    const own = (delta: Delta) =>
      this.emit(this.faults ? this.faults.filter(delta) : delta)
    own(ownBoatDelta(position, sentMs, wallMs, !this.systems))

    let depthM: number | undefined
    if (this.scenario.depth) {
      depthM = this.scenario.depth.depth(position.lat, position.lon)
      if (depthM !== undefined && !this.systems) {
        this.emit(depthDelta(depthM, this.scenario.route.vessel.draftM, wallMs))
      }
    }

    if (this.systems) {
      const slow = this.ticks % SLOW_EVERY_TICKS === 0
      for (const delta of this.systems.deltas(wallMs, slow)) own(delta)
    }
    if (this.faults) {
      for (const delta of this.faults.deltas(wallMs, SOURCE)) this.emit(delta)
      const notes = this.faults.notifications(wallMs, SOURCE, this.notifyAll)
      this.notifyAll = false
      if (notes) this.emit(notes)
    }
    this.ticks++

    let heard = 0
    if (this.options.showTraffic && this.scenario.traffic) {
      const result = this.scenario.traffic.advance(
        this.lastScenarioMs,
        scenarioMs,
        position.lat,
        position.lon
      )
      for (const target of result.heard) {
        this.heardContexts.add(target.context)
        this.targets.set(target.context, {
          context: target.context,
          mmsi: target.mmsi,
          name: target.name,
          lat: target.lat,
          lon: target.lon,
          sogKn: target.sogKn,
          cogDeg: target.cogDeg
        })
        this.emit(targetDelta(target, wallMs))
      }
      for (const context of result.lost) {
        this.heardContexts.delete(context)
        this.targets.delete(context)
        this.options.forget?.(context)
      }
      heard = result.heard.length
    }

    this.lastScenarioMs = scenarioMs
    this.last = {
      scenarioMs,
      position,
      depthM,
      heard,
      finished: position.finished
    }
    return this.last
  }
}
