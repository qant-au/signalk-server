import type { IRouter, Request, RequestHandler, Response } from 'express'
import { distanceNm } from '../ais/reception'
import { Scenario } from '../engine/scenario'
import { Simulation } from '../engine/simulation'
import { FaultError, Faults } from '../faults/faults'
import { nextPointIndex } from '../routes/route'

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
  const nextPoint =
    scenarioMs !== undefined ? nextPointIndex(legs, scenarioMs) : undefined
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
        // the closing targets first, soonest first, then the rest by distance
        .sort((a, b) =>
          a.closestApproach && b.closestApproach
            ? a.closestApproach.timeToS - b.closestApproach.timeToS
            : a.closestApproach
              ? -1
              : b.closestApproach
                ? 1
                : a.distanceNm - b.distanceNm
        )
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
          : position.sogKn > 0
            ? 'under way'
            : 'alongside'
    },
    nextPoint:
      nextPoint === undefined
        ? undefined
        : { index: nextPoint, of: legs.length },
    depthM: result?.depthM === undefined ? undefined : round(result.depthM, 1),
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

const iso = (ms: number) => new Date(ms).toISOString()
const round = (x: number, places: number) =>
  Math.round(x * 10 ** places) / 10 ** places
