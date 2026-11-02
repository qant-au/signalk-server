/**
 * The busy run: drives the server hard with the simulator plugin and its traffic, and
 * reports whether it keeps up. Started by bin/simulator-busy, which builds the plugin first.
 *
 *   npx ts-node simulator/tools/busy.ts <sample> [options]
 *
 *   --hours N         scenario hours to run (default 24)
 *   --multiplier N    scenario seconds per second (default 24)
 *   --subscribers N   WebSocket subscribers to the full stream (default 10)
 *   --readers N       REST clients polling the vessels tree (default 3)
 *   --start-at N      start N minutes into the route (default 0)
 *   --port N          the server's HTTP port; the next two take its NMEA 0183 and TCP
 *                     streams (default 3100)
 *
 * Writes a JSON report to simulator/soak/reports/ and exits non-zero if the run failed.
 */
import { mkdir, writeFile } from 'fs/promises'
import os from 'os'
import path from 'path'
import { BusyOptions, BusyReport, MinuteRow, busy } from '../soak/busy'

const DEFAULTS = {
  hours: 24,
  multiplier: 24,
  subscribers: 10,
  readers: 3,
  startAt: 0,
  port: 3100
}
const READ_INTERVAL_S = 1
const SEED = 1

function option(args: string[], name: string, fallback: number): number {
  const i = args.indexOf(name)
  return i >= 0 ? Number(args[i + 1]) : fallback
}

const HEADER =
  'wall min  scenario time      behind s  own gap s  server/s  subscribers/s  ' +
  'lag p99/max ms  heap/rss MiB  cpu   targets  plugins ms  tree ms  readers ms'

function line(r: MinuteRow): string {
  const hhmm = r.scenarioTime.slice(5, 16).replace('T', ' ')
  return [
    r.wallMinutes.toFixed(0).padStart(8),
    hhmm.padEnd(17),
    r.clockBehindS.toFixed(0).padStart(9),
    r.ownBoatGapS.toFixed(1).padStart(10),
    r.serverDeltasPerS.toFixed(0).padStart(9),
    `${r.subscriberDeltasPerS[0].toFixed(0)}-${r.subscriberDeltasPerS[1].toFixed(0)}`.padStart(
      14
    ),
    `${r.lagP99Ms.toFixed(0)}/${r.lagMaxMs.toFixed(0)}`.padStart(15),
    `${r.heapUsedMiB.toFixed(0)}/${r.rssMiB.toFixed(0)}`.padStart(13),
    `${(r.cpuShare * 100).toFixed(0)}%`.padStart(5),
    `${r.targetsInStatus ?? '-'}/${r.targetsInTree}`.padStart(8),
    r.pluginListMs.toFixed(0).padStart(11),
    r.vesselsTreeMs.toFixed(0).padStart(8),
    r.readersMaxMs.toFixed(0).padStart(11)
  ].join(' ')
}

function summary(report: BusyReport): string {
  const rows = report.rows
  const max = (f: (r: MinuteRow) => number) => Math.max(...rows.map(f))
  const min = (f: (r: MinuteRow) => number) => Math.min(...rows.map(f))
  const mean = (f: (r: MinuteRow) => number) =>
    rows.reduce((a, r) => a + f(r), 0) / rows.length
  const received = report.subscribers.map((s) => s.received)
  return [
    `server handled ${report.serverDeltas} deltas, ${report.heldBack} of them for lost targets held back by the plugin; subscribers received ${Math.min(...received)} to ${Math.max(...received)}`,
    `deltas a second: server mean ${mean((r) => r.serverDeltasPerS).toFixed(0)}, peak ${max((r) => r.serverDeltasPerS).toFixed(0)}`,
    `scenario clock at most ${max((r) => r.clockBehindS).toFixed(0)} s behind; the own boat's longest gap ${max((r) => r.ownBoatGapS).toFixed(1)} s`,
    `event loop lag p99 at most ${max((r) => r.lagP99Ms).toFixed(0)} ms, max ${max((r) => r.lagMaxMs).toFixed(0)} ms`,
    `heap ${rows[0].heapUsedMiB.toFixed(0)} to ${rows[rows.length - 1].heapUsedMiB.toFixed(0)} MiB (peak ${max((r) => r.heapUsedMiB).toFixed(0)}), rss peak ${max((r) => r.rssMiB).toFixed(0)} MiB`,
    `server cpu mean ${(mean((r) => r.cpuShare) * 100).toFixed(0)}% of a core, peak ${(max((r) => r.cpuShare) * 100).toFixed(0)}%`,
    `targets in range ${min((r) => r.targetsInTree)} to ${max((r) => r.targetsInTree)}; status count agreed with the tree in ${rows.filter((r) => r.targetsInStatus === r.targetsInTree).length} of ${rows.length} minutes`,
    `slowest answers: plugin list ${max((r) => r.pluginListMs).toFixed(0)} ms, vessels tree ${max((r) => Math.max(r.vesselsTreeMs, r.readersMaxMs)).toFixed(0)} ms over ${report.readerRequests} reads (${report.failedRequests} failed)`,
    `this process's own event loop lag at most ${report.clientLagMaxMs.toFixed(0)} ms`
  ].join('\n')
}

async function main() {
  const args = process.argv.slice(2)
  const sample = args[0]
  if (!sample || sample.startsWith('--')) {
    console.error(
      'usage: busy.ts <sample> [--hours N] [--multiplier N] [--subscribers N] [--readers N] [--start-at N] [--port N]'
    )
    process.exit(2)
  }
  const options: BusyOptions = {
    sample,
    hours: option(args, '--hours', DEFAULTS.hours),
    timeMultiplier: option(args, '--multiplier', DEFAULTS.multiplier),
    subscribers: option(args, '--subscribers', DEFAULTS.subscribers),
    readers: option(args, '--readers', DEFAULTS.readers),
    readIntervalS: READ_INTERVAL_S,
    startAtMinutes: option(args, '--start-at', DEFAULTS.startAt),
    port: option(args, '--port', DEFAULTS.port),
    seed: SEED
  }
  const reportsDir = path.resolve(__dirname, '..', 'soak', 'reports')
  await mkdir(reportsDir, { recursive: true })
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const name = `busy-${sample}-${stamp}`
  const logFile = path.join(reportsDir, `${name}.log`)

  console.log(
    `busy run: ${sample}, ${options.hours} scenario hours at x${options.timeMultiplier} ` +
      `(${((options.hours * 60) / options.timeMultiplier).toFixed(0)} min), ` +
      `${options.subscribers} subscribers, ${options.readers} readers, on ${os.cpus()[0].model}, ` +
      `${(os.totalmem() / 2 ** 30).toFixed(0)} GiB, Node ${process.version}; server log ${logFile}`
  )
  console.log(HEADER)
  const report = await busy(options, logFile, (row) => console.log(line(row)))
  const file = path.join(reportsDir, `${name}.json`)
  await writeFile(file, JSON.stringify(report, null, 2))
  console.log(summary(report))
  console.log(
    report.passed ? 'PASSED' : `FAILED:\n  ${report.problems.join('\n  ')}`
  )
  console.log(`report: ${file}`)
  process.exit(report.passed ? 0 : 1)
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
