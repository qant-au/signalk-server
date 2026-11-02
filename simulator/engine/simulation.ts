import { RoutePosition, positionAt } from '../routes/route'
import { ScenarioClock } from '../soak/clock'
import { Delta, ownBoatDelta, vesselDelta } from '../soak/deltas'
import { depthDelta, targetDelta } from './deltas'
import { Scenario } from './scenario'
import { SystemsModel, SystemsState } from '../systems/model'

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
  private readonly clock: ScenarioClock
  private lastScenarioMs: number
  private readonly heardContexts = new Set<string>()
  readonly systems?: SystemsModel
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
    if (scenario.profile) {
      const depth = scenario.depth
      this.systems = new SystemsModel(scenario.profile, {
        seed: options.seed,
        startMs: options.scenarioStartMs,
        depthAt: depth ? (lat, lon) => depth.depth(lat, lon) : undefined,
        variationAt: scenario.variation
          ? (lat, lon) => scenario.variation!.at(lat, lon)
          : undefined,
        state: options.systemsState
      })
    }
    const vessel = scenario.route.vessel
    this.emit(vesselDelta(vessel, vessel.description, wallStartMs))
    if (this.systems) this.emit(this.systems.metaDelta(wallStartMs))
  }

  /** targets currently heard (not yet lost) */
  get trafficCount(): number {
    return this.heardContexts.size
  }

  tick(wallMs: number): TickResult {
    const scenarioMs = this.clock.scenarioTime(wallMs)
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
          leavingSoon:
            p.sogKn === 0 &&
            !p.finished &&
            positionAt(legs, ms + SWING_BEFORE_LEAVING_MS).sogKn > 0
        }
      })
    }
    const sentMs = this.systems ? this.systems.scenarioMs : scenarioMs
    const position = positionAt(legs, sentMs)
    this.emit(ownBoatDelta(position, sentMs, wallMs, !this.systems))

    let depthM: number | undefined
    if (this.scenario.depth) {
      depthM = this.scenario.depth.depth(position.lat, position.lon)
      if (depthM !== undefined && !this.systems) {
        this.emit(depthDelta(depthM, this.scenario.route.vessel.draftM, wallMs))
      }
    }

    if (this.systems) {
      const slow = this.ticks % SLOW_EVERY_TICKS === 0
      for (const delta of this.systems.deltas(wallMs, slow)) this.emit(delta)
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
        this.emit(targetDelta(target, wallMs))
      }
      for (const context of result.lost) this.heardContexts.delete(context)
      heard = result.heard.length
    }

    this.lastScenarioMs = scenarioMs
    return { scenarioMs, position, depthM, heard, finished: position.finished }
  }
}
