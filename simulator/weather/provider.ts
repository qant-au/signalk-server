import { Conditions, Environment } from './environment'
import { localDayStart, sunTimes } from '../systems/sun'

/**
 * The sample's weather as the server's Weather API asks for it (`WeatherProviderMethods`
 * in packages/server-api/src/weatherapi.ts), read from the same records the instruments
 * read (environment.ts), at the position asked for.
 *
 * Observations are the records at the scenario time and on each hour before it, back to
 * the start of the records, newest first. Forecasts are the records ahead of the scenario
 * time: a point forecast on each hour to the end of the records, and a daily one for each
 * local day they reach, oldest first. The forecast is as good as the record: a plotter
 * asking for tomorrow sees the weather the boat will meet. A warning is a strong wind
 * warning, wherever the record ahead has the wind at or above `STRONG_WIND_KN` for an hour
 * or more. A sample without weather answers nothing, and nothing is made up past its
 * records. The types below are the parts of the API's own this provider fills.
 */
export interface WeatherData {
  date: string
  type: 'observation' | 'point' | 'daily'
  outside?: {
    temperature?: number
    minTemperature?: number
    maxTemperature?: number
    pressure?: number
    relativeHumidity?: number
    dewPointTemperature?: number
  }
  water?: {
    temperature?: number
    level?: number
    surfaceCurrentSpeed?: number
    surfaceCurrentDirection?: number
    waveSignificantHeight?: number
  }
  wind?: { speedTrue?: number; directionTrue?: number; gust?: number }
  sun?: { sunrise?: string; sunset?: string }
}

export interface WeatherWarning {
  startTime: string
  endTime: string
  details: string
  source: string
  type: string
}

export interface WeatherReqParams {
  maxCount?: number
  startDate?: string
}

export interface Position {
  latitude: number
  longitude: number
}

export const STRONG_WIND_KN = 22
const STRONG_FOR_MS = 3600 * 1000
const WARNING_STEP_MS = 10 * 60 * 1000
const HOUR_MS = 3600 * 1000
const DAY_MS = 86400 * 1000
/** observations go back no further than this without a `maxCount` */
const OBSERVATIONS_MAX = 168
const KELVIN = 273.15
const MS_PER_KN = 1852 / 3600
const RADIANS = Math.PI / 180
/** Magnus coefficients over water, for the dew point */
const MAGNUS_B = 17.62
const MAGNUS_C = 243.12

export class SampleWeather {
  constructor(
    private readonly environment: Environment | undefined,
    /** the scenario time the run has reached */
    private readonly nowMs: () => number,
    /** the sample, named as the source of its warnings */
    private readonly source: string
  ) {}

  /** the end of the records, which the forecasts reach to, or undefined without weather */
  get forecastToMs(): number | undefined {
    return this.environment?.span()?.endMs
  }

  getObservations(
    position: Position,
    options: WeatherReqParams = {}
  ): WeatherData[] {
    const span = this.environment?.span()
    if (!span) return []
    const now = this.nowMs()
    const notBefore = Math.max(
      span.startMs,
      dateMs(options.startDate) ?? -Infinity
    )
    const times: number[] = []
    const limit = count(options.maxCount) ?? OBSERVATIONS_MAX
    const add = (t: number) => {
      if (t >= notBefore && t <= span.endMs && times.length < limit)
        times.push(t)
    }
    add(now)
    for (
      let t = Math.ceil(now / HOUR_MS) * HOUR_MS - HOUR_MS;
      t >= notBefore && times.length < limit;
      t -= HOUR_MS
    ) {
      if (t < now) add(t)
    }
    return times.map((t) => this.at(position, t, 'observation'))
  }

  getForecasts(
    position: Position,
    type: 'point' | 'daily',
    options: WeatherReqParams = {}
  ): WeatherData[] {
    const span = this.environment?.span()
    if (!span) return []
    const limit = count(options.maxCount)
    const now = this.nowMs()
    const from = Math.max(now, dateMs(options.startDate) ?? -Infinity)
    const out =
      type === 'daily'
        ? this.daily(position, from, span.endMs)
        : this.points(position, from > now ? from : now + 1, span.endMs)
    return limit === undefined ? out : out.slice(0, limit)
  }

  getWarnings(position: Position): WeatherWarning[] {
    const span = this.environment?.span()
    if (!span) return []
    const warnings: WeatherWarning[] = []
    let run: { start: number; end: number; maxKn: number } | undefined
    const close = () => {
      if (run && run.end - run.start >= STRONG_FOR_MS) {
        warnings.push({
          startTime: iso(run.start),
          endTime: iso(run.end),
          details: `Strong wind warning: wind ${STRONG_WIND_KN} kn or more, up to ${run.maxKn.toFixed(0)} kn`,
          source: this.source,
          type: 'Warning'
        })
      }
      run = undefined
    }
    for (let t = this.nowMs(); t <= span.endMs; t += WARNING_STEP_MS) {
      const kn = this.conditions(position, t).windKn
      if (kn !== undefined && kn >= STRONG_WIND_KN) {
        if (run) {
          run.end = t
          run.maxKn = Math.max(run.maxKn, kn)
        } else run = { start: t, end: t, maxKn: kn }
      } else close()
    }
    close()
    return warnings
  }

  /** a point forecast on each hour from `from`, inclusive, to `to` */
  private points(position: Position, from: number, to: number): WeatherData[] {
    const out: WeatherData[] = []
    for (let t = Math.ceil(from / HOUR_MS) * HOUR_MS; t <= to; t += HOUR_MS) {
      out.push(this.at(position, t, 'point'))
    }
    return out
  }

  /** a day's min and max temperature, its mean wind and strongest gust, and the sun */
  private daily(position: Position, from: number, to: number): WeatherData[] {
    const out: WeatherData[] = []
    const { latitude: lat, longitude: lon } = position
    for (let day = localDayStart(from, lon); day <= to; day += DAY_MS) {
      const hours: Conditions[] = []
      for (
        let t = Math.max(day, from);
        t < Math.min(day + DAY_MS, to + 1);
        t += HOUR_MS
      ) {
        hours.push(this.conditions(position, t))
      }
      if (!hours.length) continue
      const air = defined(hours.map((c) => c.airC))
      const windE = defined(hours.map((c) => windVector(c)?.[0]))
      const windN = defined(hours.map((c) => windVector(c)?.[1]))
      const speeds = defined(hours.map((c) => c.windKn))
      const gusts = defined(hours.map((c) => c.gustKn))
      const data: WeatherData = { date: iso(day), type: 'daily' }
      if (air.length) {
        data.outside = {
          minTemperature: round2(Math.min(...air) + KELVIN),
          maxTemperature: round2(Math.max(...air) + KELVIN)
        }
      }
      if (speeds.length) {
        data.wind = {
          speedTrue: round2(mean(speeds) * MS_PER_KN),
          directionTrue: round3(bearing(mean(windE), mean(windN)) * RADIANS),
          ...(gusts.length
            ? { gust: round2(Math.max(...gusts) * MS_PER_KN) }
            : {})
        }
      }
      data.sun = sun(day, lat, lon)
      out.push(data)
    }
    return out
  }

  private conditions(p: Position, ms: number): Conditions {
    return this.environment!.at(p.latitude, p.longitude, ms)
  }

  /** the records at a place and time, in SI as the data model has them */
  at(p: Position, ms: number, type: WeatherData['type']): WeatherData {
    const c = this.conditions(p, ms)
    const data: WeatherData = { date: iso(ms), type }
    const outside = clean({
      temperature: c.airC === undefined ? undefined : round2(c.airC + KELVIN),
      pressure:
        c.pressurePa === undefined ? undefined : Math.round(c.pressurePa),
      relativeHumidity:
        c.humidity === undefined ? undefined : round3(c.humidity),
      dewPointTemperature:
        c.airC === undefined || c.humidity === undefined || c.humidity <= 0
          ? undefined
          : round2(dewPointC(c.airC, c.humidity) + KELVIN)
    })
    const water = clean({
      temperature:
        c.waterC === undefined ? undefined : round2(c.waterC + KELVIN),
      level: c.tide === undefined ? undefined : round3(c.tide.heightM),
      surfaceCurrentSpeed:
        c.currentKn === undefined ? undefined : round3(c.currentKn * MS_PER_KN),
      surfaceCurrentDirection:
        c.currentToDeg === undefined
          ? undefined
          : round3(c.currentToDeg * RADIANS),
      waveSignificantHeight:
        c.waveHeightM === undefined ? undefined : round2(c.waveHeightM)
    })
    const wind = clean({
      speedTrue:
        c.windKn === undefined ? undefined : round2(c.windKn * MS_PER_KN),
      directionTrue:
        c.windDeg === undefined ? undefined : round3(c.windDeg * RADIANS),
      gust: c.gustKn === undefined ? undefined : round2(c.gustKn * MS_PER_KN)
    })
    if (outside) data.outside = outside
    if (water) data.water = water
    if (wind) data.wind = wind
    data.sun = sun(localDayStart(ms, p.longitude), p.latitude, p.longitude)
    return data
  }
}

function sun(dayStartMs: number, lat: number, lon: number): WeatherData['sun'] {
  const { sunriseMs, sunsetMs } = sunTimes(dayStartMs, lat, lon)
  return clean({
    sunrise: sunriseMs === undefined ? undefined : iso(sunriseMs),
    sunset: sunsetMs === undefined ? undefined : iso(sunsetMs)
  })
}

/** an object without its undefined fields, or undefined when none is left */
function clean<T extends object>(o: T): T | undefined {
  const entries = Object.entries(o).filter(([, v]) => v !== undefined)
  return entries.length ? (Object.fromEntries(entries) as T) : undefined
}

function windVector(c: Conditions): [number, number] | undefined {
  if (c.windKn === undefined || c.windDeg === undefined) return undefined
  return [
    c.windKn * Math.sin(c.windDeg * RADIANS),
    c.windKn * Math.cos(c.windDeg * RADIANS)
  ]
}

const bearing = (e: number, n: number) =>
  (((Math.atan2(e, n) / RADIANS) % 360) + 360) % 360

function dewPointC(airC: number, humidity: number): number {
  const g = Math.log(humidity) + (MAGNUS_B * airC) / (MAGNUS_C + airC)
  return (MAGNUS_C * g) / (MAGNUS_B - g)
}

/** a `YYYY-MM-DD` date's midnight UTC, or undefined */
function dateMs(date: string | undefined): number | undefined {
  if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return undefined
  const ms = Date.parse(`${date}T00:00:00Z`)
  return Number.isFinite(ms) ? ms : undefined
}

function count(n: number | undefined): number | undefined {
  return n !== undefined && Number.isFinite(n) && n >= 0
    ? Math.floor(n)
    : undefined
}

const defined = (xs: (number | undefined)[]) =>
  xs.filter((x): x is number => x !== undefined)
const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length
const iso = (ms: number) => new Date(ms).toISOString()
const round2 = (x: number) => Math.round(x * 100) / 100
const round3 = (x: number) => Math.round(x * 1000) / 1000
