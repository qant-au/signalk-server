import {
  OWN_CONTEXT,
  POSITION,
  RECORD_STEP_MS,
  RecordRow,
  RecordValue,
  RunRecord
} from './record'
import { SOURCE_LABEL } from '../soak/deltas'

/**
 * The run's record as the server's History API asks for it (`HistoryApi` in
 * packages/server-api/src/history.ts): values over a time range bucketed at a resolution
 * and aggregated, the contexts heard and the paths sent. The types below are the parts of
 * the API's own this provider reads; the server hands times over as Temporal instants and
 * durations, of which only the fields named here are used.
 *
 * Time is the scenario's: a range with no end ends at the scenario time the run has
 * reached, so `duration=PT1H` is the run's last hour.
 */
export interface Instant {
  epochMilliseconds: number
}
/** a Temporal.Duration's fields, or a number of seconds */
export type Duration =
  | number
  | {
      years?: number
      months?: number
      weeks?: number
      days?: number
      hours?: number
      minutes?: number
      seconds?: number
      milliseconds?: number
      microseconds?: number
      nanoseconds?: number
    }
export interface TimeRange {
  from?: Instant
  to?: Instant
  duration?: Duration
}
export type Aggregate =
  | 'average'
  | 'min'
  | 'max'
  | 'first'
  | 'last'
  | 'mid'
  | 'middle_index'
  | 'sma'
  | 'ema'
export interface PathSpec {
  path: string
  aggregate: Aggregate
  parameter: string[]
  sourceRef?: string
}
export interface ValuesRequest extends TimeRange {
  context?: string
  resolution?: number
  sourcePolicy?: 'all'
  pathSpecs: PathSpec[]
}
export interface ValuesResponse {
  context: string
  range: { from: string; to: string }
  values: { path: string; method: Aggregate; $source?: string }[]
  data: [string, ...RecordValue[]][]
}

export interface HistoryProviderOptions {
  /** the context the server knows the own vessel by, `vessels.urn:...` */
  selfContext: string
  /** the scenario time the run has reached */
  nowMs: () => number
  /** a path's units, from the server's metadata; `rad` paths are averaged round the circle */
  unitsOf: (path: string) => string | undefined
}

const DEFAULT_SMA_SAMPLES = 5
const DEFAULT_EMA_ALPHA = 0.2
/** samples whose unit vectors sum to less than this have no mean direction */
const NO_DIRECTION = 1e-9
const MS = {
  weeks: 7 * 86400e3,
  days: 86400e3,
  hours: 3600e3,
  minutes: 60e3,
  seconds: 1e3,
  milliseconds: 1,
  microseconds: 1e-3,
  nanoseconds: 1e-6
} as const

export function durationMs(d: Duration): number {
  if (typeof d === 'number') return d * 1000
  if (d.years || d.months) {
    throw new Error('a duration in years or months has no fixed length')
  }
  let ms = 0
  for (const [unit, each] of Object.entries(MS)) {
    ms += (d[unit as keyof typeof MS] ?? 0) * each
  }
  return ms
}

/** a time range in scenario milliseconds, from inclusive and to exclusive */
function rangeMs(q: TimeRange, nowMs: number): { from: number; to: number } {
  const span = q.duration === undefined ? undefined : durationMs(q.duration)
  if (q.from && q.to) {
    return { from: q.from.epochMilliseconds, to: q.to.epochMilliseconds }
  }
  if (q.from) {
    const from = q.from.epochMilliseconds
    return { from, to: span === undefined ? nowMs : from + span }
  }
  const to = q.to?.epochMilliseconds ?? nowMs
  if (span === undefined) throw new Error('a range needs a from or a duration')
  return { from: to - span, to }
}

export class RecordHistory {
  constructor(
    private readonly record: () => RunRecord,
    private readonly options: HistoryProviderOptions
  ) {}

  /** whether a context is the own vessel: by default, `vessels.self` or the server's own */
  private isOwn(context: string | undefined): boolean {
    return (
      context === undefined ||
      context === OWN_CONTEXT ||
      context === this.options.selfContext
    )
  }

  async getValues(q: ValuesRequest): Promise<ValuesResponse> {
    const { from, to } = rangeMs(q, this.endMs())
    const own = this.isOwn(q.context)
    const rows = own
      ? this.record().ownRows(from, to)
      : this.record().targetRows(q.context!, from, to)
    // the record's rows are ten seconds apart, so no bucket is narrower
    const stepMs = Math.max(RECORD_STEP_MS, (q.resolution ?? 0) * 1000)
    const buckets = Math.max(0, Math.ceil((to - from) / stepMs))
    const columns = q.pathSpecs.map((spec) =>
      this.column(spec, rows, from, stepMs, buckets)
    )
    const data: ValuesResponse['data'] = []
    for (let b = 0; b < buckets; b++) {
      data.push([
        new Date(from + b * stepMs).toISOString(),
        ...columns.map((c) => c[b])
      ])
    }
    return {
      context: own ? this.options.selfContext : q.context!,
      range: {
        from: new Date(from).toISOString(),
        to: new Date(to).toISOString()
      },
      values: q.pathSpecs.map((s) => {
        const source =
          s.sourceRef ?? (q.sourcePolicy === 'all' ? SOURCE_LABEL : undefined)
        return source === undefined
          ? { path: s.path, method: s.aggregate }
          : { path: s.path, method: s.aggregate, $source: source }
      }),
      data
    }
  }

  async getContexts(q: TimeRange): Promise<string[]> {
    const { from, to } = rangeMs(q, this.endMs())
    const own = this.record().hasOwn(from, to) ? [this.options.selfContext] : []
    return [...own, ...this.record().targets(from, to)]
  }

  async getPaths(q: TimeRange & { context?: string }): Promise<string[]> {
    const { from, to } = rangeMs(q, this.endMs())
    return this.isOwn(q.context)
      ? this.record().ownPaths(from, to)
      : this.record().targetPaths(q.context!, from, to)
  }

  /**
   * A range with no end ends at the scenario time reached, and a little past it, so the
   * row the run has just written falls inside
   */
  private endMs(): number {
    return (
      Math.floor(this.options.nowMs() / RECORD_STEP_MS) * RECORD_STEP_MS +
      RECORD_STEP_MS
    )
  }

  private column(
    spec: PathSpec,
    rows: RecordRow[],
    from: number,
    stepMs: number,
    buckets: number
  ): RecordValue[] {
    const out: RecordValue[] = new Array(buckets).fill(null)
    // a source other than this plugin's has sent nothing here
    if (spec.sourceRef && !spec.sourceRef.startsWith(SOURCE_LABEL)) return out
    const grouped: RecordValue[][] = Array.from({ length: buckets }, () => [])
    for (const row of rows) {
      const b = Math.floor((row.ms - from) / stepMs)
      const v = row.value(spec.path)
      if (b >= 0 && b < buckets && v !== null) grouped[b].push(v)
    }
    const angle = this.options.unitsOf(spec.path) === 'rad'
    if (spec.path === POSITION) {
      const lon = aggregate(
        grouped.map((g) => g.map((v) => (v as [number, number])[0])),
        spec,
        false
      )
      const lat = aggregate(
        grouped.map((g) => g.map((v) => (v as [number, number])[1])),
        spec,
        false
      )
      return lon.map((x, i) =>
        x === null || lat[i] === null ? null : [x, lat[i]!]
      )
    }
    return aggregate(grouped as number[][], spec, angle)
  }
}

/** each bucket's samples, oldest first, aggregated as the spec asks */
export function aggregate(
  buckets: number[][],
  spec: Pick<PathSpec, 'aggregate' | 'parameter'>,
  angle: boolean
): (number | null)[] {
  const mean = (xs: number[]): number | null =>
    angle ? circularMean(xs) : xs.reduce((a, b) => a + b, 0) / xs.length
  switch (spec.aggregate) {
    case 'sma': {
      const n = positiveInt(spec.parameter[0]) ?? DEFAULT_SMA_SAMPLES
      const window: number[] = []
      return buckets.map((xs) => {
        const m = xs.length ? mean(xs) : null
        if (m === null) return null
        window.push(m)
        if (window.length > n) window.shift()
        return angle ? circularMean(window) : mean(window)
      })
    }
    case 'ema': {
      const a = fraction(spec.parameter[0]) ?? DEFAULT_EMA_ALPHA
      let e: number | null = null
      let es = 0
      let ec = 0
      return buckets.map((xs) => {
        const m = xs.length ? mean(xs) : null
        if (m === null) return null
        if (angle) {
          // smoothed on the unit circle, so it never swings the long way round
          es = e === null ? Math.sin(m) : a * Math.sin(m) + (1 - a) * es
          ec = e === null ? Math.cos(m) : a * Math.cos(m) + (1 - a) * ec
          e = inConvention(Math.atan2(es, ec), m < 0)
        } else {
          e = e === null ? m : a * m + (1 - a) * e
        }
        return e
      })
    }
    default:
      return buckets.map((xs) =>
        xs.length ? one(xs, spec.aggregate, mean) : null
      )
  }
}

function one(
  xs: number[],
  method: Aggregate,
  mean: (xs: number[]) => number | null
): number | null {
  switch (method) {
    case 'average':
      return mean(xs)
    case 'min':
      return Math.min(...xs)
    case 'max':
      return Math.max(...xs)
    case 'first':
      return xs[0]
    case 'last':
      return xs[xs.length - 1]
    case 'mid':
      return (Math.min(...xs) + Math.max(...xs)) / 2
    case 'middle_index':
      return xs[Math.floor(xs.length / 2)]
    default:
      return mean(xs)
  }
}

/**
 * The angle of the mean sine and cosine, in the samples' own convention: (−π, π] when
 * any is negative, else [0, 2π); none when they cancel
 */
export function circularMean(xs: number[]): number | null {
  let s = 0
  let c = 0
  for (const x of xs) {
    s += Math.sin(x)
    c += Math.cos(x)
  }
  if (Math.hypot(s, c) < NO_DIRECTION * xs.length) return null
  return inConvention(
    Math.atan2(s, c),
    xs.some((x) => x < 0)
  )
}

function inConvention(a: number, signed: boolean): number {
  if (signed) return a
  const turned = a < 0 ? a + 2 * Math.PI : a
  // a hair below north rounds up to a whole turn, which is north
  return turned >= 2 * Math.PI ? 0 : turned
}

function positiveInt(s: string | undefined): number | undefined {
  const n = Number(s)
  return Number.isInteger(n) && n > 0 ? n : undefined
}

function fraction(s: string | undefined): number | undefined {
  const n = Number(s)
  return s !== undefined && n > 0 && n <= 1 ? n : undefined
}
