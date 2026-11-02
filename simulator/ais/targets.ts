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
  name?: string
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
      name: column(row, config.nameColumn)?.trim() || undefined,
      target: {
        transceiver: column(row, config.transceiverColumn),
        typeCode:
          optionalNumber(column(row, config.typeCodeColumn)) ??
          vesselTypes.get(id),
        typeText: column(row, config.typeTextColumn),
        lengthM: optionalNumber(column(row, config.lengthColumn))
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
