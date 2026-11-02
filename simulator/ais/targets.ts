import { createReadStream } from 'fs'
import { readFile } from 'fs/promises'
import path from 'path'
import { createInterface } from 'readline'
import { TargetDescription } from './reception'

/**
 * Where a sample's AIS file is and how its columns map onto a report. Each source names
 * its columns differently and only some carry ship type, length or AIS class, so the
 * mapping lives in the sample's sample.json rather than in code.
 */
export interface AisFileConfig {
  /** path relative to the sample folder */
  file: string
  idColumn: string
  timeColumn: string
  timeFormat: 'iso-utc' | 'epoch-ms'
  latColumn: string
  lonColumn: string
  sogColumn: string
  cogColumn?: string
  headingColumn?: string
  typeCodeColumn?: string
  typeTextColumn?: string
  lengthColumn?: string
  transceiverColumn?: string
  nameColumn?: string
  /** static and voyage data, where the source keeps it */
  imoColumn?: string
  callSignColumn?: string
  beamColumn?: string
  draughtColumn?: string
  destinationColumn?: string
  etaColumn?: string
  /** AIS navigational status, 0 to 15, and rate of turn in degrees a minute */
  statusColumn?: string
  rotColumn?: string
  /** the source keeps at most one report per vessel per this many seconds */
  thinnedToSeconds?: number
  /** a second file holding per-vessel details, joined on idColumn */
  vessels?: { file: string; idColumn: string; typeCodeColumn?: string }
}

export interface AisReport {
  id: string
  timeMs: number
  lat: number
  lon: number
  sogKn: number
  cogDeg?: number
  headingDeg?: number
  /** degrees a minute, positive to starboard */
  rotDegMin?: number
  /** AIS navigational status, 0 to 15 */
  navStatus?: number
  name?: string
  /** seven digits, without the "IMO" the source may prefix */
  imo?: string
  callSign?: string
  destination?: string
  /** estimated time of arrival, ms since the epoch */
  etaMs?: number
  target: TargetDescription
}

/** One CSV line, honouring double-quoted fields. */
export function parseCsvLine(line: string): string[] {
  const fields: string[] = []
  let field = ''
  let quoted = false
  for (let i = 0; i < line.length; i++) {
    const c = line[i]
    if (quoted) {
      if (c === '"' && line[i + 1] === '"') {
        field += '"'
        i++
      } else if (c === '"') {
        quoted = false
      } else {
        field += c
      }
    } else if (c === '"') {
      quoted = true
    } else if (c === ',') {
      fields.push(field)
      field = ''
    } else {
      field += c
    }
  }
  fields.push(field)
  return fields
}

export function parseTime(
  text: string,
  format: AisFileConfig['timeFormat']
): number {
  if (format === 'epoch-ms') return Number(text)
  const iso = text.includes('T') ? text : text.replace(' ', 'T')
  return Date.parse(/Z|[+-]\d\d:?\d\d$/.test(iso) ? iso : `${iso}Z`)
}

function optionalNumber(text: string | undefined): number | undefined {
  if (text === undefined || text.trim() === '') return undefined
  const n = Number(text)
  return Number.isFinite(n) ? n : undefined
}

/** AIS sends 0 for a dimension it does not have */
function optionalDimension(text: string | undefined): number | undefined {
  const n = optionalNumber(text)
  return n !== undefined && n > 0 ? n : undefined
}

function optionalText(text: string | undefined): string | undefined {
  const t = text?.trim()
  return t ? t : undefined
}

/** an IMO number's seven digits, from "IMO9395123", "IMO 9395123" or "9395123" */
function imoNumber(text: string | undefined): string | undefined {
  const digits = text?.trim().match(/^(?:IMO\s*)?(\d{7})$/i)?.[1]
  return digits && digits !== '0000000' ? digits : undefined
}

async function* csvRows(file: string): AsyncGenerator<Record<string, string>> {
  let header: string[] | undefined
  for await (const line of createInterface({
    input: createReadStream(file),
    crlfDelay: Infinity
  })) {
    if (!line) continue
    const fields = parseCsvLine(line)
    if (!header) {
      header = fields
      continue
    }
    const row: Record<string, string> = {}
    header.forEach((name, i) => {
      row[name] = fields[i]
    })
    yield row
  }
}

async function loadVesselTypes(
  sampleDir: string,
  vessels: NonNullable<AisFileConfig['vessels']>
): Promise<Map<string, number>> {
  const types = new Map<string, number>()
  if (!vessels.typeCodeColumn) return types
  for await (const row of csvRows(path.join(sampleDir, vessels.file))) {
    const code = optionalNumber(row[vessels.typeCodeColumn])
    if (code !== undefined) types.set(row[vessels.idColumn], code)
  }
  return types
}

export async function* readAisReports(
  sampleDir: string,
  config: AisFileConfig
): AsyncGenerator<AisReport> {
  const vesselTypes = config.vessels
    ? await loadVesselTypes(sampleDir, config.vessels)
    : new Map<string, number>()
  const column = (row: Record<string, string>, name?: string) =>
    name === undefined ? undefined : row[name]

  for await (const row of csvRows(path.join(sampleDir, config.file))) {
    const id = row[config.idColumn]
    yield {
      id,
      timeMs: parseTime(row[config.timeColumn], config.timeFormat),
      lat: Number(row[config.latColumn]),
      lon: Number(row[config.lonColumn]),
      sogKn: optionalNumber(row[config.sogColumn]) ?? 0,
      cogDeg: optionalNumber(column(row, config.cogColumn)),
      headingDeg: optionalNumber(column(row, config.headingColumn)),
      rotDegMin: optionalNumber(column(row, config.rotColumn)),
      navStatus: optionalNumber(column(row, config.statusColumn)),
      name: optionalText(column(row, config.nameColumn)),
      imo: imoNumber(column(row, config.imoColumn)),
      callSign: optionalText(column(row, config.callSignColumn)),
      destination: optionalText(column(row, config.destinationColumn)),
      etaMs: config.etaColumn
        ? (() => {
            const text = optionalText(row[config.etaColumn])
            const ms = text ? parseTime(text, 'iso-utc') : NaN
            return Number.isFinite(ms) ? ms : undefined
          })()
        : undefined,
      target: {
        transceiver: column(row, config.transceiverColumn),
        typeCode:
          optionalNumber(column(row, config.typeCodeColumn)) ??
          vesselTypes.get(id),
        typeText: column(row, config.typeTextColumn),
        lengthM: optionalDimension(column(row, config.lengthColumn)),
        beamM: optionalDimension(column(row, config.beamColumn)),
        draughtM: optionalDimension(column(row, config.draughtColumn))
      }
    }
  }
}

export async function loadAisConfig(sampleDir: string): Promise<AisFileConfig> {
  const sample = JSON.parse(
    await readFile(path.join(sampleDir, 'sample.json'), 'utf8')
  )
  if (!sample.ais) {
    throw new Error(`${sampleDir}/sample.json has no "ais" section`)
  }
  return sample.ais
}
