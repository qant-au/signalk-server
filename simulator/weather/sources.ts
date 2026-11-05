import { existsSync, readFileSync } from 'fs'
import path from 'path'

/**
 * The weather and water level a sample ships, read from the files its `sample.json` lists
 * under `weather.sources`. Each source becomes one or more stations: a position and, for
 * each quantity it measures, a time series. Values a file marks as missing are left out,
 * never filled in.
 */
export type Field =
  /** the wind as a vector towards where it comes from, knots east and north */
  | 'windE'
  | 'windN'
  | 'gustKn'
  | 'pressurePa'
  | 'airC'
  | 'waterC'
  /** relative humidity, 0 to 1 */
  | 'humidity'
  | 'waveHeightM'
  /** the water level above chart datum, observed where there are observations, else predicted */
  | 'tideM'
  /** the predicted tide above chart datum */
  | 'tidePredictionM'
  /** the water level above the depth grid's datum */
  | 'waterLevelM'
  /** the tidal or ocean current as a vector towards where it runs, knots east and north */
  | 'currentE'
  | 'currentN'

export interface Series {
  ms: number[]
  v: number[]
}

export interface Station {
  id: string
  name: string
  lat: number
  lon: number
  series: Partial<Record<Field, Series>>
}

/** what a source contributes; a source's file may carry more than the sample uses */
export type Quantity =
  | 'wind'
  | 'pressure'
  | 'air'
  | 'water'
  | 'humidity'
  | 'waves'
  | 'tide'
  | 'waterLevel'
  | 'current'

export interface WeatherSource {
  format: 'ndbc' | 'coops' | 'open-meteo' | 'qld-buoy' | 'gfs-csv'
  /** the file, or for CO-OPS a pattern with `{product}` for each of its files */
  file: string
  /** what this source gives the run */
  use: Quantity[]
  /** a station's name and position, for the formats whose files do not carry them */
  station?: { id: string; name: string; lat: number; lon: number }
  /** CO-OPS: how far the depth grid's datum lies above the station's chart datum, metres */
  gridDatumAboveChartDatumM?: number
  /** QLD buoys: the hours their local times are ahead of UTC */
  utcOffsetHours?: number
  /** a source the user downloads, which the run does without when it is not there */
  optional?: boolean
}

const KN_PER_MS = 3600 / 1852
const KN_PER_KMH = 1000 / 1852
const PA_PER_HPA = 100
const KELVIN = 273.15

class Builder {
  readonly series: Partial<Record<Field, Series>> = {}

  add(field: Field, ms: number, v: number | undefined): void {
    if (v === undefined || !Number.isFinite(v) || !Number.isFinite(ms)) return
    const s = (this.series[field] ??= { ms: [], v: [] })
    s.ms.push(ms)
    s.v.push(v)
  }

  wind(ms: number, kn: number | undefined, fromDeg: number | undefined): void {
    if (kn === undefined || fromDeg === undefined) return
    const r = (fromDeg * Math.PI) / 180
    this.add('windE', ms, kn * Math.sin(r))
    this.add('windN', ms, kn * Math.cos(r))
  }

  /** a current running towards `toDeg` at `kn` */
  current(ms: number, kn: number | undefined, toDeg: number | undefined): void {
    if (kn === undefined || toDeg === undefined) return
    const r = (toDeg * Math.PI) / 180
    this.add('currentE', ms, kn * Math.sin(r))
    this.add('currentN', ms, kn * Math.cos(r))
  }

  /** each series in time order, as the files give them or not */
  done(): Partial<Record<Field, Series>> {
    for (const s of Object.values(this.series)) {
      const order = s.ms.map((_, i) => i).sort((a, b) => s.ms[a] - s.ms[b])
      s.ms = order.map((i) => s.ms[i])
      s.v = order.map((i) => s.v[i])
    }
    return this.series
  }
}

/** a number, or undefined for a blank or one of the file's missing-value markers */
function num(
  text: string | undefined,
  missing: number[] = []
): number | undefined {
  if (text === undefined || text.trim() === '') return undefined
  const v = Number(text)
  return Number.isFinite(v) && !missing.includes(v) ? v : undefined
}

const lines = (file: string) =>
  readFileSync(file, 'utf8')
    .split(/\r?\n/)
    .filter((l) => l.trim() !== '')

/** NDBC standard meteorological text: two header lines, whitespace separated, UTC */
function ndbc(file: string, use: Set<Quantity>): Builder {
  const b = new Builder()
  const [names] = lines(file)
  const cols = names.replace(/^#/, '').trim().split(/\s+/)
  const at = (row: string[], name: string) => row[cols.indexOf(name)]
  for (const line of lines(file)) {
    if (line.startsWith('#')) continue
    const row = line.trim().split(/\s+/)
    const ms = Date.UTC(
      Number(at(row, 'YY')),
      Number(at(row, 'MM')) - 1,
      Number(at(row, 'DD')),
      Number(at(row, 'hh')),
      Number(at(row, 'mm'))
    )
    if (use.has('wind')) {
      const speed = num(at(row, 'WSPD'), [99])
      b.wind(
        ms,
        speed === undefined ? undefined : speed * KN_PER_MS,
        num(at(row, 'WDIR'), [999])
      )
      const gust = num(at(row, 'GST'), [99])
      b.add('gustKn', ms, gust === undefined ? undefined : gust * KN_PER_MS)
    }
    if (use.has('pressure')) {
      const hpa = num(at(row, 'PRES'), [9999])
      b.add('pressurePa', ms, hpa === undefined ? undefined : hpa * PA_PER_HPA)
    }
    if (use.has('air')) b.add('airC', ms, num(at(row, 'ATMP'), [999]))
    if (use.has('water')) b.add('waterC', ms, num(at(row, 'WTMP'), [999]))
    if (use.has('waves')) b.add('waveHeightM', ms, num(at(row, 'WVHT'), [99]))
  }
  return b
}

/** a CO-OPS CSV: a header line, then `YYYY-MM-DD HH:MM` in GMT and the values */
function coopsRows(file: string): { ms: number; cells: string[] }[] {
  return lines(file)
    .slice(1)
    .map((line) => {
      const cells = line.split(',')
      return { ms: Date.parse(cells[0].replace(' ', 'T') + 'Z'), cells }
    })
}

function coops(
  source: WeatherSource,
  dir: string,
  use: Set<Quantity>
): Builder {
  const b = new Builder()
  const file = (product: string) =>
    path.join(dir, source.file.replace('{product}', product))
  if (use.has('wind')) {
    for (const { ms, cells } of coopsRows(file('wind'))) {
      const speed = num(cells[1])
      b.wind(
        ms,
        speed === undefined ? undefined : speed * KN_PER_MS,
        num(cells[2])
      )
      const gust = num(cells[4])
      b.add('gustKn', ms, gust === undefined ? undefined : gust * KN_PER_MS)
    }
  }
  if (use.has('pressure')) {
    for (const { ms, cells } of coopsRows(file('air_pressure'))) {
      const hpa = num(cells[1])
      b.add('pressurePa', ms, hpa === undefined ? undefined : hpa * PA_PER_HPA)
    }
  }
  if (use.has('tide') || use.has('waterLevel')) {
    const offset = source.gridDatumAboveChartDatumM ?? 0
    const predicted = new Map<number, number>()
    for (const { ms, cells } of coopsRows(file('predictions'))) {
      const v = num(cells[1])
      if (v === undefined) continue
      predicted.set(ms, v)
      b.add('tidePredictionM', ms, v)
    }
    const observed = new Map<number, number>()
    for (const { ms, cells } of coopsRows(file('water_level'))) {
      const v = num(cells[1])
      if (v !== undefined) observed.set(ms, v)
    }
    // the observations where there are any, the predictions where they run out
    const times = [...new Set([...observed.keys(), ...predicted.keys()])]
    for (const ms of times) {
      const v = observed.get(ms) ?? predicted.get(ms)!
      if (use.has('tide')) b.add('tideM', ms, v)
      if (use.has('waterLevel')) b.add('waterLevelM', ms, v - offset)
    }
  }
  if (use.has('current')) {
    // the predicted current along its major axis, knots: flood positive, towards the
    // flood direction, ebb negative, towards the ebb direction
    for (const { ms, cells } of coopsRows(file('currents_predictions'))) {
      const v = num(cells[2])
      if (v === undefined) continue
      b.current(ms, Math.abs(v), num(v >= 0 ? cells[3] : cells[4]))
    }
  }
  return b
}

interface OpenMeteoPoint {
  latitude: number
  longitude: number
  hourly: Record<string, (number | null)[] | string[]>
}

/** Open-Meteo JSON: one object per point, or an array of them; times in GMT */
function openMeteo(file: string, use: Set<Quantity>, id: string): Station[] {
  const json = JSON.parse(readFileSync(file, 'utf8')) as
    OpenMeteoPoint | OpenMeteoPoint[]
  const points = Array.isArray(json) ? json : [json]
  return points.map((p, i) => {
    const b = new Builder()
    const h = p.hourly
    const col = (name: string) => h[name] as (number | null)[] | undefined
    const times = (h.time as string[]).map((t) => Date.parse(t + 'Z'))
    times.forEach((ms, k) => {
      const v = (name: string) => col(name)?.[k] ?? undefined
      if (use.has('wind')) {
        b.wind(ms, v('wind_speed_10m'), v('wind_direction_10m'))
        b.add('gustKn', ms, v('wind_gusts_10m'))
      }
      if (use.has('pressure')) {
        const hpa = v('pressure_msl')
        b.add(
          'pressurePa',
          ms,
          hpa === undefined ? undefined : hpa * PA_PER_HPA
        )
      }
      if (use.has('air')) b.add('airC', ms, v('temperature_2m'))
      if (use.has('humidity')) {
        const rh = v('relative_humidity_2m')
        b.add('humidity', ms, rh === undefined ? undefined : rh / 100)
      }
      if (use.has('water')) b.add('waterC', ms, v('sea_surface_temperature'))
      if (use.has('waves')) b.add('waveHeightM', ms, v('wave_height'))
      if (use.has('waterLevel'))
        b.add('waterLevelM', ms, v('sea_level_height_msl'))
      if (use.has('current')) {
        // the direction the current runs towards
        const kmh = v('ocean_current_velocity')
        b.current(
          ms,
          kmh === undefined ? undefined : kmh * KN_PER_KMH,
          v('ocean_current_direction')
        )
      }
    })
    return {
      id: `${id}#${i}`,
      name: `${id} point ${i + 1}`,
      lat: p.latitude,
      lon: p.longitude,
      series: b.done()
    }
  })
}

/** Queensland Coastal Data System wave buoy CSV, local times */
function qldBuoy(
  source: WeatherSource,
  file: string,
  use: Set<Quantity>
): Builder {
  const b = new Builder()
  const [header, ...rows] = lines(file)
  const cols = header.split(',')
  const at = (cells: string[], prefix: string) =>
    cells[cols.findIndex((c) => c.startsWith(prefix))]
  const offsetMs = (source.utcOffsetHours ?? 0) * 3600000
  for (const row of rows) {
    const cells = row.split(',')
    const ms = Date.parse(cells[0] + 'Z') - offsetMs
    if (use.has('waves'))
      b.add('waveHeightM', ms, num(at(cells, 'Hs'), [-99.9]))
    if (use.has('water')) b.add('waterC', ms, num(at(cells, 'SST'), [-99.9]))
  }
  return b
}

/** the Piraeus dataset's GFS fields: one row per grid point and time, SI units, UTC */
function gfsCsv(file: string, use: Set<Quantity>, id: string): Station[] {
  const [header, ...rows] = lines(file)
  const cols = header.split(',')
  const at = (cells: string[], name: string) => num(cells[cols.indexOf(name)])
  const byPoint = new Map<string, { lat: number; lon: number; b: Builder }>()
  for (const row of rows) {
    const cells = row.split(',')
    const lat = at(cells, 'lat')!
    const lon = at(cells, 'lon')!
    const key = `${lat.toFixed(4)},${lon.toFixed(4)}`
    if (!byPoint.has(key)) byPoint.set(key, { lat, lon, b: new Builder() })
    const { b } = byPoint.get(key)!
    const ms = Date.parse(
      cells[cols.indexOf('timestamp')].replace(' ', 'T') + 'Z'
    )
    if (use.has('wind')) {
      const speed = at(cells, 'WSPD')
      b.wind(
        ms,
        speed === undefined ? undefined : speed * KN_PER_MS,
        at(cells, 'WDIRMET')
      )
      const gust = at(cells, 'GUST')
      b.add('gustKn', ms, gust === undefined ? undefined : gust * KN_PER_MS)
    }
    if (use.has('pressure')) b.add('pressurePa', ms, at(cells, 'PRMSL'))
    if (use.has('air')) {
      const k = at(cells, 'TMP')
      b.add('airC', ms, k === undefined ? undefined : k - KELVIN)
    }
    if (use.has('humidity')) {
      const rh = at(cells, 'RH')
      b.add('humidity', ms, rh === undefined ? undefined : rh / 100)
    }
  }
  return [...byPoint.values()].map((p, i) => ({
    id: `${id}#${i}`,
    name: `${id} point ${i + 1}`,
    lat: p.lat,
    lon: p.lon,
    series: p.b.done()
  }))
}

/**
 * Every station the sample's sources give. An optional source whose file is not here is
 * listed in `missing` and left out.
 */
export function loadStations(
  sampleDir: string,
  sources: WeatherSource[]
): { stations: Station[]; missing: string[] } {
  const stations: Station[] = []
  const missing: string[] = []
  for (const source of sources) {
    const file = path.join(sampleDir, source.file)
    const probe =
      source.format === 'coops'
        ? path.join(
            sampleDir,
            source.file.replace(
              '{product}',
              source.use.includes('current')
                ? 'currents_predictions'
                : 'predictions'
            )
          )
        : file
    if (!existsSync(probe)) {
      if (source.optional) {
        missing.push(source.file)
        continue
      }
      throw new Error(`weather source ${source.file} is not in the sample`)
    }
    const use = new Set(source.use)
    const id = source.station?.id ?? path.basename(source.file)
    const one = (b: Builder): Station => ({
      id,
      name: source.station!.name,
      lat: source.station!.lat,
      lon: source.station!.lon,
      series: b.done()
    })
    switch (source.format) {
      case 'ndbc':
        stations.push(one(ndbc(file, use)))
        break
      case 'coops':
        stations.push(one(coops(source, sampleDir, use)))
        break
      case 'qld-buoy':
        stations.push(one(qldBuoy(source, file, use)))
        break
      case 'open-meteo':
        stations.push(...openMeteo(file, use, id))
        break
      case 'gfs-csv':
        stations.push(...gfsCsv(file, use, id))
        break
    }
  }
  return { stations, missing }
}
