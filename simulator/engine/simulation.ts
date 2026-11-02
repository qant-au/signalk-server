import { RoutePosition, positionAt } from '../routes/route'
import { ScenarioClock } from '../soak/clock'
import { Delta, ownBoatDelta, vesselDelta } from '../soak/deltas'
import { depthDelta, targetDelta } from './deltas'
import { Scenario } from './scenario'

/**
 * Runs a scenario: each tick works out the scenario time from the clock, moves the own
 * boat along its route, reports the depth under it, and passes on the AIS reports the boat
 * would have heard since the last tick.
 */
export interface SimulationOptions {
  timeMultiplier: number
  showTraffic: boolean
  /** scenario time to start from, ms since the epoch */
  scenarioStartMs: number
}

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
    const vessel = scenario.route.vessel
    this.emit(vesselDelta(vessel, vessel.description, wallStartMs))
  }

  /** targets currently heard (not yet lost) */
  get trafficCount(): number {
    return this.heardContexts.size
  }

  tick(wallMs: number): TickResult {
    const scenarioMs = this.clock.scenarioTime(wallMs)
    const position = positionAt(this.scenario.legs, scenarioMs)
    this.emit(ownBoatDelta(position, scenarioMs, wallMs))

    let depthM: number | undefined
    if (this.scenario.depth) {
      depthM = this.scenario.depth.depth(position.lat, position.lon)
      if (depthM !== undefined) {
        this.emit(depthDelta(depthM, this.scenario.route.vessel.draftM, wallMs))
      }
    }

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
