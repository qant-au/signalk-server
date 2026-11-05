import { createWriteStream } from 'fs'
import { mkdir } from 'fs/promises'
import path from 'path'
import { createInterface } from 'readline'
import { pipeline } from 'stream/promises'
import { readDbfRecords } from './dbf'
import { listZipEntries, openZipEntry } from './zip'

export interface TimeWindow {
  start: string
  end: string
}

/** [west, south, east, north] in decimal degrees */
export type BoundingBox = [number, number, number, number]

export interface AmsaConfig extends TimeWindow {
  source: 'amsa-cts'
  archive: string
  bbox: BoundingBox
}

export interface PiraeusConfig extends TimeWindow {
  source: 'piraeus-ais'
  dynamicArchive: string
  dynamicEntry: string
  staticArchive: string
  staticEntry: string
  weatherArchive: string
  weatherEntry: string
}

export type RestrictedConfig = AmsaConfig | PiraeusConfig

const AMSA_TIMESTAMP = /^(\d{2})\/(\d{2})\/(\d{4}) (\d{2}):(\d{2}):(\d{2})/

/**
 * AMSA writes `dd/mm/yyyy HH:MM:SS` in UTC and 24-hour time, sometimes followed by
 * fractional seconds or a stray AM/PM that does not change the hour.
 */
export function parseAmsaTimestamp(text: string): number {
  const m = AMSA_TIMESTAMP.exec(text.trim())
  if (!m) {
    throw new Error(`unrecognised AMSA timestamp: ${text}`)
  }
  const [, day, month, year, hour, minute, second] = m
  return Date.UTC(+year, +month - 1, +day, +hour, +minute, +second)
}

export function inBoundingBox(
  lon: number,
  lat: number,
  bbox: BoundingBox
): boolean {
  const [west, south, east, north] = bbox
  return lon >= west && lon <= east && lat >= south && lat <= north
}

function csvLine(values: (string | number)[]): string {
  return (
    values
      .map((v) => {
        const s = String(v)
        return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
      })
      .join(',') + '\n'
  )
}

const AMSA_INNER_ARCHIVE = /^cts_srr_\d{2}_\d{4}_pt\.zip$/
const AMSA_TABLE = /\.dbf$/

export const AMSA_COLUMNS = [
  'craft_id',
  'utc',
  'lat',
  'lon',
  'sog_kn',
  'cog_deg',
  'type',
  'length_m',
  'beam_m',
  'draught_m'
]

/**
 * Cuts an AMSA Craft Tracking System monthly download to a window and an area. The
 * download is a ZIP holding a second ZIP that holds the Shapefile; only its .dbf is
 * read, because it carries the coordinates as columns.
 */
export async function prepareAmsa(
  config: AmsaConfig,
  downloadsDir: string,
  cacheDir: string,
  outputDir: string
): Promise<{ points: number; vessels: number }> {
  const outer = path.join(downloadsDir, config.archive)
  const innerName = (await listZipEntries(outer)).find((e) =>
    AMSA_INNER_ARCHIVE.test(e.name)
  )?.name
  if (!innerName) {
    throw new Error(`${outer} does not contain an AMSA cts_srr_MM_YYYY_pt.zip`)
  }

  await mkdir(cacheDir, { recursive: true })
  const inner = path.join(cacheDir, innerName)
  await pipeline(await openZipEntry(outer, innerName), createWriteStream(inner))

  const tableName = (await listZipEntries(inner)).find((e) =>
    AMSA_TABLE.test(e.name)
  )?.name
  if (!tableName) {
    throw new Error(`${inner} does not contain a .dbf table`)
  }

  const start = Date.parse(config.start)
  const end = Date.parse(config.end)
  await mkdir(outputDir, { recursive: true })
  const out = createWriteStream(path.join(outputDir, 'ais.csv'))
  out.write(csvLine(AMSA_COLUMNS))

  let points = 0
  const vessels = new Set<string>()
  for await (const r of readDbfRecords(await openZipEntry(inner, tableName))) {
    const lat = Number(r.latitude)
    const lon = Number(r.longitude)
    if (!inBoundingBox(lon, lat, config.bbox)) continue
    const time = parseAmsaTimestamp(r.timestamp)
    if (time < start || time >= end) continue
    const craft = String(Math.round(Number(r.craft_id)))
    out.write(
      csvLine([
        craft,
        new Date(time).toISOString(),
        lat,
        lon,
        Number(r.speed),
        Number(r.course),
        r.type,
        Math.round(Number(r.length)),
        Math.round(Number(r.beam)),
        Number(r.draught)
      ])
    )
    points++
    vessels.add(craft)
  }
  await new Promise<void>((resolve) => out.end(resolve))
  return { points, vessels: vessels.size }
}

/**
 * Cuts the Piraeus AIS dataset to a window: the AIS reports, the vessel types they refer
 * to, and the NOAA weather fields the dataset ships for the same month.
 */
export async function preparePiraeus(
  config: PiraeusConfig,
  downloadsDir: string,
  outputDir: string
): Promise<{ points: number; vessels: number; weatherRows: number }> {
  const start = Date.parse(config.start)
  const end = Date.parse(config.end)
  await mkdir(outputDir, { recursive: true })

  const ais = createWriteStream(path.join(outputDir, 'ais.csv'))
  const lines = createInterface({
    input: await openZipEntry(
      path.join(downloadsDir, config.dynamicArchive),
      config.dynamicEntry
    ),
    crlfDelay: Infinity
  })
  let header = true
  let points = 0
  const vessels = new Set<string>()
  for await (const line of lines) {
    if (header) {
      ais.write(line + '\n')
      header = false
      continue
    }
    const comma = line.indexOf(',')
    const time = Number(line.slice(0, comma))
    if (time < start || time >= end) continue
    ais.write(line + '\n')
    points++
    vessels.add(line.slice(comma + 1, line.indexOf(',', comma + 1)))
  }
  await new Promise<void>((resolve) => ais.end(resolve))

  await pipeline(
    await openZipEntry(
      path.join(downloadsDir, config.staticArchive),
      config.staticEntry
    ),
    createWriteStream(path.join(outputDir, 'vessels.csv'))
  )

  const weather = createWriteStream(path.join(outputDir, 'weather-gfs.csv'))
  let weatherRows = 0
  let columns: string[] | undefined
  for await (const r of readDbfRecords(
    await openZipEntry(
      path.join(downloadsDir, config.weatherArchive),
      config.weatherEntry
    )
  )) {
    const time = Date.parse(r.timestamp.replace(' ', 'T') + 'Z')
    if (time < start || time >= end) continue
    if (!columns) {
      columns = Object.keys(r).filter((k) => k !== 'timestamp_')
      weather.write(csvLine(columns))
    }
    weather.write(csvLine(columns.map((c) => r[c])))
    weatherRows++
  }
  await new Promise<void>((resolve) => weather.end(resolve))

  return { points, vessels: vessels.size, weatherRows }
}
