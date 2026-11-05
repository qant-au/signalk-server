import {
  OWN_CONTEXT,
  POSITION,
  RECORD_STEP_MS,
  RecordRow,
  RunRecord
} from './record'
import { SOURCE } from '../soak/deltas'

/**
 * The record replayed through the server's older playback API: a WebSocket opened at
 * `/signalk/v1/stream?startTime=...&playbackRate=...` is handed to `streamHistory`, which
 * sends the record from that time as deltas, the own vessel's row and each target's,
 * stamped with the time they were recorded, at `playbackRate` times real time. The
 * snapshot API (`/signalk/v1/snapshot/...?time=...`) asks `getHistory` for the state at a
 * time: the own row and each target's last row at or before it, within ten minutes.
 */
export interface PlaybackOptions {
  startTime: Date
  playbackRate: number | string
  subscribe?: string
}

export interface PlaybackDelta {
  context: string
  updates: {
    source: typeof SOURCE
    timestamp: string
    values: { path: string; value: unknown }[]
  }[]
}

/** how often a playback sends what it has reached, wall milliseconds */
export const PLAYBACK_TICK_MS = 250
/** a target last heard longer ago than this before a snapshot's time is not in it */
const SNAPSHOT_TARGET_MS = 10 * 60 * 1000

export class RecordPlayback {
  constructor(
    private readonly record: () => RunRecord,
    private readonly selfContext: string,
    private readonly wallNow: () => number = Date.now,
    private readonly every: (f: () => void, ms: number) => () => void = (
      f,
      ms
    ) => {
      const t = setInterval(f, ms)
      return () => clearInterval(t)
    }
  ) {}

  /** the server's playback API spells it both ways */
  hasAnyData(
    options: PlaybackOptions,
    cb: (hasResults: boolean) => void
  ): void {
    const end = this.record().endMs
    cb(end !== undefined && end >= options.startTime.getTime())
  }

  hasAnydata(
    options: PlaybackOptions,
    cb: (hasResults: boolean) => void
  ): void {
    this.hasAnyData(options, cb)
  }

  streamHistory(
    _spark: unknown,
    options: PlaybackOptions,
    onDelta: (delta: PlaybackDelta) => void
  ): () => void {
    const rate = Number(options.playbackRate) || 1
    const startMs = options.startTime.getTime()
    const startWall = this.wallNow()
    let sentTo = startMs
    let stop: () => void = () => undefined
    const tick = () => {
      const reached = startMs + (this.wallNow() - startWall) * rate
      for (const { context, row } of this.record().allRows(sentTo, reached)) {
        onDelta(this.delta(context, row))
      }
      sentTo = Math.max(sentTo, reached)
      const end = this.record().endMs
      if (end === undefined || sentTo > end) stop()
    }
    stop = this.every(tick, PLAYBACK_TICK_MS)
    return () => stop()
  }

  getHistory(
    date: Date,
    _path: string[],
    cb: (deltas: PlaybackDelta[]) => void
  ): void {
    const at = date.getTime() + 1
    const record = this.record()
    const deltas: PlaybackDelta[] = []
    const own = record.ownRows(at - RECORD_STEP_MS * 6, at).at(-1)
    if (own) deltas.push(this.delta(OWN_CONTEXT, own))
    for (const context of record.targets(at - SNAPSHOT_TARGET_MS, at)) {
      const last = record
        .targetRows(context, at - SNAPSHOT_TARGET_MS, at)
        .at(-1)
      if (last) deltas.push(this.delta(context, last))
    }
    cb(deltas)
  }

  private delta(context: string, row: RecordRow): PlaybackDelta {
    const own = context === OWN_CONTEXT
    const paths = own
      ? this.record().ownPathNames
      : [
          POSITION,
          'navigation.speedOverGround',
          'navigation.courseOverGroundTrue'
        ]
    const values: { path: string; value: unknown }[] = []
    for (const path of paths) {
      const v = row.value(path)
      if (v === null) continue
      values.push({
        path,
        value: Array.isArray(v) ? { longitude: v[0], latitude: v[1] } : v
      })
    }
    return {
      context: own ? this.selfContext : context,
      updates: [
        { source: SOURCE, timestamp: new Date(row.ms).toISOString(), values }
      ]
    }
  }
}
