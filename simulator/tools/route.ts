/**
 * Build and inspect a sample's own-boat route.
 *
 *   npx ts-node simulator/tools/route.ts derive <sample>
 *   npx ts-node simulator/tools/route.ts show <sample>
 *   npx ts-node simulator/tools/route.ts turns <sample> [minimum depth under keel, m]
 *
 * `derive` makes route.json from a real passage in the sample's AIS, as set out in the
 * `route` section of sample.json. Only samples whose AIS licence allows derived works use
 * it; the others have hand-written routes. `show` prints a route's legs and timings.
 * `turns` loads the sample as the plugin does, with the route adjusted for depth, and
 * reports every arc at a waypoint: clear, tightened because the planned arc cut a corner
 * over shallow water or land, or not clear at all. It exits non-zero on the last.
 */
import { readFile, writeFile } from 'fs/promises'
import path from 'path'
import { AisReport, loadAisConfig, readAisReports } from '../ais/targets'
import {
  DeriveConfig,
  passageBetween,
  waypointsFromPassage
} from '../routes/derive'
import {
  DEFAULT_MIN_DEPTH_UNDER_KEEL_M,
  DEFAULT_RECEIVER_ANTENNA_HEIGHT_M,
  loadScenario
} from '../engine/scenario'
import {
  Route,
  RouteVessel,
  Waypoint,
  loadRoute,
  routeLegs
} from '../routes/route'

interface RouteSection {
  name: string
  departure: string
  vessel: RouteVessel
  startName: string
  endName: string
  /** describes the source in route.json; never names the source vessel */
  sourceDescription: string
  /** berth to the start of the derived passage; the last one carries the speed onto it */
  fromBerth?: Waypoint[]
  /** after the derived passage to the berth; the berth, last, has no speed */
  toBerth?: Waypoint[]
  /** speed from the end of the derived passage onto the first toBerth waypoint */
  toBerthSpeedKn?: number
  derive: DeriveConfig
}

function sampleDir(sample: string): string {
  return path.resolve(__dirname, '..', 'samples', sample)
}

async function derive(sample: string): Promise<void> {
  const dir = sampleDir(sample)
  const section: RouteSection = JSON.parse(
    await readFile(path.join(dir, 'sample.json'), 'utf8')
  ).route
  if (!section?.derive) {
    throw new Error(`${sample}: sample.json has no route.derive section`)
  }
  const config = section.derive

  const tracks = new Map<string, AisReport[]>()
  for await (const report of readAisReports(dir, await loadAisConfig(dir))) {
    const length = report.target.lengthM ?? 0
    if (length < config.minLengthM || length > config.maxLengthM) continue
    let track = tracks.get(report.id)
    if (!track) tracks.set(report.id, (track = []))
    track.push(report)
  }

  let best: AisReport[] | undefined
  let matches = 0
  for (const track of tracks.values()) {
    track.sort((a, b) => a.timeMs - b.timeMs)
    const passage = passageBetween(track, config)
    if (!passage) continue
    matches++
    if (!best || passage.length > best.length) best = passage
  }
  if (!best) {
    throw new Error(
      `${sample}: no vessel of the required length made the passage`
    )
  }

  const passage = waypointsFromPassage(best, config)
  passage[0].name = section.startName
  const end = passage[passage.length - 1]
  end.name = section.endName
  if (section.toBerth?.length) end.speedKn = section.toBerthSpeedKn
  // berth to berth: the manoeuvring legs at each end are written into sample.json
  const waypoints = [
    ...(section.fromBerth ?? []),
    ...passage,
    ...(section.toBerth ?? [])
  ]
  const route: Route = {
    name: section.name,
    departure: section.departure,
    vessel: section.vessel,
    source: section.sourceDescription,
    waypoints
  }
  await writeFile(
    path.join(dir, 'route.json'),
    JSON.stringify(route, null, 2) + '\n'
  )
  console.log(
    `${sample}: ${matches} vessels made the passage; route.json has ${waypoints.length} waypoints`
  )
}

function hhmm(ms: number): string {
  const minutes = Math.round(ms / 60000)
  return `${Math.floor(minutes / 60)}h${String(minutes % 60).padStart(2, '0')}`
}

async function show(sample: string): Promise<void> {
  const route = await loadRoute(sampleDir(sample))
  const legs = routeLegs(route)
  const start = Date.parse(route.departure)
  console.log(
    `${route.name}\n  departs ${route.departure}, ${route.vessel.description}`
  )
  let total = 0
  legs.forEach((leg, i) => {
    total += leg.distanceNm
    console.log(
      `  ${String(i + 1).padStart(2)}  ${(leg.from.name ?? '').padEnd(28)} ` +
        `${leg.distanceNm.toFixed(1).padStart(5)} nm  ${leg.speedKn.toFixed(1).padStart(4)} kn  ` +
        `${String(Math.round(leg.courseDeg)).padStart(3)}°  arrive +${hhmm(leg.arriveMs - start)}`
    )
  })
  const end = legs[legs.length - 1].arriveMs
  console.log(
    `  total ${total.toFixed(1)} nm in ${hhmm(end - start)}, arriving ${new Date(end).toISOString()}`
  )
}

async function turns(sample: string): Promise<void> {
  const minDepthUnderKeelM = Number(
    process.argv[4] ?? DEFAULT_MIN_DEPTH_UNDER_KEEL_M
  )
  const scenario = await loadScenario(
    path.join(__dirname, '..', 'samples'),
    sample,
    {
      minDepthUnderKeelM,
      receiverAntennaHeightM: DEFAULT_RECEIVER_ANTENNA_HEIGHT_M
    }
  )
  const checks = scenario.turns ?? []
  console.log(
    `${sample}: ${checks.length} turns, ${scenario.route.vessel.description}, ` +
      `draft ${scenario.route.vessel.draftM} m + ${minDepthUnderKeelM} m under the keel`
  )
  if (!scenario.depth) {
    console.log(`  no depth to check against (${scenario.notes.join('; ')})`)
    return
  }
  for (const c of checks) {
    const label = `  ${String(c.waypoint).padStart(3)} ${(c.name ?? `${c.lat.toFixed(5)}, ${c.lon.toFixed(5)}`).padEnd(28)} ${c.deltaDeg.toFixed(0).padStart(4)}°`
    if (c.plannedRadiusM === undefined) continue
    console.log(
      c.clear
        ? `${label}  cut a corner at ${c.plannedRadiusM.toFixed(0)} m radius; tightened to ${c.radiusM.toFixed(1)} m`
        : `${label}  NOT CLEAR even at the waypoint (a leg the route could not clear)`
    )
  }
  const tightened = checks.filter((c) => c.plannedRadiusM !== undefined)
  const uncleared = checks.filter((c) => !c.clear)
  console.log(
    `  ${checks.length - tightened.length} clear as planned, ` +
      `${tightened.length - uncleared.length} tightened, ${uncleared.length} not clear`
  )
  if (uncleared.length) process.exitCode = 1
}

const [command, sample] = process.argv.slice(2)
const commands: Record<string, (sample: string) => Promise<void>> = {
  derive,
  show,
  turns
}
const run = commands[command]
if (!run || !sample) {
  console.error('usage: route.ts derive|show|turns <sample>')
  process.exit(2)
}
run(sample).catch((error: Error) => {
  console.error(error.message)
  process.exit(1)
})
