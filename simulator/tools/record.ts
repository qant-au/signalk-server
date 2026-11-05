/**
 * Records a run as the server's own data log, so a plain Signal K server with no plugin can
 * replay a sample through its file playback (bin/simulator-replay). Started by
 * bin/simulator-record.
 *
 *   npx ts-node simulator/tools/record.ts <sample> [options]
 *
 *   --start-at N   start N minutes into the route (default 0)
 *   --hours N      scenario hours to record (default to the end of the route)
 *   --no-traffic   the own boat alone
 *   --seed N       seed for the boat's systems (default 1)
 *   --out FILE     where to write (default simulator/soak/reports/<sample>-<start>.log)
 *
 * The sample runs headless through the Simulation, a tick a scenario second, and every delta
 * the boat and the targets send becomes one line in the multiplexed log format the server
 * writes (packages/streams logging.ts) and replays (providers/simple, FileStream,
 * Multiplexed): `<ms>;I;<delta JSON>`. The log is in scenario time: the clock runs at x1 from
 * the scenario's own start, so each line's ms and its delta's timestamps are the scenario's,
 * and a replay plays them back at the pace they happened. There is no multiplier for that
 * reason. The own boat's deltas carry the context `vessels.self`, which a replay puts under
 * the server's own vessel.
 *
 * The file is written beside its final name and moved into place once complete, so a
 * failed run leaves no part of a log. Exits non-zero on a failure.
 */
import {
  closeSync,
  openSync,
  renameSync,
  rmSync,
  statSync,
  writeSync
} from 'fs'
import { mkdir } from 'fs/promises'
import path from 'path'
import { Simulation } from '../engine/simulation'
import {
  DEFAULT_MIN_DEPTH_UNDER_KEEL_M,
  DEFAULT_RECEIVER_ANTENNA_HEIGHT_M,
  Scenario,
  loadScenario
} from '../engine/scenario'
import { Delta } from '../soak/deltas'

/** the plugin's tick, which the log is recorded at */
export const RECORD_TICK_MS = 1000
const DEFAULT_SEED = 1
const HOUR_MS = 3600 * 1000
/** lines written to the file at once */
const BATCH_LINES = 5000

export interface RecordOptions {
  /** scenario time to start from */
  startMs: number
  /** scenario time to stop at */
  endMs: number
  showTraffic: boolean
  seed: number
}

export interface RecordSummary {
  lines: number
  /** the deltas the Simulation sent, before any was shared across lines */
  deltas: number
  /** lines longer than `MAX_LINE_CHARS`, a single value too long to share */
  longLines: number
  ownDeltas: number
  targetDeltas: number
  /** the scenario time of the first and the last line */
  firstMs?: number
  lastMs?: number
}

/**
 * The longest line the server's file playback reads whole: its line splitter drops a
 * longer line where it straddles a read (packages/streams/src/liner.ts)
 */
export const MAX_LINE_CHARS = 2048

/** an update's values and meta, as the server reads them */
type Update = Delta['updates'][number]

const META_KEY = ',"meta":[]'

const lineOf = (ms: number, delta: Delta) => `${ms};I;${JSON.stringify(delta)}`

/**
 * A delta as lines of the server's multiplexed log, at its timestamp: one line, or where
 * that would be longer than `MAX_LINE_CHARS`, its values and meta shared across several,
 * each with the delta's context, source and timestamp. A single value longer than that is
 * given a line of its own all the same.
 */
export function logLines(delta: Delta): string[] {
  const ms = Date.parse(delta.updates[0].timestamp)
  const whole = lineOf(ms, delta)
  if (whole.length <= MAX_LINE_CHARS) return [whole]
  const lines: string[] = []
  for (const u of delta.updates) {
    let values: Update['values'] = []
    let meta: NonNullable<Update['meta']> = []
    const make = () =>
      lineOf(ms, {
        context: delta.context,
        updates: [
          {
            source: u.source,
            timestamp: u.timestamp,
            values,
            ...(meta.length ? { meta } : {})
          }
        ]
      })
    const empty = make().length
    // the line's length as it grows
    let length = empty
    // each item's cost is its own length and the comma or the meta key before it, which
    // depends on what the line holds when it goes in
    const add = (cost: () => number, put: () => void) => {
      if (values.length + meta.length && length + cost() > MAX_LINE_CHARS) {
        lines.push(make())
        values = []
        meta = []
        length = empty
      }
      length += cost()
      put()
    }
    for (const v of u.values) {
      const item = JSON.stringify(v)
      add(
        () => item.length + (values.length ? 1 : 0),
        () => values.push(v)
      )
    }
    for (const m of u.meta ?? []) {
      const item = JSON.stringify(m)
      add(
        () => item.length + (meta.length ? 1 : META_KEY.length),
        () => meta.push(m)
      )
    }
    if (values.length + meta.length) lines.push(make())
  }
  return lines
}

/**
 * Runs the scenario from `startMs` to `endMs` at x1, a tick a second, handing each line of
 * the log to `write` as it is sent.
 */
export function recordRun(
  scenario: Scenario,
  options: RecordOptions,
  write: (line: string) => void
): RecordSummary {
  const summary: RecordSummary = {
    lines: 0,
    deltas: 0,
    longLines: 0,
    ownDeltas: 0,
    targetDeltas: 0
  }
  const take = (delta: Delta) => {
    if (!delta.updates.length) return
    const ms = Date.parse(delta.updates[0].timestamp)
    summary.firstMs ??= ms
    summary.lastMs = ms
    summary.deltas++
    if (delta.context === 'vessels.self') summary.ownDeltas++
    else summary.targetDeltas++
    for (const line of logLines(delta)) {
      summary.lines++
      if (line.length > MAX_LINE_CHARS) summary.longLines++
      write(line)
    }
  }
  // the wall clock starts at the scenario's start, so at x1 the two are the same time
  const sim = new Simulation(
    scenario,
    {
      timeMultiplier: 1,
      showTraffic: options.showTraffic,
      scenarioStartMs: options.startMs,
      seed: options.seed
    },
    take,
    options.startMs
  )
  for (
    let wallMs = options.startMs + RECORD_TICK_MS;
    wallMs <= options.endMs;
    wallMs += RECORD_TICK_MS
  ) {
    sim.tick(wallMs)
  }
  return summary
}

function option(args: string[], name: string): string | undefined {
  const i = args.indexOf(name)
  return i >= 0 ? args[i + 1] : undefined
}

function numberOption(args: string[], name: string, fallback: number): number {
  const v = option(args, name)
  if (v === undefined) return fallback
  const n = Number(v)
  if (!Number.isFinite(n)) throw new Error(`${name} takes a number, not ${v}`)
  return n
}

const stamp = (ms: number) =>
  new Date(ms).toISOString().slice(0, 19).replace(/:/g, '-') + 'Z'

function sizeWords(bytes: number): string {
  return bytes >= 2 ** 20
    ? `${(bytes / 2 ** 20).toFixed(1)} MiB`
    : `${(bytes / 1024).toFixed(1)} KiB`
}

function spanWords(ms: number): string {
  const min = Math.round(ms / 60000)
  return `${Math.floor(min / 60)} h ${min % 60} min`
}

async function main() {
  const args = process.argv.slice(2)
  const sample = args[0]
  if (!sample || sample.startsWith('--')) {
    console.error(
      'usage: record.ts <sample> [--start-at N] [--hours N] [--no-traffic] [--seed N] [--out FILE]'
    )
    process.exit(2)
  }
  if (args.includes('--multiplier')) {
    throw new Error(
      'the log is in scenario time and a replay plays it at real time, so there is no multiplier'
    )
  }
  const samplesDir =
    process.env.SIGNALK_SIMULATOR_SAMPLES ??
    path.resolve(__dirname, '..', 'samples')
  const scenario = await loadScenario(samplesDir, sample, {
    minDepthUnderKeelM: DEFAULT_MIN_DEPTH_UNDER_KEEL_M,
    receiverAntennaHeightM: DEFAULT_RECEIVER_ANTENNA_HEIGHT_M
  })
  const legs = scenario.legs
  const startMs = legs[0].departMs + numberOption(args, '--start-at', 0) * 60000
  const hours = option(args, '--hours')
  const endMs =
    hours === undefined
      ? legs[legs.length - 1].arriveMs
      : startMs + numberOption(args, '--hours', 0) * HOUR_MS
  if (!(endMs > startMs))
    throw new Error('nothing to record: the run ends before it starts')
  const out = path.resolve(
    option(args, '--out') ??
      path.join(
        __dirname,
        '..',
        'soak',
        'reports',
        `${sample}-${stamp(startMs)}.log`
      )
  )
  await mkdir(path.dirname(out), { recursive: true })
  for (const note of scenario.notes) console.log(`note: ${note}`)
  console.log(
    `recording ${sample} from ${new Date(startMs).toISOString()} to ${new Date(endMs).toISOString()}${args.includes('--no-traffic') ? ', no traffic' : ''}`
  )

  const partial = `${out}.partial`
  const fd = openSync(partial, 'w')
  let batch: string[] = []
  const flush = () => {
    if (batch.length) writeSync(fd, batch.join('\n') + '\n')
    batch = []
  }
  let summary: RecordSummary
  const began = Date.now()
  try {
    summary = recordRun(
      scenario,
      {
        startMs,
        endMs,
        showTraffic: !args.includes('--no-traffic'),
        seed: numberOption(args, '--seed', DEFAULT_SEED)
      },
      (line) => {
        batch.push(line)
        if (batch.length >= BATCH_LINES) flush()
      }
    )
    flush()
    closeSync(fd)
  } catch (error) {
    closeSync(fd)
    rmSync(partial, { force: true })
    throw error
  }
  if (summary.longLines) {
    rmSync(partial, { force: true })
    throw new Error(
      `${summary.longLines} lines are longer than ${MAX_LINE_CHARS} characters, which a replay would drop`
    )
  }
  renameSync(partial, out)
  const bytes = statSync(out).size
  const span =
    summary.firstMs !== undefined && summary.lastMs !== undefined
      ? summary.lastMs - summary.firstMs
      : 0
  console.log(
    `${summary.lines} lines written for ${summary.deltas} deltas, ${summary.ownDeltas} for the own boat and ${summary.targetDeltas} for targets; ${summary.lines - summary.deltas} more lines where a delta was shared across lines of up to ${MAX_LINE_CHARS} characters`
  )
  console.log(
    `scenario span ${spanWords(span)} (${summary.firstMs === undefined ? '-' : new Date(summary.firstMs).toISOString()} to ${summary.lastMs === undefined ? '-' : new Date(summary.lastMs).toISOString()}), ${(summary.deltas / Math.max(1, span / 1000)).toFixed(1)} deltas and ${(summary.lines / Math.max(1, span / 1000)).toFixed(1)} lines a scenario second`
  )
  console.log(
    `file ${out}, ${sizeWords(bytes)}, recorded in ${((Date.now() - began) / 1000).toFixed(0)} s`
  )
}

// the tests import recordRun without running the tool
if (require.main === module) {
  main().catch((error) => {
    console.error(`record failed: ${(error as Error).message}`)
    process.exit(1)
  })
}
