import type { Delta } from '../soak/deltas'
import type { AlarmZone, ZoneState } from '../vessels/profile'
import { AlarmBand } from './zones'

/** what a notification carries */
export interface NotificationValue {
  state: ZoneState
  method: ('visual' | 'sound')[]
  message: string
}

/** an alarm as raised, before it is sent */
export interface Alarm {
  state: ZoneState
  message: string
}

export interface AlarmsState {
  version: number
  /** the notifications last sent, by path, so a restart clears what has cleared */
  notified: Record<string, NotificationValue>
}

const ALARMS_STATE_VERSION = 1

/** a watched path's metadata: its zones, and the method each state of them calls for */
export interface ZoneMeta {
  description: string
  zones: AlarmZone[]
  alertMethod: NotificationValue['method']
  warnMethod: NotificationValue['method']
  alarmMethod: NotificationValue['method']
  emergencyMethod: NotificationValue['method']
  /** the source that raises the notifications for these zones, so the server raises none */
  zonesNotifiedBy: string
}

const SEVERITY: Record<ZoneState, number> = {
  nominal: 0,
  normal: 0,
  alert: 1,
  warn: 2,
  alarm: 3,
  emergency: 4
}

/**
 * A value not sent for this many sends is no longer read: the slow values go out every
 * fifth send, and a sounder that has gone quiet gives no depth rather than its last one.
 */
const FRESH_FOR_SENDS = 12

const methodFor = (state: ZoneState): NotificationValue['method'] =>
  SEVERITY[state] >= SEVERITY.alarm
    ? ['visual', 'sound']
    : SEVERITY[state] > 0
      ? ['visual']
      : []

const within = (z: AlarmZone, value: number, margin: number) =>
  (z.lower === undefined || value >= z.lower - margin) &&
  (z.upper === undefined || value < z.upper + margin)

/**
 * The boat's alarm panel. It reads the values as they go out, raises
 * `notifications.<path>` for each watched value in one of its zones, with the zone's state
 * and message, and sends `normal` once the value is back out of it by the band's margin.
 * Alarms that no zone can know (a generator that would not start, a fix lost) are handed
 * to it as they are, and sent and cleared the same way.
 */
export class AlarmPanel {
  private readonly values = new Map<string, { value: unknown; send: number }>()
  private sends = 0
  private notified = new Map<string, NotificationValue>()

  constructor(
    readonly bands: Map<string, AlarmBand>,
    state?: AlarmsState
  ) {
    if (state?.version === ALARMS_STATE_VERSION && state.notified) {
      this.notified = new Map(Object.entries(state.notified))
    }
  }

  save(): AlarmsState {
    return {
      version: ALARMS_STATE_VERSION,
      notified: Object.fromEntries(this.notified)
    }
  }

  /**
   * Each watched path's zones, as the metadata a display colours its gauges by, with the
   * method for each state. `zonesNotifiedBy` names the panel's source: the server would
   * otherwise raise a second notification of its own from these zones (src/zones.ts), at a
   * zone's edge, with no margin, and for an engine's oil pressure whether or not it runs.
   */
  meta(notifiedBy: string): { path: string; value: ZoneMeta }[] {
    return [...this.bands].map(([path, band]) => ({
      path,
      value: {
        description: band.description,
        zones: band.zones,
        alertMethod: methodFor('alert'),
        warnMethod: methodFor('warn'),
        alarmMethod: methodFor('alarm'),
        emergencyMethod: methodFor('emergency'),
        zonesNotifiedBy: notifiedBy
      }
    }))
  }

  /** the values as they went out, which is what the panel reads */
  record(delta: Delta): void {
    for (const update of delta.updates) {
      for (const v of update.values) {
        if (this.bands.has(v.path) || v.path.endsWith('.state')) {
          this.values.set(v.path, { value: v.value, send: this.sends })
        }
      }
    }
  }

  private read(path: string): unknown {
    const r = this.values.get(path)
    return r && this.sends - r.send <= FRESH_FOR_SENDS ? r.value : undefined
  }

  /** the zone a value puts its path in, holding a raised alarm until it is past the margin */
  private judge(path: string, band: AlarmBand): Alarm | undefined {
    if (band.whileStarted && this.read(band.whileStarted) !== 'started')
      return undefined
    const value = this.read(path)
    if (typeof value !== 'number') return undefined
    const held = this.notified.get(`notifications.${path}`)?.state
    let raw: AlarmZone | undefined
    let kept: AlarmZone | undefined
    for (const z of band.zones) {
      const severity = SEVERITY[z.state]
      if (severity === 0) continue
      if (within(z, value, 0) && (!raw || severity > SEVERITY[raw.state]))
        raw = z
      if (
        held !== undefined &&
        severity <= SEVERITY[held] &&
        within(z, value, band.margin) &&
        (!kept || severity > SEVERITY[kept.state])
      )
        kept = z
    }
    const zone =
      kept && (!raw || SEVERITY[kept.state] > SEVERITY[raw.state]) ? kept : raw
    return zone && { state: zone.state, message: zone.message }
  }

  /** every alarm raised now, by its notification path */
  private alarms(others: Map<string, Alarm>): Map<string, Alarm> {
    const out = new Map<string, Alarm>()
    for (const [path, band] of this.bands) {
      const a = this.judge(path, band)
      if (a) out.set(`notifications.${path}`, a)
    }
    for (const [path, a] of others) out.set(path, a)
    return out
  }

  /** the alarms on now, as last sent */
  active(): ({ path: string } & NotificationValue)[] {
    return [...this.notified].map(([path, n]) => ({ path, ...n }))
  }

  /**
   * The notifications that have changed since the last call: each alarm raised or changed,
   * and each one that has cleared, sent once as `normal`. `others` are the alarms no zone
   * can know, by notification path. `all` sends every one raised, as after a restart, when
   * the server may not have them.
   */
  notifications(
    sentAtMs: number,
    source: Delta['updates'][number]['source'],
    others: Map<string, Alarm>,
    all = false
  ): Delta | undefined {
    const now = this.alarms(others)
    this.sends++
    const values: { path: string; value: NotificationValue }[] = []
    for (const [path, a] of now) {
      const before = this.notified.get(path)
      if (all || before?.state !== a.state || before.message !== a.message) {
        const value = {
          state: a.state,
          method: methodFor(a.state),
          message: a.message
        }
        values.push({ path, value })
        this.notified.set(path, value)
      }
    }
    for (const [path, before] of this.notified) {
      if (now.has(path)) continue
      values.push({
        path,
        value: { state: 'normal', method: [], message: before.message }
      })
      this.notified.delete(path)
    }
    if (!values.length) return undefined
    return {
      context: 'vessels.self',
      updates: [{ source, timestamp: new Date(sentAtMs).toISOString(), values }]
    }
  }
}
