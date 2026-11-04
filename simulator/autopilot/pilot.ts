import {
  Leg,
  RoutePosition,
  initialCourseDeg,
  nextPointIndex,
  positionAt,
  turnMiddleMs,
  turnRateDegS
} from '../routes/route'

/**
 * The boat's autopilot, as the server's Autopilot API sees one: a state (standby, or auto
 * and steering), a mode (route, compass, wind, or dodge while a dodge is held) and a target.
 *
 * In standby the helm steers the route, as it always has. In auto on the route mode the
 * pilot steers the same route: the route follower is the pilot, and what it adds are the
 * autopilot's alarms. Compass, wind and dodge take her off the route: she is then sailed by
 * dead reckoning, on the heading the pilot holds, at the speed she had, set by the current.
 * Put back to route mode, or to standby, she steers for the nearest point of the route ahead
 * of where she left it, and on reaching it the route's own timing carries on from there.
 */
export type PilotState = 'standby' | 'auto'
export type PilotMode = 'route' | 'compass' | 'wind' | 'dodge'
export type PilotAction =
  'dodge' | 'tack' | 'gybe' | 'courseCurrentPoint' | 'courseNextPoint'
export type PilotAlarm =
  | 'waypointAdvance'
  | 'waypointArrival'
  | 'routeComplete'
  | 'xte'
  | 'heading'
  | 'wind'

export interface PilotNotification {
  state: 'normal' | 'alert' | 'warn' | 'alarm'
  method: ('visual' | 'sound')[]
  message: string
}

/** what the pilot sends the server's Autopilot API, as `autopilotUpdate` takes it */
export type PilotUpdate = {
  state?: PilotState
  mode?: PilotMode
  target?: number | null
  engaged?: boolean
  alarm?: { path: PilotAlarm; value: PilotNotification }
}

/** what the boat is doing at the pilot's step, from the systems model's latest step */
export interface PilotContext {
  headingDeg: number
  /** the true wind, the direction it comes from */
  windKn: number
  windDeg: number
  /** the current, the direction it runs towards */
  currentKn: number
  currentToDeg: number
  /** the pilot is out of action (simulator/faults) */
  failed: boolean
}

/** where the boat is and how she moves at a model step */
export interface PilotMotion {
  lat: number
  lon: number
  sogKn: number
  cogDeg: number
  rateOfTurnDegS: number
  /** her heading, when the pilot holds one off the route */
  headingDeg?: number
  /** the route's position at its own time, which the berth, anchorage and holds follow */
  route: RoutePosition
  /** she is on the route, sailed by it */
  onRoute: boolean
}

export interface PilotSaved {
  state: PilotState
  mode: PilotMode
  modeBeforeDodge: PilotMode | null
  targetHeadingDeg: number
  targetAwaDeg: number
  dodgeRudderDeg: number
  free: { lat: number; lon: number; headingDeg: number; speedKn: number } | null
  /** route time she left the route at, frozen while she is off it */
  frozenRouteMs: number | null
  /** the point of the route she is making for to rejoin it, by its route time */
  rejoinRouteMs: number | null
  routeOffsetMs: number
  raised: Partial<Record<PilotAlarm, PilotNotification>>
  /** waypoints whose advance and arrival alarms have been raised */
  advanced: number[]
  arrived: number[]
  alarmClears: Partial<Record<PilotAlarm, number>>
  offTargetSinceMs: number | null
  bestErrorDeg: number | null
}

export interface PilotOptions {
  lengthM: number
  /** a sailing boat's pilot steers to the wind, and tacks and gybes */
  sail: boolean
  legs: Leg[]
}

export class PilotError extends Error {}

const RADIANS = Math.PI / 180
const METRES_PER_DEG = (6371000 * Math.PI) / 180
const KNOT_MS = 1852 / 3600
/** the waypoint advance alarm comes this long before the turn at a waypoint, or the stop */
export const ADVANCE_LEAD_MS = 30000
/** an arrival or advance alert stands this long, a route complete one longer */
const ALERT_STANDS_MS = 30000
const COMPLETE_STANDS_MS = 120000
/** cross track error: raised past this, cleared inside the second */
export const XTE_ALARM_M = 100
const XTE_CLEAR_M = 80
/** off target: raised when the error is past this and has not closed for the time */
export const OFF_TARGET_DEG = 20
const OFF_TARGET_CLEAR_DEG = 10
export const OFF_TARGET_MS = 30000
/** she has rejoined the route within this of the point she made for */
const JOIN_M = 10
/** the rejoining point lies this far ahead of the nearest, so she joins at an angle */
const JOIN_LEAD_MS = 30000
/** the route is searched for the nearest point ahead in steps of this */
const SEARCH_STEP_MS = 10000
/** a held dodge turns her as its rudder would: the inverse of the navigation's rudder */
const RUDDER_GAIN = 1.5
const MAX_RUDDER_DEG = 20
const WIND_MODE_DEFAULT_AWA_DEG = 45
/** a target that turns with the route goes to the API each time it has turned this far */
const TARGET_SENT_DEG = 0.5

const wrap180 = (d: number) => ((((d + 180) % 360) + 360) % 360) - 180
const norm360 = (d: number) => ((d % 360) + 360) % 360

function metresFrom(
  a: { lat: number; lon: number },
  b: { lat: number; lon: number }
): [number, number] {
  return [
    (b.lon - a.lon) * METRES_PER_DEG * Math.cos(a.lat * RADIANS),
    (b.lat - a.lat) * METRES_PER_DEG
  ]
}

export class Autopilot {
  private s: PilotSaved = {
    state: 'standby',
    mode: 'route',
    modeBeforeDodge: null,
    targetHeadingDeg: 0,
    targetAwaDeg: WIND_MODE_DEFAULT_AWA_DEG,
    dodgeRudderDeg: 0,
    free: null,
    frozenRouteMs: null,
    rejoinRouteMs: null,
    routeOffsetMs: 0,
    raised: {},
    advanced: [],
    arrived: [],
    alarmClears: {},
    offTargetSinceMs: null,
    bestErrorDeg: null
  }
  private updates: PilotUpdate[] = []
  /** the target last sent to the API, so a route's turning target is sent as it turns */
  private sentTargetDeg: number | null = null
  /** the latest context and motion, for what the pilot is asked between steps */
  private ctx: PilotContext | undefined
  private last: PilotMotion | undefined
  private nowMs = 0

  constructor(
    readonly options: PilotOptions,
    saved?: PilotSaved
  ) {
    if (saved) this.s = structuredClone(saved)
  }

  get modes(): PilotMode[] {
    return this.options.sail
      ? ['route', 'compass', 'wind']
      : ['route', 'compass']
  }

  get state(): PilotState {
    return this.s.state
  }

  get mode(): PilotMode {
    return this.s.mode
  }

  get engaged(): boolean {
    return this.s.state === 'auto'
  }

  /** route time is scenario time less this */
  get routeOffsetMs(): number {
    return this.s.routeOffsetMs
  }

  get onRoute(): boolean {
    return this.s.free === null
  }

  /** where she is and how she moves while off the route */
  get offRoutePosition(): PilotMotion | undefined {
    return this.s.free ? this.last : undefined
  }

  /** the target in the API's terms: a heading or an apparent wind angle, radians */
  get target(): number | null {
    switch (this.s.mode) {
      case 'compass':
        return this.s.targetHeadingDeg * RADIANS
      case 'wind':
        return this.s.targetAwaDeg * RADIANS
      case 'route':
        return this.last ? this.routeTargetDeg(this.last) * RADIANS : null
      case 'dodge':
        return null
    }
  }

  /** the course the route has her steer: the track, or towards the point she rejoins at */
  private routeTargetDeg(m: PilotMotion): number {
    if (this.s.free && this.s.rejoinRouteMs !== null) {
      const p = positionAt(this.options.legs, this.s.rejoinRouteMs)
      const [e, n] = metresFrom(this.s.free, p)
      return norm360(Math.atan2(e, n) / RADIANS)
    }
    return m.route.cogDeg
  }

  /** where the rejoining point is, and how far, while she makes for it */
  get rejoin(): { lat: number; lon: number; distanceM: number } | undefined {
    if (!this.s.free || this.s.rejoinRouteMs === null) return undefined
    const p = positionAt(this.options.legs, this.s.rejoinRouteMs)
    return {
      lat: p.lat,
      lon: p.lon,
      distanceM: Math.hypot(...metresFrom(this.s.free, p))
    }
  }

  get heldTargetDeg(): {
    headingDeg?: number
    awaDeg?: number
    rudderDeg?: number
  } {
    return this.s.mode === 'compass'
      ? { headingDeg: this.s.targetHeadingDeg }
      : this.s.mode === 'wind'
        ? { awaDeg: this.s.targetAwaDeg }
        : this.s.mode === 'dodge'
          ? { rudderDeg: this.s.dodgeRudderDeg }
          : {}
  }

  /** the alarms raised now */
  get alarms(): { path: PilotAlarm; value: PilotNotification }[] {
    return (
      Object.entries(this.s.raised) as [PilotAlarm, PilotNotification][]
    ).map(([path, value]) => ({ path, value }))
  }

  /** the pilot as the server's Autopilot API's getData gives it */
  data(): {
    options: {
      states: { name: PilotState; engaged: boolean }[]
      modes: PilotMode[]
      actions: { id: PilotAction; name: string; available: boolean }[]
    }
    target: number | null
    mode: PilotMode
    state: PilotState
    engaged: boolean
  } {
    const engaged = this.s.state === 'auto'
    const wind = engaged && this.s.mode === 'wind'
    const actions: { id: PilotAction; name: string; available: boolean }[] = [
      { id: 'dodge', name: 'Dodge', available: engaged },
      {
        id: 'courseCurrentPoint',
        name: 'Course to current point',
        available: !this.refusal()
      },
      {
        id: 'courseNextPoint',
        name: 'Course to next point',
        available: !this.refusal()
      }
    ]
    if (this.options.sail) {
      actions.push(
        { id: 'tack', name: 'Tack', available: wind },
        { id: 'gybe', name: 'Gybe', available: wind }
      )
    }
    return {
      options: {
        states: [
          { name: 'auto', engaged: true },
          { name: 'standby', engaged: false }
        ],
        modes: this.modes,
        actions
      },
      target: this.target,
      mode: this.s.mode,
      state: this.s.state,
      engaged
    }
  }

  /**
   * Back on the route at its own time, the pilot standing by: after a jump along the route,
   * which puts her where the route has her then
   */
  backOnRoute(): void {
    this.s.free = null
    this.s.frozenRouteMs = null
    this.s.rejoinRouteMs = null
    this.s.routeOffsetMs = 0
    this.s.state = 'standby'
    if (this.s.mode === 'dodge') this.s.mode = this.s.modeBeforeDodge ?? 'route'
    this.s.modeBeforeDodge = null
    this.changed()
  }

  save(): PilotSaved {
    return structuredClone(this.s)
  }

  /** the updates for the server's Autopilot API since the last call */
  takeUpdates(): PilotUpdate[] {
    const u = this.updates
    this.updates = []
    return u
  }

  // ---- what the server's Autopilot API asks ----------------------------------------

  /** why the pilot cannot be engaged now, or undefined when it can */
  refusal(): string | undefined {
    const r = this.last?.route
    if (this.ctx?.failed) return 'the autopilot has a fault; clear it first'
    if (!r) return undefined
    if (r.anchored) return 'she is at anchor: weigh first'
    if (
      r.finished ||
      this.nowMs - this.s.routeOffsetMs < this.options.legs[0].departMs
    )
      return 'she is alongside her berth: get under way first'
    return undefined
  }

  engage(): void {
    const why = this.refusal()
    if (why) throw new PilotError(`cannot engage the autopilot: ${why}`)
    if (this.s.state === 'auto') return
    this.s.state = 'auto'
    if (this.s.mode === 'compass' && this.last)
      this.s.targetHeadingDeg = Math.round(this.heading())
    this.changed()
  }

  disengage(): void {
    if (this.s.state === 'standby') return
    this.s.state = 'standby'
    if (this.s.mode === 'dodge') this.s.mode = this.s.modeBeforeDodge ?? 'route'
    this.s.modeBeforeDodge = null
    this.startRejoin()
    this.changed()
  }

  setState(state: string): void {
    if (state === 'auto') this.engage()
    else if (state === 'standby') this.disengage()
    else throw new PilotError(`no state called ${state}: auto or standby`)
  }

  setMode(mode: string): void {
    if (!this.modes.includes(mode as PilotMode)) {
      throw new PilotError(
        `no mode called ${mode} on this pilot: ${this.modes.join(', ')}`
      )
    }
    const m = mode as PilotMode
    if (m === this.s.mode) return
    if (m === 'compass') this.s.targetHeadingDeg = Math.round(this.heading())
    if (m === 'wind') this.s.targetAwaDeg = Math.round(this.awaDeg())
    this.s.mode = m
    this.s.modeBeforeDodge = null
    if (m === 'route') this.startRejoin()
    this.changed()
  }

  /** a heading in compass mode, an apparent wind angle in wind mode, radians */
  setTarget(rad: number): void {
    const deg = rad / RADIANS
    if (this.s.mode === 'compass') this.s.targetHeadingDeg = norm360(deg)
    else if (this.s.mode === 'wind') {
      if (Math.abs(wrap180(deg)) > 180) throw new PilotError('out of range')
      this.s.targetAwaDeg = wrap180(deg)
    } else
      throw new PilotError(
        `in ${this.s.mode} mode the ${this.s.mode === 'route' ? 'route sets the target' : 'dodge sets the rudder'}; set compass or wind mode to give a target`
      )
    this.changed()
  }

  adjustTarget(rad: number): void {
    const now =
      this.s.mode === 'compass'
        ? this.s.targetHeadingDeg
        : this.s.mode === 'wind'
          ? this.s.targetAwaDeg
          : undefined
    if (now === undefined) this.setTarget(rad)
    else this.setTarget((now + rad / RADIANS) * RADIANS)
  }

  /** steer for the route's next point: engaged in route mode, rejoining there when off it */
  courseCurrentPoint(): void {
    this.engage()
    this.s.mode = 'route'
    this.s.modeBeforeDodge = null
    if (this.s.free) {
      const next = this.nextPoint()
      this.s.rejoinRouteMs = next === undefined ? null : this.pointMs(next)
      if (this.s.rejoinRouteMs === null) this.startRejoin()
    }
    this.changed()
  }

  /** skip the route's next point: she leaves the route and steers for the one after it */
  courseNextPoint(): void {
    const next = this.nextPoint()
    if (next === undefined || next + 1 > this.options.legs.length) {
      throw new PilotError('there is no point after the next one')
    }
    this.engage()
    this.leaveRoute()
    this.s.mode = 'route'
    this.s.modeBeforeDodge = null
    this.s.rejoinRouteMs = this.pointMs(next + 1)
    this.changed()
  }

  tack(direction: 'port' | 'starboard'): void {
    this.turnThroughWind('tack', direction)
  }

  gybe(direction: 'port' | 'starboard'): void {
    this.turnThroughWind('gybe', direction)
  }

  private turnThroughWind(
    kind: 'tack' | 'gybe',
    direction: 'port' | 'starboard'
  ): void {
    if (!this.options.sail)
      throw new PilotError(`a motor boat does not ${kind}`)
    if (this.s.state !== 'auto' || this.s.mode !== 'wind')
      throw new PilotError(`${kind} in wind mode, with the pilot engaged`)
    const awa = this.awaDeg()
    // turning to port the wind comes round from the port side to starboard, and the other
    // way to starboard; a tack is through the wind ahead, a gybe through it astern
    const ok =
      kind === 'tack'
        ? direction === 'port'
          ? awa < 0 && awa > -90
          : awa > 0 && awa < 90
        : direction === 'port'
          ? awa >= 90
          : awa <= -90
    if (!ok) {
      throw new PilotError(
        `cannot ${kind} to ${direction} with the wind ${Math.abs(Math.round(awa))}° on the ${awa < 0 ? 'port' : 'starboard'} ${Math.abs(awa) < 90 ? 'bow' : 'quarter'}`
      )
    }
    this.s.targetAwaDeg = -this.s.targetAwaDeg
    this.changed()
  }

  /** a dodge: the rudder held over by `rad` (radians, positive to starboard); null ends it */
  dodge(rad: number | null): void {
    if (rad === null) {
      if (this.s.mode !== 'dodge') return
      this.s.mode = this.s.modeBeforeDodge ?? 'route'
      this.s.modeBeforeDodge = null
      this.s.dodgeRudderDeg = 0
      if (this.s.mode === 'route') this.startRejoin()
      this.changed()
      return
    }
    if (this.s.state !== 'auto')
      throw new PilotError('dodge with the pilot engaged')
    if (this.s.mode !== 'dodge') this.s.modeBeforeDodge = this.s.mode
    this.s.mode = 'dodge'
    this.s.dodgeRudderDeg = Math.max(
      -MAX_RUDDER_DEG,
      Math.min(MAX_RUDDER_DEG, rad / RADIANS)
    )
    this.leaveRoute()
    this.changed()
  }

  // ---- stepping, inside the systems model's steps --------------------------------------

  /**
   * Where the boat is at this model step: on the route at its own time, or wherever the
   * pilot (or the helm rejoining) has taken her.
   */
  step(ms: number, dt: number, ctx: PilotContext): PilotMotion {
    this.nowMs = ms
    this.ctx = ctx
    const legs = this.options.legs
    if (ctx.failed && this.s.state === 'auto') this.dropOut()
    if (!ctx.failed && this.s.raised.heading?.message === FAILURE)
      this.clear('heading')

    const offRouteMode = this.s.state === 'auto' && this.s.mode !== 'route'
    if (!this.s.free && offRouteMode) this.leaveRoute()

    let motion: PilotMotion
    if (!this.s.free) {
      const route = positionAt(legs, ms - this.s.routeOffsetMs)
      motion = {
        lat: route.lat,
        lon: route.lon,
        sogKn: route.sogKn,
        cogDeg: route.cogDeg,
        rateOfTurnDegS: route.rateOfTurnDegS,
        route,
        onRoute: true
      }
    } else {
      motion = this.freeStep(ms, dt, ctx)
    }
    this.last = motion
    this.watch(ms, motion, ctx)
    const target = this.target
    if (
      target !== null &&
      (this.sentTargetDeg === null ||
        Math.abs(wrap180(target / RADIANS - this.sentTargetDeg)) >=
          TARGET_SENT_DEG)
    ) {
      this.sentTargetDeg = target / RADIANS
      this.updates.push({ target })
    }
    const r = motion.route
    // alongside or anchored the pilot has nothing to steer, and stands by
    if (
      this.s.state === 'auto' &&
      motion.onRoute &&
      (r.anchored || r.finished || ms - this.s.routeOffsetMs < legs[0].departMs)
    ) {
      this.s.state = 'standby'
      this.changed()
    }
    return motion
  }

  private heading(): number {
    return this.ctx?.headingDeg ?? this.last?.cogDeg ?? 0
  }

  /** the apparent wind angle off the bow, positive to starboard */
  private awaDeg(): number {
    const ctx = this.ctx
    const m = this.last
    if (!ctx || !m) return this.s.targetAwaDeg
    const from = ctx.windDeg * RADIANS
    const boatE = m.sogKn * Math.sin(m.cogDeg * RADIANS)
    const boatN = m.sogKn * Math.cos(m.cogDeg * RADIANS)
    const e = -ctx.windKn * Math.sin(from) - boatE
    const n = -ctx.windKn * Math.cos(from) - boatN
    return wrap180(Math.atan2(-e, -n) / RADIANS - ctx.headingDeg)
  }

  private leaveRoute(): void {
    if (this.s.free) return
    const at = this.last
    if (!at) return
    const routeMs = this.nowMs - this.s.routeOffsetMs
    const leg =
      this.options.legs[
        Math.min(at.route.legIndex, this.options.legs.length - 1)
      ]
    this.s.free = {
      lat: at.lat,
      lon: at.lon,
      headingDeg: this.ctx?.headingDeg ?? at.cogDeg,
      speedKn: at.route.sogKn > 0 ? at.route.sogKn : leg.speedKn
    }
    this.s.frozenRouteMs = routeMs
    this.s.rejoinRouteMs = null
  }

  /** she makes for the nearest point of the route ahead of where she left it */
  private startRejoin(): void {
    if (!this.s.free || this.s.frozenRouteMs === null) return
    const legs = this.options.legs
    const end = legs[legs.length - 1].arriveMs
    let best = this.s.frozenRouteMs
    let bestM = Infinity
    for (let t = this.s.frozenRouteMs; t <= end; t += SEARCH_STEP_MS) {
      const d = Math.hypot(...metresFrom(this.s.free, positionAt(legs, t)))
      if (d < bestM) {
        bestM = d
        best = t
      }
    }
    this.s.rejoinRouteMs = Math.min(end, best + JOIN_LEAD_MS)
  }

  private freeStep(ms: number, dt: number, ctx: PilotContext): PilotMotion {
    const f = this.s.free!
    const legs = this.options.legs
    const rejoining = !(this.s.state === 'auto' && this.s.mode !== 'route')
    if (rejoining && this.s.rejoinRouteMs === null) this.startRejoin()
    let rate = 0
    const maxRate = turnRateDegS(this.options.lengthM, Math.max(1, f.speedKn))
    const toward = (deg: number) => {
      const err = wrap180(deg - f.headingDeg)
      rate = Math.max(-maxRate, Math.min(maxRate, err / dt))
    }
    if (rejoining) {
      toward(this.routeTargetDeg(this.last!))
    } else if (this.s.mode === 'compass') {
      toward(this.s.targetHeadingDeg)
    } else if (this.s.mode === 'wind') {
      toward(f.headingDeg + this.awaDeg() - this.s.targetAwaDeg)
    } else {
      // dodge: the rudder over, turning her as it would at her speed
      const stw = f.speedKn * KNOT_MS
      rate =
        (this.s.dodgeRudderDeg * RADIANS * stw) /
        (RUDDER_GAIN * this.options.lengthM) /
        RADIANS
    }
    f.headingDeg = norm360(f.headingDeg + rate * dt)
    const h = f.headingDeg * RADIANS
    const c = ctx.currentToDeg * RADIANS
    const e = f.speedKn * Math.sin(h) + ctx.currentKn * Math.sin(c)
    const n = f.speedKn * Math.cos(h) + ctx.currentKn * Math.cos(c)
    f.lat += (n * KNOT_MS * dt) / METRES_PER_DEG
    f.lon += (e * KNOT_MS * dt) / (METRES_PER_DEG * Math.cos(f.lat * RADIANS))
    // the route stands still while she is off it
    this.s.routeOffsetMs = ms - this.s.frozenRouteMs!
    const route = positionAt(legs, this.s.frozenRouteMs!)
    if (rejoining && this.s.rejoinRouteMs !== null) {
      const p = positionAt(legs, this.s.rejoinRouteMs)
      if (
        Math.hypot(...metresFrom(f, p)) <
        Math.max(JOIN_M, f.speedKn * KNOT_MS * dt)
      ) {
        // on the route again, its timing carrying on from the point she joined it at
        this.s.routeOffsetMs = ms - this.s.rejoinRouteMs
        this.s.free = null
        this.s.frozenRouteMs = null
        this.s.rejoinRouteMs = null
        const on = positionAt(legs, ms - this.s.routeOffsetMs)
        return {
          lat: on.lat,
          lon: on.lon,
          sogKn: on.sogKn,
          cogDeg: on.cogDeg,
          rateOfTurnDegS: on.rateOfTurnDegS,
          route: on,
          onRoute: true
        }
      }
    }
    return {
      lat: f.lat,
      lon: f.lon,
      sogKn: Math.hypot(e, n),
      cogDeg: norm360(Math.atan2(e, n) / RADIANS),
      rateOfTurnDegS: rate,
      headingDeg: f.headingDeg,
      route: { ...route, sogKn: f.speedKn, anchored: false, finished: false },
      onRoute: false
    }
  }

  private dropOut(): void {
    this.s.state = 'standby'
    if (this.s.mode === 'dodge') this.s.mode = this.s.modeBeforeDodge ?? 'route'
    this.s.modeBeforeDodge = null
    this.startRejoin()
    this.raise('heading', {
      state: 'alarm',
      method: ['visual', 'sound'],
      message: FAILURE
    })
    this.changed()
  }

  // ---- the alarms ---------------------------------------------------------------------

  private raise(
    path: PilotAlarm,
    value: PilotNotification,
    clearsAtMs?: number
  ): void {
    this.s.raised[path] = value
    if (clearsAtMs !== undefined) this.s.alarmClears[path] = clearsAtMs
    else delete this.s.alarmClears[path]
    this.updates.push({ alarm: { path, value } })
  }

  private clear(path: PilotAlarm): void {
    const was = this.s.raised[path]
    if (!was) return
    delete this.s.raised[path]
    delete this.s.alarmClears[path]
    this.updates.push({
      alarm: {
        path,
        value: { state: 'normal', method: [], message: was.message }
      }
    })
  }

  private nextPoint(): number | undefined {
    return nextPointIndex(this.options.legs, this.nowMs - this.s.routeOffsetMs)
  }

  /** the route time she reaches a point at: abeam of it on a turn, or on stopping there */
  private pointMs(index: number): number {
    const legs = this.options.legs
    const leg = legs[index - 1]
    return leg.turn ? turnMiddleMs(leg.turn) : leg.arriveMs
  }

  private watch(ms: number, m: PilotMotion, ctx: PilotContext): void {
    for (const [path, at] of Object.entries(this.s.alarmClears) as [
      PilotAlarm,
      number
    ][]) {
      if (ms >= at) this.clear(path)
    }
    if (this.s.state !== 'auto') {
      for (const p of ['xte', 'wind'] as const) this.clear(p)
      if (this.s.raised.heading?.message !== FAILURE) this.clear('heading')
      this.s.offTargetSinceMs = null
      return
    }
    const legs = this.options.legs
    if (this.s.mode === 'route' && m.onRoute) {
      const routeMs = ms - this.s.routeOffsetMs
      legs.forEach((leg, i) => {
        const index = i + 1
        const turnStart = leg.turn ? leg.turn.startMs : leg.arriveMs
        const at = leg.turn ? turnMiddleMs(leg.turn) : leg.arriveMs
        const last = index === legs.length
        if (
          !last &&
          !this.s.advanced.includes(index) &&
          routeMs >= turnStart - ADVANCE_LEAD_MS &&
          routeMs < at
        ) {
          this.s.advanced.push(index)
          this.raise(
            'waypointAdvance',
            {
              state: 'alert',
              method: ['sound'],
              message: `Waypoint advance: ${leg.to.name ?? `point ${index}`}`
            },
            ms + ALERT_STANDS_MS
          )
        }
        if (
          !this.s.arrived.includes(index) &&
          routeMs >= at &&
          routeMs < at + ALERT_STANDS_MS
        ) {
          this.s.arrived.push(index)
          if (last) {
            this.raise(
              'routeComplete',
              { state: 'alert', method: ['sound'], message: 'Route complete' },
              ms + COMPLETE_STANDS_MS
            )
          } else {
            this.raise(
              'waypointArrival',
              {
                state: 'alert',
                method: ['sound'],
                message: `Waypoint arrival: ${leg.to.name ?? `point ${index}`}`
              },
              ms + ALERT_STANDS_MS
            )
          }
        }
      })
    }
    // cross track error, in route mode, from the leg she is on or left the route from
    if (this.s.mode === 'route') {
      const xte = Math.abs(this.crossTrackM(m))
      if (!this.s.raised.xte && xte > XTE_ALARM_M) {
        this.raise('xte', {
          state: 'warn',
          method: ['visual', 'sound'],
          message: `Cross track error ${Math.round(xte)} m`
        })
      } else if (this.s.raised.xte && xte < XTE_CLEAR_M) this.clear('xte')
    } else this.clear('xte')
    // off target: an error that has not closed for a while is one she cannot hold
    const kind: PilotAlarm | undefined =
      this.s.mode === 'compass'
        ? 'heading'
        : this.s.mode === 'wind'
          ? 'wind'
          : undefined
    const errorDeg =
      this.s.mode === 'compass'
        ? Math.abs(wrap180(ctx.headingDeg - this.s.targetHeadingDeg))
        : this.s.mode === 'wind'
          ? Math.abs(wrap180(this.awaDeg() - this.s.targetAwaDeg))
          : 0
    if (!kind) {
      this.s.offTargetSinceMs = null
      if (this.s.raised.heading?.message !== FAILURE) this.clear('heading')
      this.clear('wind')
      return
    }
    if (this.s.raised[kind]) {
      if (errorDeg < OFF_TARGET_CLEAR_DEG) this.clear(kind)
      return
    }
    if (errorDeg <= OFF_TARGET_DEG) {
      this.s.offTargetSinceMs = null
      this.s.bestErrorDeg = null
      return
    }
    if (
      this.s.offTargetSinceMs === null ||
      this.s.bestErrorDeg === null ||
      errorDeg < this.s.bestErrorDeg - 1
    ) {
      // still closing on it
      this.s.offTargetSinceMs = ms
      this.s.bestErrorDeg = errorDeg
      return
    }
    if (ms - this.s.offTargetSinceMs >= OFF_TARGET_MS) {
      this.raise(kind, {
        state: 'warn',
        method: ['visual', 'sound'],
        message:
          kind === 'heading'
            ? `Off course: ${Math.round(errorDeg)}° from the target heading`
            : `Off the wind: ${Math.round(errorDeg)}° from the target angle`
      })
    }
  }

  /** metres off the route's track, from the leg she is on or left it from */
  private crossTrackM(m: PilotMotion): number {
    const legs = this.options.legs
    const leg = legs[Math.min(m.route.legIndex, legs.length - 1)]
    const bearing = initialCourseDeg(
      leg.from.lat,
      leg.from.lon,
      leg.to.lat,
      leg.to.lon
    )
    const [e, n] = metresFrom(leg.from, m)
    const b = bearing * RADIANS
    return e * Math.cos(b) - n * Math.sin(b)
  }

  private changed(): void {
    const target = this.target
    this.sentTargetDeg = target === null ? null : target / RADIANS
    this.updates.push({
      state: this.s.state,
      mode: this.s.mode,
      target: this.target,
      engaged: this.s.state === 'auto'
    })
  }
}

export const FAILURE =
  'Autopilot failure: dropped out to standby, the helm has her'
