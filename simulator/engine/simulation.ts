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
import {
  Autopilot,
  PilotMotion,
  PilotSaved,
  PilotUpdate
} from '../autopilot/pilot'
import { STEP_S } from '../systems/model'
import { SystemsModel, SystemsState } from '../systems/model'
import { Faults, FaultsState } from '../faults/faults'
import { AlarmPanel, AlarmsState } from '../alarms/panel'
import { DEFAULT_SHALLOW_M, alarmBands } from '../alarms/zones'
import {
  Approach,
  COLLISION_NOTIFICATION,
  COLLISION_PATH,
  CollisionLimits,
  CollisionNote,
  CollisionWatch,
  DEFAULT_COLLISION_LIMITS,
  closestApproach,
  deadReckon
} from '../ais/collision'

/**
 * Runs a scenario: each tick works out the scenario time from the clock, moves the own
 * boat along its route, reports the depth under it, and passes on the AIS reports the boat
 * would have heard since the last tick. When the route names a vessel profile, the
 * boat's systems run alongside, and its depth sounders take over reporting the depth.
 *
 * With systems, everything the boat sends is the state at the systems model's latest
 * step, position and scenario time included, so a delta carries the same values for the
 * same scenario time at any multiplier: a faster clock only sends fewer of them. The
 * boat's alarm panel reads what goes out and raises the notifications its zones call for.
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
  /** the sounders' shallow water alarm, metres under the keel */
  shallowM?: number
  /** the alarms as a previous run saved them, carried on with the systems */
  alarmsState?: AlarmsState
  /** the collision alarm's limits */
  collision?: CollisionLimits
  /** the anchor watch's radius, metres; unset or 0, the scope's radius plus a margin */
  anchorWatchRadiusM?: number
  /** the autopilot as a previous run saved it, carried on with the systems */
  pilotState?: PilotSaved
  /** what the autopilot tells the server's Autopilot API */
  autopilotUpdate?: (update: PilotUpdate) => void
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
  /** scenario time of its latest report */
  atMs: number
  navStatus?: number
  /** its closest approach, while it is closing */
  approach?: Approach
}

/** the anchor watch's notification, where the anchor alarm plugin raises it */
export const ANCHOR_NOTIFICATION = 'notifications.navigation.anchor'

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
  readonly alarms?: AlarmPanel
  readonly collisions: CollisionWatch
  /** the boat's autopilot, when her profile has one */
  readonly pilot?: Autopilot
  /** the targets heard, as last heard */
  readonly targets = new Map<string, TargetSeen>()
  /** what the latest send sent */
  last?: TickResult
  /** the next send carries every raised notification, as after a start */
  private notifyAll = true
  /** the identity fields this run sent, all but those withheld */
  readonly identitySent: IdentityField[]
  private ticks = 0
  /** the wall time of the latest send, which a target lost between sends is cleared at */
  private lastWallMs: number

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
    this.lastWallMs = wallStartMs
    this.collisions = new CollisionWatch(
      options.collision ?? DEFAULT_COLLISION_LIMITS
    )
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
        depthAt: depth
          ? (lat, lon, ms) => this.depthAt(lat, lon, ms)
          : undefined,
        weatherAt: scenario.environment
          ? (lat, lon, ms) => scenario.environment!.at(lat, lon, ms)
          : undefined,
        variationAt: scenario.variation
          ? (lat, lon) => scenario.variation!.at(lat, lon)
          : undefined,
        state: options.systemsState,
        anchorWatchRadiusM: options.anchorWatchRadiusM
      })
      if (scenario.profile.autopilot) {
        this.pilot = new Autopilot(
          {
            lengthM: scenario.profile.lengthM,
            sail: scenario.profile.rig === 'sail' && scenario.profile.wind,
            legs: scenario.legs
          },
          options.systemsState ? options.pilotState : undefined
        )
      }
      this.alarms = new AlarmPanel(
        alarmBands(scenario.profile, options.shallowM ?? DEFAULT_SHALLOW_M),
        options.systemsState ? options.alarmsState : undefined
      )
    }
    const identity = identityDelta(
      vesselIdentity(scenario.route.vessel, scenario.profile),
      wallStartMs,
      new Set(options.identityWithheld ?? [])
    )
    this.identitySent = identity.sent
    this.emit(identity.delta)
    if (this.systems) this.emit(this.systems.metaDelta(wallStartMs))
    if (this.alarms) {
      this.emit({
        context: 'vessels.self',
        updates: [
          {
            source: SOURCE,
            timestamp: new Date(wallStartMs).toISOString(),
            values: [],
            meta: this.alarms.meta(SOURCE.label)
          }
        ]
      })
    }
  }

  /**
   * The depth below the surface: the grid's depth below its datum and the sample's water
   * level above that datum, where the sample has one (simulator/weather)
   */
  depthAt(lat: number, lon: number, ms: number): number | undefined {
    const grid = this.scenario.depth?.depth(lat, lon)
    if (grid === undefined) return undefined
    const level =
      this.scenario.environment?.value('waterLevelM', lat, lon, ms) ?? 0
    return Math.max(0, grid + level)
  }

  /**
   * The pilot's target as the specification has it: a heading, true and magnetic, in
   * compass and route modes, and an apparent wind angle in wind mode, agreeing with the
   * target the server's Autopilot API gives
   */
  private pilotTargetValues(at: {
    lat: number
    lon: number
  }): { path: string; value: number }[] {
    const target = this.pilot?.target
    if (target === null || target === undefined) return []
    if (this.pilot!.mode === 'wind') {
      return [
        {
          path: 'steering.autopilot.target.windAngleApparent',
          value: round4(target)
        }
      ]
    }
    const values = [
      { path: 'steering.autopilot.target.headingTrue', value: round4(target) }
    ]
    const variation = this.scenario.variation?.at(at.lat, at.lon)
    if (variation !== undefined) {
      const magnetic = target - (variation * Math.PI) / 180
      values.push({
        path: 'steering.autopilot.target.headingMagnetic',
        value: round4(
          ((magnetic % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI)
        )
      })
    }
    return values
  }

  /** the route's own time at a scenario time: held back while the pilot has her off it */
  routeMs(scenarioMs: number): number {
    return scenarioMs - (this.pilot?.routeOffsetMs ?? 0)
  }

  /** forgets every target still heard, as a receiver switched off does */
  forgetAll(): void {
    for (const context of this.heardContexts) this.lose(context)
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
    // a jump is along the route: she is where the route has her then, the helm steering
    this.pilot?.backOnRoute()
  }

  /** a target the receiver has lost: its collision alarm cleared, then the target dropped */
  private lose(context: string): void {
    const note = this.collisions.lost(context)
    if (note) this.emitCollision(note, this.lastWallMs)
    this.options.forget?.(context)
  }

  private emitCollision(note: CollisionNote, wallMs: number): void {
    this.emit(
      contextDelta(note.context, wallMs, COLLISION_NOTIFICATION, note.value)
    )
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
      const systems = this.systems
      this.systems.advance(scenarioMs, (ms) => {
        // the route at its own time, which the pilot holds back while she is off it
        const m: PilotMotion = this.pilot
          ? this.pilot.step(ms, STEP_S, systems.pilotContext())
          : routeMotion(positionAt(legs, ms))
        const p = m.route
        const routeMs = ms - (this.pilot?.routeOffsetMs ?? 0)
        return {
          lat: m.lat,
          lon: m.lon,
          sogKn: m.sogKn,
          cogDeg: m.cogDeg,
          rateOfTurnDegS: m.rateOfTurnDegS,
          atBerth:
            m.onRoute &&
            !p.anchored &&
            (p.finished || routeMs < legs[0].departMs),
          anchored: m.onRoute && p.anchored,
          nearBerthM:
            m.onRoute && p.sogKn > 0 ? berthApproachM(legs, p) : undefined,
          leavingSoon:
            m.onRoute &&
            p.sogKn === 0 &&
            !p.finished &&
            positionAt(legs, routeMs + SWING_BEFORE_LEAVING_MS).sogKn > 0,
          leavesInS:
            m.onRoute && p.sogKn === 0 && !p.finished
              ? (legs[p.legIndex].departMs - routeMs) / 1000
              : undefined
        }
      })
    }
    return this.systems ? this.systems.scenarioMs : scenarioMs
  }

  /** The second half of a tick: sends the boat as it was at the time `advance` gave. */
  send(wallMs: number): TickResult {
    this.lastWallMs = wallMs
    const scenarioMs = this.pendingMs
    const legs = this.scenario.legs
    const sentMs = this.systems ? this.systems.scenarioMs : scenarioMs
    const onTrack = positionAt(legs, this.routeMs(sentMs))
    // at anchor she lies to her chain, off the waypoint the route stops her at; off the
    // route she is where the pilot, or the helm rejoining, has taken her
    const swung = this.systems?.anchoredPosition ?? this.pilot?.offRoutePosition
    const position = swung
      ? {
          ...onTrack,
          lat: swung.lat,
          lon: swung.lon,
          sogKn: swung.sogKn,
          cogDeg: swung.cogDeg,
          finished: false
        }
      : this.systems
        ? offTrack(onTrack, this.systems.trackOffsetM)
        : onTrack
    const own = (delta: Delta) => {
      const sent = this.faults ? this.faults.filter(delta) : delta
      this.alarms?.record(sent)
      this.emit(sent)
    }
    own(ownBoatDelta(position, sentMs, wallMs, !this.systems))
    if (this.pilot) {
      for (const u of this.pilot.takeUpdates())
        this.options.autopilotUpdate?.(u)
      const target = this.pilotTargetValues(position)
      if (target.length) {
        own({
          context: 'vessels.self',
          updates: [
            {
              source: SOURCE,
              timestamp: new Date(wallMs).toISOString(),
              values: target
            }
          ]
        })
      }
    }

    let depthM: number | undefined
    if (this.scenario.depth) {
      depthM = this.depthAt(position.lat, position.lon, sentMs)
      if (depthM !== undefined && !this.systems) {
        this.emit(depthDelta(depthM, this.scenario.route.vessel.draftM, wallMs))
      }
    }

    if (this.systems) {
      const slow = this.ticks % SLOW_EVERY_TICKS === 0
      for (const delta of this.systems.deltas(wallMs, slow)) own(delta)
    }
    if (this.faults && this.alarms) {
      for (const delta of this.faults.deltas(wallMs, SOURCE)) this.emit(delta)
      const others = this.faults.alarms()
      const anchor = this.systems?.anchorAlarm()
      if (anchor) others.set(ANCHOR_NOTIFICATION, anchor)
      const notes = this.alarms.notifications(
        wallMs,
        SOURCE,
        others,
        this.notifyAll
      )
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
      for (const context of result.lost) {
        this.heardContexts.delete(context)
        this.targets.delete(context)
        this.lose(context)
      }
      const heardNow = new Set<string>()
      for (const target of result.heard) {
        heardNow.add(target.context)
        this.heardContexts.add(target.context)
        this.targets.set(target.context, {
          context: target.context,
          mmsi: target.mmsi,
          name: target.name,
          lat: target.lat,
          lon: target.lon,
          sogKn: target.sogKn,
          cogDeg: target.cogDeg,
          atMs: target.atMs,
          navStatus: target.navStatus
        })
      }
      // every target's closest approach, from where it has got to on its last report
      for (const t of this.targets.values()) {
        t.approach = closestApproach(
          position,
          deadReckon(t, (sentMs - t.atMs) / 1000)
        )
      }
      const { approaches, notes } = this.collisions.update(
        [...this.targets.values()].map((t) => ({
          context: t.context,
          label: t.name ?? `MMSI ${t.mmsi ?? t.context}`,
          sogKn: t.sogKn,
          navStatus: t.navStatus,
          approach: t.approach
        })),
        heardNow
      )
      const approachOf = new Map(approaches.map((a) => [a.context, a.value]))
      for (const target of result.heard) {
        const delta = targetDelta(target, wallMs)
        if (approachOf.has(target.context)) {
          delta.updates[0].values.push({
            path: COLLISION_PATH,
            value: approachValue(approachOf.get(target.context)!)
          })
          approachOf.delete(target.context)
        }
        this.emit(delta)
      }
      for (const [context, value] of approachOf) {
        this.emit(
          contextDelta(context, wallMs, COLLISION_PATH, approachValue(value))
        )
      }
      for (const note of notes) this.emitCollision(note, wallMs)
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

/** a closest approach as the specification gives it, or null for none */
function approachValue(a: Approach | null) {
  return (
    a && { distance: Math.round(a.distanceM), timeTo: Math.round(a.timeToS) }
  )
}

function contextDelta(
  context: string,
  wallMs: number,
  path: string,
  value: unknown
): Delta {
  return {
    context,
    updates: [
      {
        source: SOURCE,
        timestamp: new Date(wallMs).toISOString(),
        values: [{ path, value }]
      }
    ]
  }
}

/** the route's position as a pilot step gives it, for a boat without a pilot */
function routeMotion(p: RoutePosition): PilotMotion {
  return {
    lat: p.lat,
    lon: p.lon,
    sogKn: p.sogKn,
    cogDeg: p.cogDeg,
    rateOfTurnDegS: p.rateOfTurnDegS,
    route: p,
    onRoute: true
  }
}

const round4 = (x: number) => Math.round(x * 10000) / 10000
