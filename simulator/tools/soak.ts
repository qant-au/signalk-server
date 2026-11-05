/**
 * Real-time soak test: sail a sample's route on the rig and check the server keeps up.
 *
 *   npx ts-node simulator/tools/soak.ts <sample> [options]
 *
 *   --minutes N        how long to run (default 10); stops early if the route ends
 *   --start-at N       start N minutes into the route (default 0)
 *   --url URL          the server (default http://127.0.0.1:4770, the rig)
 *   --container NAME   sample the server's memory from this container (default signalk-sim-rig)
 *
 * Writes a JSON report to simulator/soak/reports/ and exits non-zero if anything failed.
 */
import { mkdir, writeFile } from 'fs/promises'
import path from 'path'
import { loadRoute } from '../routes/route'
import { SoakOptions, soak } from '../soak/run'

const DEFAULTS = {
  minutes: 10,
  startAt: 0,
  url: 'http://127.0.0.1:4770',
  container: 'signalk-sim-rig'
}
const SEND_INTERVAL_S = 1
const CHECK_INTERVAL_S = 10
const TOLERANCE_M = 1

function option(args: string[], name: string): string | undefined {
  const i = args.indexOf(name)
  return i >= 0 ? args[i + 1] : undefined
}

async function main() {
  const args = process.argv.slice(2)
  const sample = args[0]
  if (!sample || sample.startsWith('--')) {
    console.error(
      'usage: soak.ts <sample> [--minutes N] [--start-at N] [--url URL] [--container NAME]'
    )
    process.exit(2)
  }
  const options: SoakOptions = {
    serverUrl: option(args, '--url') ?? DEFAULTS.url,
    durationS: Number(option(args, '--minutes') ?? DEFAULTS.minutes) * 60,
    startOffsetS: Number(option(args, '--start-at') ?? DEFAULTS.startAt) * 60,
    sendIntervalS: SEND_INTERVAL_S,
    checkIntervalS: CHECK_INTERVAL_S,
    toleranceM: TOLERANCE_M,
    container: option(args, '--container') ?? DEFAULTS.container
  }

  const sampleDir = path.resolve(__dirname, '..', 'samples', sample)
  const route = await loadRoute(sampleDir)
  console.log(
    `soak: ${route.name}, ${options.durationS / 60} min in real time, from ${options.startOffsetS / 60} min into the route, against ${options.serverUrl}`
  )
  const report = await soak(route, options)

  const reportsDir = path.resolve(__dirname, '..', 'soak', 'reports')
  await mkdir(reportsDir, { recursive: true })
  const file = path.join(
    reportsDir,
    `${sample}-${report.startedAt.replace(/[:.]/g, '-')}.json`
  )
  await writeFile(file, JSON.stringify(report, null, 2) + '\n')

  const errors = report.checks
    .map((c) => c.readBackErrorM)
    .filter((e): e is number => e !== undefined)
  console.log(`  deltas sent:     ${report.deltasSent}`)
  console.log(
    `  scenario time:   ${report.scenarioFrom} to ${report.scenarioTo}`
  )
  console.log(
    `  checks:          ${report.checks.length}, worst read-back error ${errors.length ? Math.max(...errors).toFixed(2) : '-'} m`
  )
  console.log(`  reconnects:      ${report.reconnects}`)
  if (report.memoryMiB) {
    const m = report.memoryMiB
    console.log(
      `  server memory:   ${m.first.toFixed(0)} MiB to ${m.last.toFixed(0)} MiB, peak ${m.peak.toFixed(0)} MiB`
    )
  }
  for (const problem of report.problems) console.log(`  PROBLEM ${problem}`)
  console.log(
    `  ${report.passed ? 'PASSED' : 'FAILED'}, report ${path.relative(process.cwd(), file)}`
  )
  process.exit(report.passed ? 0 : 1)
}

main().catch((error: Error) => {
  console.error(error.message)
  process.exit(1)
})
