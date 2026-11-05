import { readFileSync } from 'fs'
import path from 'path'
import { Field, Series, Station, WeatherSource, loadStations } from './sources'

/**
 * The weather and water level at a place and time, from a sample's stations.
 *
 * In time, each station's series is read linearly between the readings either side; a
 * station counts only inside its own record and not across a gap of more than
 * `MAX_GAP_MS` in it, and its weight fades in and out over the first and last hour of
 * its record, so a station whose record starts or ends mid-run hands over without a step.
 *
 * In place, the stations that count are combined by inverse distance squared, the wind
 * and the current as vectors. A boat within `AT_STATION_M` of one reads that station alone; beyond the
 * stations' spread the nearest dominates, so the values never run past what was measured.
 *
 * Past the edges in time, where no station's record reaches, every station holds its
 * first or last reading, combined the same way: the weather carries on as it last was.
 */
export interface Conditions {
  windKn?: number
  /** the direction the wind comes from, degrees true */
  windDeg?: number
  gustKn?: number
  pressurePa?: number
  airC?: number
  waterC?: number
  humidity?: number
  waveHeightM?: number
  /** the water level above the depth grid's datum, to add to the grid's depth */
  waterLevelM?: number
  tide?: TideNow
  /** the tidal or ocean current: its speed, and the direction it runs towards, degrees true */
  currentKn?: number
  currentToDeg?: number
}

export interface TideNow {
  /** the height above chart datum now */
  heightM: number
  /** the next high and low water, from the predictions, while they reach that far */
  high?: { heightM: number; ms: number }
  low?: { heightM: number; ms: number }
}

export interface WeatherConfig {
  sources: WeatherSource[]
  /** the chart datum tide heights are given above, and the depth grid's datum */
  tide?: { chartDatum?: string; gridDatum: string }
}

/** a gap in a station's record longer than this is not read across */
const MAX_GAP_MS = 4 * 3600 * 1000
/** a station's weight fades over this much at each end of its record */
const EDGE_FADE_MS = 3600 * 1000
/** a boat this close to a station reads it alone */
export const AT_STATION_M = 100
const METRES_PER_DEG = (6371000 * Math.PI) / 180
/** the predictions are searched this far ahead for the next high and low water */
const TIDE_LOOKAHEAD_MS = 26 * 3600 * 1000
const TIDE_STEP_MS = 6 * 60 * 1000

/** a station's reading at a time, and how much it counts, or undefined outside its record */
function read(
  s: Series,
  ms: number,
  hold: boolean
): { v: number; w: number } | undefined {
  const n = s.ms.length
  if (!n) return undefined
  const first = s.ms[0]
  const last = s.ms[n - 1]
  if (ms <= first || ms >= last) {
    if (hold) return { v: ms <= first ? s.v[0] : s.v[n - 1], w: 1 }
    if (ms === first) return { v: s.v[0], w: 0 }
    if (ms === last) return { v: s.v[n - 1], w: 0 }
    return undefined
  }
  let lo = 0
  let hi = n - 1
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1
    if (s.ms[mid] <= ms) lo = mid
    else hi = mid
  }
  const t0 = s.ms[lo]
  const t1 = s.ms[hi]
  if (t1 - t0 > MAX_GAP_MS) return undefined
  const f = (ms - t0) / (t1 - t0)
  const v = s.v[lo] + (s.v[hi] - s.v[lo]) * f
  const w = hold
    ? 1
    : Math.min(1, (ms - first) / EDGE_FADE_MS, (last - ms) / EDGE_FADE_MS)
  return { v, w }
}

export class Environment {
  private readonly byField = new Map<Field, Station[]>()
  private tideCache?: {
    bucket: number
    high?: TideNow['high']
    low?: TideNow['low']
  }

  constructor(
    readonly stations: Station[],
    readonly config: WeatherConfig = { sources: [] },
    /** optional sources whose files were not there */
    readonly missing: string[] = []
  ) {
    for (const st of stations) {
      for (const f of Object.keys(st.series) as Field[]) {
        if (!this.byField.has(f)) this.byField.set(f, [])
        this.byField.get(f)!.push(st)
      }
    }
  }

  has(field: Field): boolean {
    return this.byField.has(field)
  }

  /** the time the sample's records cover, from the first reading of any to the last */
  span(): { startMs: number; endMs: number } | undefined {
    let startMs = Infinity
    let endMs = -Infinity
    for (const st of this.stations) {
      for (const s of Object.values(st.series)) {
        if (!s.ms.length) continue
        startMs = Math.min(startMs, s.ms[0])
        endMs = Math.max(endMs, s.ms[s.ms.length - 1])
      }
    }
    return Number.isFinite(startMs) ? { startMs, endMs } : undefined
  }

  /** one quantity at a place and time, or undefined where the sample has none of it */
  value(
    field: Field,
    lat: number,
    lon: number,
    ms: number
  ): number | undefined {
    const stations = this.byField.get(field)
    if (!stations) return undefined
    return (
      this.combine(stations, field, lat, lon, ms, false) ??
      this.combine(stations, field, lat, lon, ms, true)
    )
  }

  private combine(
    stations: Station[],
    field: Field,
    lat: number,
    lon: number,
    ms: number,
    hold: boolean
  ): number | undefined {
    const cos = Math.cos((lat * Math.PI) / 180)
    let sum = 0
    let weights = 0
    for (const st of stations) {
      const r = read(st.series[field]!, ms, hold)
      if (!r || r.w <= 0) continue
      const d = Math.hypot(
        (st.lat - lat) * METRES_PER_DEG,
        (st.lon - lon) * METRES_PER_DEG * cos
      )
      if (d < AT_STATION_M) return r.v
      const w = r.w / (d * d)
      sum += w * r.v
      weights += w
    }
    return weights > 0 ? sum / weights : undefined
  }

  /** everything the sample has at a place and time */
  at(lat: number, lon: number, ms: number): Conditions {
    const v = (f: Field) => this.value(f, lat, lon, ms)
    const e = v('windE')
    const n = v('windN')
    const tideM = v('tideM')
    const ce = v('currentE')
    const cn = v('currentN')
    return {
      windKn: e === undefined || n === undefined ? undefined : Math.hypot(e, n),
      windDeg:
        e === undefined || n === undefined ? undefined : bearingDeg(e, n),
      gustKn: v('gustKn'),
      pressurePa: v('pressurePa'),
      airC: v('airC'),
      waterC: v('waterC'),
      humidity: v('humidity'),
      waveHeightM: v('waveHeightM'),
      waterLevelM: v('waterLevelM'),
      currentKn:
        ce === undefined || cn === undefined ? undefined : Math.hypot(ce, cn),
      currentToDeg:
        ce === undefined || cn === undefined ? undefined : bearingDeg(ce, cn),
      tide:
        tideM === undefined
          ? undefined
          : { heightM: tideM, ...this.nextHighLow(lat, lon, ms) }
    }
  }

  /**
   * The next high and low water in the predictions, as the boat's tide table gives them:
   * worked out once every six minutes, and none past the end of the predictions.
   */
  private nextHighLow(
    lat: number,
    lon: number,
    ms: number
  ): Pick<TideNow, 'high' | 'low'> {
    const stations = this.byField.get('tidePredictionM')
    if (!stations) return {}
    const bucket = Math.floor(ms / TIDE_STEP_MS)
    if (this.tideCache?.bucket === bucket) {
      return { high: this.tideCache.high, low: this.tideCache.low }
    }
    const at = (t: number) =>
      this.combine(stations, 'tidePredictionM', lat, lon, t, false)
    let high: TideNow['high']
    let low: TideNow['low']
    let before = at(ms)
    let now = at(ms + TIDE_STEP_MS)
    for (
      let t = ms + 2 * TIDE_STEP_MS;
      t <= ms + TIDE_LOOKAHEAD_MS && (!high || !low);
      t += TIDE_STEP_MS
    ) {
      const after = at(t)
      if (before === undefined || now === undefined || after === undefined)
        break
      if (!high && now > before && now >= after)
        high = { heightM: now, ms: t - TIDE_STEP_MS }
      if (!low && now < before && now <= after)
        low = { heightM: now, ms: t - TIDE_STEP_MS }
      before = now
      now = after
    }
    this.tideCache = { bucket, high, low }
    return { high, low }
  }
}

/** the bearing of a vector east and north, degrees true */
const bearingDeg = (e: number, n: number) =>
  ((((Math.atan2(e, n) * 180) / Math.PI) % 360) + 360) % 360

/** a sample's environment from its `sample.json`, or undefined when it lists no weather */
export function loadEnvironment(sampleDir: string): Environment | undefined {
  const sample = JSON.parse(
    readFileSync(path.join(sampleDir, 'sample.json'), 'utf8')
  ) as { weather?: WeatherConfig }
  if (!sample.weather) return undefined
  const { stations, missing } = loadStations(sampleDir, sample.weather.sources)
  return new Environment(stations, sample.weather, missing)
}
