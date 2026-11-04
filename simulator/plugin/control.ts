import type { IRouter, Request, RequestHandler, Response } from 'express'
import { distanceNm } from '../ais/reception'
import { CollisionLimits } from '../ais/collision'
import { Scenario } from '../engine/scenario'
import { Simulation } from '../engine/simulation'
import { FaultError, Faults } from '../faults/faults'
import { bridgeHoldAt, bridgeWords, nextPointIndex } from '../routes/route'
import { BOW_HEIGHT_PER_LENGTH } from '../systems/anchor'

/**
 * The plugin's REST surface, under /plugins/signalk-simulator: the run (where the boat
 * is, its clock, its systems, the targets in range and the faults on board) and the
 * controls for it, so a tester can script a scenario without the plugin's page. The page
 * uses the same routes.
 *
 *   GET    /run                      the run, as the page shows it
 *   PUT    /run                      { paused, timeMultiplier, time | minutesIntoRoute }
 *   GET    /faults                   the faults available and the faults on board
 *   POST   /faults                   { kind, target } raises one; target defaults to the first
 *   DELETE /faults/:kind/:target     clears one by hand
 *
 * Reading is open to read-only users and the controls to read/write users, where the
 * server's security allows plugins to say so; otherwise the server keeps them admin-only.
 */

/** the most targets the run lists, nearest first */
const MAX_TARGETS = 100
/** the highest time multiplier the REST surface accepts */
const MAX_TIME_MULTIPLIER = 3600

export class ControlError extends Error {
  constructor(
    readonly status: number,
    message: string
  ) {
    super(message)
  }
}

export interface RunChange {
  paused?: boolean
  timeMultiplier?: number
  /** a scenario time to jump to */
  scenarioMs?: number
}

/** what the plugin hands its REST surface */
export interface Control {
  /** the run in progress; throws ControlError(503) when there is none */
  run(): {
    options: { sample: string; showTraffic: boolean; seed: number }
    scenario: Scenario
    simulation: Simulation
  }
  setRun(change: RunChange): Promise<void>
  faults(): Faults
}

/** the router the server hands a plugin, with its access levels where it has them */
type PluginRouter = IRouter & {
  access?(level: 'readonly' | 'readwrite'): {
    get(path: string, ...handlers: RequestHandler[]): unknown
    put(path: string, ...handlers: RequestHandler[]): unknown
    post(path: string, ...handlers: RequestHandler[]): unknown
    delete(path: string, ...handlers: RequestHandler[]): unknown
  }
}

export function controlRoutes(router: PluginRouter, control: Control): void {
  const reading = router.access ? router.access('readonly') : router
  const writing = router.access ? router.access('readwrite') : router
  const handle =
    (fn: (req: Request) => unknown | Promise<unknown>, status = 200) =>
    async (req: Request, res: Response) => {
      try {
        res.status(status).json(await fn(req))
      } catch (error) {
        const code =
          error instanceof ControlError
            ? error.status
            : error instanceof FaultError
              ? 400
              : 500
        res.status(code).json({ error: (error as Error).message })
      }
    }

  reading.get(
    '/run',
    handle(() => runView(control))
  )
  writing.put(
    '/run',
    handle(async (req) => {
      await control.setRun(runChange(control, req.body))
      return runView(control)
    })
  )
  reading.get(
    '/faults',
    handle(() => ({
      available: control.faults().available(),
      active: control.faults().active()
    }))
  )
  writing.post(
    '/faults',
    handle((req) => {
      const { kind, target } = (req.body ?? {}) as Record<string, unknown>
      if (typeof kind !== 'string') {
        throw new ControlError(400, 'give the fault as { "kind": ... }')
      }
      if (target !== undefined && typeof target !== 'string') {
        throw new ControlError(400, 'a target is a string')
      }
      return control.faults().raise(kind, target)
    }, 201)
  )
  writing.delete(
    '/faults/:kind/:target',
    handle((req) =>
      control.faults().clear(String(req.params.kind), String(req.params.target))
    )
  )
}

/** a PUT /run body, checked */
function runChange(control: Control, body: unknown): RunChange {
  if (typeof body !== 'object' || body === null) {
    throw new ControlError(400, 'give the change as a JSON object')
  }
  const b = body as Record<string, unknown>
  const change: RunChange = {}
  if (b.paused !== undefined) {
    if (typeof b.paused !== 'boolean') {
      throw new ControlError(400, 'paused is true or false')
    }
    change.paused = b.paused
  }
  if (b.timeMultiplier !== undefined) {
    const m = b.timeMultiplier
    if (typeof m !== 'number' || !(m > 0) || m > MAX_TIME_MULTIPLIER) {
      throw new ControlError(
        400,
        `timeMultiplier is a number above 0, up to ${MAX_TIME_MULTIPLIER}`
      )
    }
    change.timeMultiplier = m
  }
  if (b.time !== undefined && b.minutesIntoRoute !== undefined) {
    throw new ControlError(400, 'give time or minutesIntoRoute, not both')
  }
  if (b.time !== undefined) {
    const ms = typeof b.time === 'string' ? Date.parse(b.time) : NaN
    if (!Number.isFinite(ms)) {
      throw new ControlError(400, 'time is an ISO 8601 date and time')
    }
    change.scenarioMs = ms
  }
  if (b.minutesIntoRoute !== undefined) {
    const m = b.minutesIntoRoute
    if (typeof m !== 'number' || !Number.isFinite(m)) {
      throw new ControlError(400, 'minutesIntoRoute is a number')
    }
    change.scenarioMs = control.run().scenario.legs[0].departMs + m * 60000
  }
  return change
}

/** the run as GET /run gives it */
export function runView(control: Control) {
  const { options, scenario, simulation } = control.run()
  const result = simulation.last
  const legs = scenario.legs
  const departMs = legs[0].departMs
  const arriveMs = legs[legs.length - 1].arriveMs
  const scenarioMs = simulation.scenarioMs
  const position = result?.position
  const vessel = scenario.route.vessel
  const summary = simulation.systems?.summary()
  const anchor = simulation.systems?.anchor
  // the route at its own time, which the pilot holds back while she is off it
  const routeMs =
    scenarioMs !== undefined ? simulation.routeMs(scenarioMs) : undefined
  const nextPoint =
    routeMs !== undefined ? nextPointIndex(legs, routeMs) : undefined
  const hold =
    routeMs !== undefined && scenario.profile
      ? bridgeHoldAt(
          scenario.plannedRoute,
          legs,
          routeMs,
          scenario.profile.airHeightM
        )
      : undefined
  const pilot = simulation.pilot
  const rejoin = pilot?.rejoin
  const targets = position
    ? [...simulation.targets.values()]
        .map((t) => ({
          mmsi: t.mmsi,
          name: t.name,
          distanceNm: round(
            distanceNm(position.lat, position.lon, t.lat, t.lon),
            2
          ),
          sogKn: round(t.sogKn, 1),
          cogDeg: t.cogDeg === undefined ? undefined : Math.round(t.cogDeg),
          closestApproach: t.approach && {
            distanceM: Math.round(t.approach.distanceM),
            timeToS: Math.round(t.approach.timeToS)
          }
        }))
        .sort(dangerOrder(simulation.collisions.limits))
        .slice(0, MAX_TARGETS)
    : []
  return {
    sample: options.sample,
    route: scenario.route.name,
    boat: {
      name: vessel.name,
      mmsi: vessel.mmsi,
      profile: scenario.profile?.id,
      description: scenario.profile?.name ?? vessel.description
    },
    clock: {
      time: scenarioMs !== undefined ? iso(scenarioMs) : undefined,
      timeMultiplier: simulation.timeMultiplier,
      paused: simulation.isPaused,
      departure: iso(departMs),
      arrival: iso(arriveMs),
      minutesIntoRoute:
        scenarioMs !== undefined
          ? round((scenarioMs - departMs) / 60000, 1)
          : undefined,
      /** where the route's own timing has reached, behind the clock by her time off it */
      routeMinutesReached:
        routeMs !== undefined
          ? round((routeMs - departMs) / 60000, 1)
          : undefined,
      routeMinutes: round((arriveMs - departMs) / 60000, 1)
    },
    position: position && {
      latitude: position.lat,
      longitude: position.lon,
      sogKn: round(position.sogKn, 1),
      cogDeg: Math.round(position.cogDeg),
      state: position.finished
        ? 'arrived'
        : position.anchored
          ? 'anchored'
          : // holding for a bridge she is still under way, stopped in the water
            routeMs !== undefined && routeMs >= departMs
            ? 'under way'
            : 'alongside'
    },
    nextPoint:
      nextPoint === undefined
        ? undefined
        : {
            index: nextPoint,
            of: legs.length,
            /** the bridge she is holding for, and why */
            bridge: hold && {
              name: hold.bridge.name,
              closedClearanceM: hold.bridge.closedClearanceM,
              airHeightM: hold.airHeightM,
              clearsClosed: hold.clearsClosed,
              words: bridgeWords(hold)
            }
          },
    anchor: anchor && {
      latitude: anchor.lat,
      longitude: anchor.lon,
      depthM: round(anchor.depthM, 1),
      maxRadiusM: round(anchor.maxRadiusM, 1),
      currentRadiusM: round(anchor.currentRadiusM, 1),
      watchRadiusM: round(anchor.watchRadiusM, 1)
    },
    depthM: result?.depthM === undefined ? undefined : round(result.depthM, 1),
    weather: summary && {
      windKn: round(summary.weather.windKn, 1),
      windDeg: Math.round(summary.weather.windDeg),
      pressureHpa: round(summary.weather.pressurePa / 100, 1),
      airC: round(summary.weather.airC, 1),
      waterC: round(summary.weather.waterC, 1),
      humidity:
        summary.weather.humidity === undefined
          ? undefined
          : round(summary.weather.humidity, 2),
      tideM:
        summary.weather.tideM === undefined
          ? undefined
          : round(summary.weather.tideM, 2)
    },
    water: summary && {
      currentKn: round(summary.water.currentKn, 2),
      currentSetDeg: Math.round(summary.water.currentToDeg) % 360,
      currentFrom: summary.water.sampled ? 'sample' : 'seeded',
      speedThroughWaterKn: round(summary.water.stwKn, 2),
      leewayDeg: round(summary.water.leewayDeg, 1)
    },
    sails: summary?.sails && {
      propulsion: summary.sails.propulsion,
      set: summary.sails.set.map((s) => s.name),
      activeAreaM2: summary.sails.activeAreaM2,
      totalAreaM2: summary.sails.totalAreaM2,
      polar: summary.sails.performance && {
        trueWindAngleDeg: Math.round(summary.sails.performance.twaDeg),
        speedKn: round(summary.sails.performance.polarKn, 2),
        ratio: round(summary.sails.performance.ratio, 2),
        velocityMadeGoodKn: round(summary.sails.performance.vmgKn, 2),
        beatAngleDeg: round(summary.sails.performance.beat.twaDeg, 1),
        beatTargetSpeedKn: round(summary.sails.performance.beat.speedKn, 2),
        gybeAngleDeg: round(summary.sails.performance.gybe.twaDeg, 1),
        gybeTargetSpeedKn: round(summary.sails.performance.gybe.speedKn, 2),
        targetAngleDeg: round(summary.sails.performance.target.twaDeg, 1),
        targetSpeedKn: round(summary.sails.performance.target.speedKn, 2),
        tackDeg: Math.round(summary.sails.performance.tackDeg) % 360
      }
    },
    deck: summary && {
      lights: summary.deck.lights,
      night: summary.deck.night,
      chainM: round(summary.deck.chainM, 1),
      /** the scope she is lying to: the chain out over the depth and the bow roller's height */
      scope:
        anchor && summary.deck.chainM > 0
          ? round(
              summary.deck.chainM /
                (anchor.depthM +
                  BOW_HEIGHT_PER_LENGTH * (scenario.profile?.lengthM ?? 0)),
              1
            )
          : undefined,
      windlass: summary.deck.windlass,
      trim: summary.deck.trim,
      stabilisers: summary.deck.stabilisers,
      /** each radar by its name: transmitting, or standing by */
      radars: Object.fromEntries(
        (scenario.profile?.radars ?? []).map((r) => [
          r.displayName,
          summary.deck.radars[r.id]
        ])
      )
    },
    systems: summary && {
      enginesRunning: summary.enginesRunning,
      generatorsRunning: summary.generatorsRunning,
      sailing: summary.sailing,
      houseStateOfCharge:
        summary.houseSoc === undefined ? undefined : round(summary.houseSoc, 3),
      fuelL: Math.round(summary.fuelL),
      freshWaterLevel:
        summary.freshLevel === undefined
          ? undefined
          : round(summary.freshLevel, 3)
    },
    traffic: {
      shown: options.showTraffic,
      inRange: simulation.trafficCount,
      targets
    },
    autopilot: pilot && {
      state: pilot.state,
      mode: pilot.mode,
      engaged: pilot.engaged,
      modes: pilot.modes,
      /** degrees: a heading true, an apparent wind angle, or the dodge's rudder */
      target: pilot.heldTargetDeg,
      routeTargetDeg:
        pilot.mode === 'route' && pilot.target !== null
          ? Math.round((pilot.target * 180) / Math.PI)
          : undefined,
      onRoute: pilot.onRoute,
      rejoin: rejoin && {
        latitude: rejoin.lat,
        longitude: rejoin.lon,
        distanceM: Math.round(rejoin.distanceM)
      },
      behindRouteMinutes:
        scenarioMs !== undefined && routeMs !== undefined
          ? round((scenarioMs - routeMs) / 60000, 1)
          : undefined,
      /** why it cannot be engaged now, as the page and the faults list show it */
      refusal: pilot.refusal(),
      alarms: pilot.alarms
    },
    faults: simulation.faults?.active() ?? [],
    alarms: [
      ...(simulation.alarms?.active() ?? []).map((a) => ({
        path: a.path,
        state: a.state,
        message: a.message
      })),
      ...simulation.collisions.active().map((c) => ({
        path: `${c.context}.notifications.navigation.closestApproach`,
        state: c.value.state,
        message: c.value.message
      }))
    ]
  }
}

interface ListedTarget {
  distanceNm: number
  closestApproach?: { distanceM: number; timeToS: number }
}

/**
 * The order a plotter's danger list puts targets in: those whose closest approach is
 * inside the collision alarm's limits, soonest first; then the rest that are closing, by
 * how close they come, nearest first; then those not closing, by range.
 */
export function dangerOrder(limits: CollisionLimits) {
  const rank = (t: ListedTarget) =>
    !t.closestApproach
      ? 2
      : t.closestApproach.distanceM < limits.distanceM &&
          t.closestApproach.timeToS < limits.timeS
        ? 0
        : 1
  return (a: ListedTarget, b: ListedTarget) => {
    const ra = rank(a)
    const rb = rank(b)
    if (ra !== rb) return ra - rb
    if (ra === 0) return a.closestApproach!.timeToS - b.closestApproach!.timeToS
    if (ra === 1)
      return a.closestApproach!.distanceM - b.closestApproach!.distanceM
    return a.distanceNm - b.distanceNm
  }
}

const iso = (ms: number) => new Date(ms).toISOString()
const round = (x: number, places: number) =>
  Math.round(x * 10 ** places) / 10 ** places
