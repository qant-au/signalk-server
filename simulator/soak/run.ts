import { execFile } from 'child_process'
import { promisify } from 'util'
import { distanceNm } from '../ais/reception'
import {
  Leg,
  Route,
  RoutePosition,
  positionAt,
  routeLegs
} from '../routes/route'
import { publishRoute } from '../routes/resources'
import { memoryOutOfBounds } from './busy'
import { ScenarioClock } from './clock'
import path from 'path'

const VESSELS = path.join(__dirname, '..', 'vessels')
import { identityDelta, ownBoatDelta, vesselIdentity } from './deltas'
import { loadProfile } from '../vessels/profile'

/**
 * A real-time soak run: the own boat sails its route on the rig, one scenario second per
 * real second, while the run checks that the server keeps up. It publishes the route as a
 * Resources API route, so a chart plotter shows the plan, then sends the boat's
 * position, speed and course at a steady rate over the server's WebSocket stream, reads
 * the position back over HTTP, and (when given the container name) samples the server's
 * memory, which is what slowly grows when something leaks.
 */
export interface SoakOptions {
  /** e.g. http://127.0.0.1:4770 */
  serverUrl: string
  durationS: number
  /** start this far into the route, seconds after departure */
  startOffsetS: number
  sendIntervalS: number
  checkIntervalS: number
  /** a read-back further than this from what was sent counts as a mismatch */
  toleranceM: number
  /** docker container to sample memory from, if any */
  container?: string
}

export interface SoakCheck {
  wallTime: string
  scenarioTime: string
  lat: number
  lon: number
  readBackErrorM?: number
  readBackMs?: number
  memoryMiB?: number
  problem?: string
}

export interface SoakReport {
  route: string
  options: SoakOptions
  startedAt: string
  finishedAt: string
  scenarioFrom: string
  scenarioTo: string
  deltasSent: number
  reconnects: number
  checks: SoakCheck[]
  problems: string[]
  routeFinished: boolean
  memoryMiB?: { first: number; last: number; peak: number }
  passed: boolean
}

const METRES_PER_NM = 1852
const MINUTE_S = 60
const HOUR_S = 3600
const MEBIBYTES: Record<string, number> = {
  B: 1 / 1048576,
  KiB: 1 / 1024,
  MiB: 1,
  GiB: 1024
}

const run = promisify(execFile)

async function containerMemoryMiB(
  container: string
): Promise<number | undefined> {
  try {
    const { stdout } = await run('docker', [
      'stats',
      '--no-stream',
      '--format',
      '{{.MemUsage}}',
      container
    ])
    const m = /^([\d.]+)\s*([KMG]?i?B)/.exec(stdout.trim())
    return m ? Number(m[1]) * (MEBIBYTES[m[2]] ?? 1) : undefined
  } catch {
    return undefined
  }
}

function wsUrl(serverUrl: string): string {
  return serverUrl.replace(/^http/, 'ws') + '/signalk/v1/stream?subscribe=none'
}

class Feed {
  private socket?: WebSocket
  reconnects = 0
  private opened = false

  constructor(private readonly url: string) {}

  async open(): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      const socket = new WebSocket(this.url)
      socket.onopen = () => {
        if (this.opened) this.reconnects++
        this.opened = true
        this.socket = socket
        resolve()
      }
      socket.onerror = () => reject(new Error(`cannot connect to ${this.url}`))
      socket.onclose = () => {
        if (this.socket === socket) this.socket = undefined
      }
    })
  }

  async send(message: unknown): Promise<void> {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) {
      await this.open()
    }
    this.socket!.send(JSON.stringify(message))
  }

  close(): void {
    this.socket?.close()
  }
}

async function readBackPosition(
  serverUrl: string
): Promise<{ lat: number; lon: number; ms: number }> {
  const started = Date.now()
  const response = await fetch(
    `${serverUrl}/signalk/v1/api/vessels/self/navigation/position/value`
  )
  if (!response.ok) {
    throw new Error(`position read-back returned HTTP ${response.status}`)
  }
  const value = (await response.json()) as {
    latitude: number
    longitude: number
  }
  return { lat: value.latitude, lon: value.longitude, ms: Date.now() - started }
}

function closestSent(
  recent: RoutePosition[],
  lat: number,
  lon: number
): number {
  return Math.min(
    ...recent.map((p) => distanceNm(p.lat, p.lon, lat, lon) * METRES_PER_NM)
  )
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

export async function soak(
  route: Route,
  options: SoakOptions
): Promise<SoakReport> {
  const legs: Leg[] = routeLegs(route)
  const startedAt = Date.now()
  const scenarioStart =
    Date.parse(route.departure) + options.startOffsetS * 1000
  const clock = new ScenarioClock(scenarioStart, startedAt)
  const feed = new Feed(wsUrl(options.serverUrl))
  const report: SoakReport = {
    route: route.name,
    options,
    startedAt: new Date(startedAt).toISOString(),
    finishedAt: '',
    scenarioFrom: new Date(scenarioStart).toISOString(),
    scenarioTo: '',
    deltasSent: 0,
    reconnects: 0,
    checks: [],
    problems: [],
    routeFinished: false,
    passed: false
  }

  // Freeboard draws the planned route beside the boat sailing it
  try {
    await publishRoute(options.serverUrl, route)
  } catch (error) {
    report.problems.push(
      `publishing the route failed: ${(error as Error).message}`
    )
  }
  // the same name, MMSI and dimensions the plugin sends, so the boat is one vessel
  const profile = route.vessel.profile
    ? loadProfile(route.vessel.profile, VESSELS)
    : undefined
  await feed.send(
    identityDelta(vesselIdentity(route.vessel, profile), startedAt).delta
  )
  // the read-back can trail the latest send by a delta or two
  const recent: RoutePosition[] = []
  let nextCheck = startedAt
  const endAt = startedAt + options.durationS * 1000

  for (
    let tick = startedAt;
    tick < endAt;
    tick += options.sendIntervalS * 1000
  ) {
    const wait = tick - Date.now()
    if (wait > 0) await sleep(wait)
    const now = Date.now()
    const scenarioNow = clock.scenarioTime(now)
    const position = positionAt(legs, scenarioNow)
    try {
      await feed.send(ownBoatDelta(position, scenarioNow, now))
      report.deltasSent++
    } catch (error) {
      report.problems.push(
        `${new Date(now).toISOString()} send failed: ${(error as Error).message}`
      )
    }
    recent.push(position)
    if (recent.length > 3) recent.shift()
    report.scenarioTo = new Date(scenarioNow).toISOString()

    if (now >= nextCheck) {
      nextCheck += options.checkIntervalS * 1000
      const check: SoakCheck = {
        wallTime: new Date(now).toISOString(),
        scenarioTime: new Date(scenarioNow).toISOString(),
        lat: position.lat,
        lon: position.lon
      }
      try {
        const back = await readBackPosition(options.serverUrl)
        check.readBackMs = back.ms
        check.readBackErrorM = closestSent(recent, back.lat, back.lon)
        if (check.readBackErrorM > options.toleranceM) {
          check.problem = `read-back ${check.readBackErrorM.toFixed(1)} m from what was sent`
        }
      } catch (error) {
        check.problem = (error as Error).message
      }
      if (options.container) {
        check.memoryMiB = await containerMemoryMiB(options.container)
      }
      if (check.problem) {
        report.problems.push(`${check.wallTime} ${check.problem}`)
      }
      report.checks.push(check)
    }

    if (position.finished) {
      report.routeFinished = true
      break
    }
  }

  feed.close()
  report.reconnects = feed.reconnects
  report.finishedAt = new Date().toISOString()
  const memory = report.checks
    .map((c) => c.memoryMiB)
    .filter((m): m is number => m !== undefined)
  if (memory.length) {
    report.memoryMiB = {
      first: memory[0],
      last: memory[memory.length - 1],
      peak: Math.max(...memory)
    }
    // the rise is judged on a run of an hour or more; a short run is still warming up
    const rise = options.durationS >= HOUR_S ? memory : []
    report.problems.push(
      ...memoryOutOfBounds(
        rise,
        memory,
        Math.ceil(MINUTE_S / options.checkIntervalS)
      )
    )
  }
  report.passed = report.problems.length === 0 && report.deltasSent > 0
  return report
}
