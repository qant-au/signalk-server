import { ChildProcess, fork } from 'child_process'
import { openSync, closeSync } from 'fs'
import { cp, mkdir, readFile, rm, symlink, writeFile } from 'fs/promises'
import path from 'path'
import { performance } from 'perf_hooks'
import type { ProbeSample } from './busy-probe'

/**
 * The busy run: the server, with the simulator plugin sailing a sample with its traffic
 * at a fast multiplier, read by a crowd of clients at once, measured once a minute of
 * wall time. It answers whether the server keeps up with the plugin and its readers: the
 * scenario clock against the wall clock, every delta handled reaching every subscriber,
 * the server's event loop and memory, and how fast it answers the Admin UI.
 */
export interface BusyOptions {
  sample: string
  /** scenario hours to run */
  hours: number
  timeMultiplier: number
  /** WebSocket subscribers to the full stream */
  subscribers: number
  /** REST clients polling the vessels tree */
  readers: number
  /** pause between one reader's requests */
  readIntervalS: number
  startAtMinutes: number
  port: number
  seed: number
}

export interface MinuteRow {
  wallMinutes: number
  scenarioTime: string
  /** how far the scenario time the subscribers see is behind wall time × multiplier */
  clockBehindS: number
  /** the longest the own boat went without a delta reaching a subscriber */
  ownBoatGapS: number
  serverDeltasPerS: number
  /** the slowest and fastest subscriber */
  subscriberDeltasPerS: [number, number]
  lagP99Ms: number
  lagMaxMs: number
  heapUsedMiB: number
  rssMiB: number
  cpuShare: number
  /** the count in the plugin's status, and the other vessels in the tree */
  targetsInStatus?: number
  targetsInTree: number
  pluginListMs: number
  vesselsTreeMs: number
  /** the slowest reader request over the minute */
  readersMaxMs: number
}

export interface SubscriberTotal {
  received: number
  /** deltas that came merged under backpressure, standing in for several */
  merged: number
  closed: boolean
}

export interface BusyReport {
  options: BusyOptions
  startedAt: string
  finishedAt: string
  rows: MinuteRow[]
  /** deltas the server handled from the plugin's start to its stop */
  serverDeltas: number
  /** of those, deltas for lost targets the plugin held back, so never sent on */
  heldBack: number
  subscribers: SubscriberTotal[]
  readerRequests: number
  failedRequests: number
  /** the event loop lag of this process, which reads for the clients */
  clientLagMaxMs: number
  problems: string[]
  passed: boolean
}

/** a run fails past these */
export const LIMITS = {
  clockBehindS: 60,
  responseMs: 1000,
  /** the heap's mean over the last quarter of the run against the quarter before */
  heapGrowthShare: 0.1,
  heapGrowthMiB: 10
}

const PLUGIN_ID = 'signalk-simulator'
const MINUTE_MS = 60000
const STATS_INTERVAL_MS = 5000
const QUIET_MS = 2 * STATS_INTERVAL_MS + 2000
/** the AIS status plugin marks a target lost 6 minutes after its last position and removed 3 later */
const SETTLE_MAX_MS = 12 * MINUTE_MS
const START_TIMEOUT_MS = 120000
const ROOT = path.resolve(__dirname, '..', '..')
const RUN_DIR = path.join(ROOT, '.simulator-busy')

/** what failed, from the minute rows and the totals; empty if the run passed */
export function judge(
  rows: MinuteRow[],
  serverDeltas: number,
  subscribers: SubscriberTotal[],
  failedRequests: number
): string[] {
  const problems: string[] = []
  const behind = Math.max(0, ...rows.map((r) => r.clockBehindS))
  if (behind > LIMITS.clockBehindS)
    problems.push(
      `the scenario clock fell ${behind.toFixed(0)} s behind (limit ${LIMITS.clockBehindS} s)`
    )
  subscribers.forEach((s, i) => {
    if (s.closed) problems.push(`subscriber ${i + 1} was disconnected`)
    if (s.received !== serverDeltas || s.merged > 0)
      problems.push(
        `subscriber ${i + 1} received ${s.received} of ${serverDeltas} deltas` +
          (s.merged ? `, ${s.merged} of them merged under backpressure` : '')
      )
  })
  const slowest = Math.max(
    0,
    ...rows.map((r) =>
      Math.max(r.pluginListMs, r.vesselsTreeMs, r.readersMaxMs)
    )
  )
  if (slowest > LIMITS.responseMs)
    problems.push(
      `the server took ${slowest.toFixed(0)} ms to answer (limit ${LIMITS.responseMs} ms)`
    )
  if (failedRequests > 0)
    problems.push(`${failedRequests} requests failed or went unanswered`)
  const growth = heapStillGrowing(rows.map((r) => r.heapUsedMiB))
  if (growth) problems.push(growth)
  return problems
}

/** whether the heap is still climbing at the end of the run rather than levelling off */
export function heapStillGrowing(heapMiB: number[]): string | undefined {
  const quarter = Math.floor(heapMiB.length / 4)
  if (quarter < 1) return undefined
  const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length
  const third = mean(heapMiB.slice(-2 * quarter, -quarter))
  const last = mean(heapMiB.slice(-quarter))
  const growth = last - third
  return growth > LIMITS.heapGrowthMiB &&
    growth > third * LIMITS.heapGrowthShare
    ? `the heap was still growing at the end: ${third.toFixed(0)} to ${last.toFixed(0)} MiB over the last two quarters`
    : undefined
}

/** the count in a status such as "..., 379 AIS targets in range, ..." */
export function targetsInStatus(status: string): number | undefined {
  const match = /(\d+) AIS targets in range/.exec(status)
  return match ? Number(match[1]) : undefined
}

/** the deltas for lost targets the plugin held back, from the line it logs as it stops */
export function heldBackInLog(log: string): number {
  const matches = [
    ...log.matchAll(/stopped, (\d+) deltas for lost targets held back/g)
  ]
  return matches.length > 0 ? Number(matches[matches.length - 1][1]) : 0
}

interface Subscriber {
  socket: WebSocket
  total: SubscriberTotal
  /** received at the last minute row */
  atLastRow: number
}

interface ClockState {
  selfContext?: string
  anchor?: { wallMs: number; scenarioMs: number }
  latestScenarioMs?: number
  latestAtMs?: number
  maxBehindMs: number
  maxGapMs: number
}

async function prepare(options: BusyOptions) {
  await rm(RUN_DIR, { recursive: true, force: true })
  await mkdir(path.join(RUN_DIR, 'node_modules'), { recursive: true })
  await mkdir(path.join(RUN_DIR, 'plugin-config-data'), { recursive: true })
  await cp(
    path.join(ROOT, 'settings', 'simulator.json'),
    path.join(RUN_DIR, 'settings.json')
  )
  await symlink(
    path.join(ROOT, 'simulator', 'plugin'),
    path.join(RUN_DIR, 'node_modules', PLUGIN_ID)
  )
  await writeFile(
    path.join(RUN_DIR, 'plugin-config-data', `${PLUGIN_ID}.json`),
    JSON.stringify(pluginConfig(options, false), null, 2)
  )
}

function pluginConfig(options: BusyOptions, enabled: boolean) {
  return {
    enabled,
    configuration: {
      sample: options.sample,
      timeMultiplier: options.timeMultiplier,
      minDepthUnderKeelM: 1,
      showTraffic: true,
      receiverAntennaHeightM: 10,
      startAtMinutes: options.startAtMinutes,
      resume: false,
      seed: options.seed
    }
  }
}

function startServer(options: BusyOptions, logFile: string): ChildProcess {
  const log = openSync(logFile, 'w')
  const server = fork(
    path.join(ROOT, 'bin', 'signalk-server'),
    ['-c', RUN_DIR],
    {
      cwd: ROOT,
      execArgv: [
        '--expose-gc',
        '-r',
        'ts-node/register/transpile-only',
        '-r',
        path.join(__dirname, 'busy-probe.ts')
      ],
      env: {
        ...process.env,
        PORT: String(options.port),
        NMEA0183PORT: String(options.port + 1),
        TCPSTREAMPORT: String(options.port + 2)
      },
      stdio: ['ignore', log, log, 'ipc']
    }
  )
  closeSync(log)
  return server
}

function probe(server: ChildProcess): Promise<ProbeSample> {
  return new Promise((resolve) => {
    const onMessage = (message: unknown) => {
      const sample = (message as { probe?: ProbeSample }).probe
      if (!sample) return
      server.off('message', onMessage)
      resolve(sample)
    }
    server.on('message', onMessage)
    server.send('sample')
  })
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

async function timed<T>(
  url: string,
  init?: RequestInit
): Promise<{ ms: number; body?: T }> {
  const started = performance.now()
  try {
    const response = await fetch(url, {
      ...init,
      signal: AbortSignal.timeout(10 * LIMITS.responseMs)
    })
    const body = response.ok ? ((await response.json()) as T) : undefined
    return { ms: performance.now() - started, body }
  } catch {
    return { ms: performance.now() - started }
  }
}

async function waitForServer(base: string) {
  const deadline = Date.now() + START_TIMEOUT_MS
  while (Date.now() < deadline) {
    if ((await timed(`${base}/signalk`)).body) return
    await sleep(500)
  }
  throw new Error(`the server did not answer at ${base}`)
}

function open(url: string, onMessage: (data: string) => void) {
  return new Promise<WebSocket>((resolve, reject) => {
    const socket = new WebSocket(url)
    socket.onopen = () => resolve(socket)
    socket.onerror = () => reject(new Error(`could not open ${url}`))
    socket.onmessage = (event) => onMessage(String(event.data))
  })
}

interface Delta {
  context?: string
  self?: string
  updates?: { values?: { path: string; value: unknown }[] }[]
  $backpressure?: unknown
  type?: string
  data?: { providerStatistics?: Record<string, { deltaCount: number }> }
}

/** watches the own boat's scenario time as the first subscriber receives it */
function watchClock(clock: ClockState, delta: Delta, multiplier: number) {
  if (delta.self) clock.selfContext = delta.self
  if (delta.context !== clock.selfContext || !delta.updates) return
  for (const update of delta.updates) {
    for (const value of update.values ?? []) {
      if (value.path !== 'navigation.datetime') continue
      const now = Date.now()
      const scenarioMs = Date.parse(String(value.value))
      clock.anchor ??= { wallMs: now, scenarioMs }
      if (clock.latestAtMs !== undefined)
        clock.maxGapMs = Math.max(clock.maxGapMs, now - clock.latestAtMs)
      clock.latestScenarioMs = scenarioMs
      clock.latestAtMs = now
      clock.maxBehindMs = Math.max(
        clock.maxBehindMs,
        behindMs(clock, now, multiplier)
      )
    }
  }
}

function behindMs(clock: ClockState, now: number, multiplier: number) {
  if (!clock.anchor || clock.latestScenarioMs === undefined) return 0
  const expected =
    clock.anchor.scenarioMs + (now - clock.anchor.wallMs) * multiplier
  return expected - clock.latestScenarioMs
}

export async function busy(
  options: BusyOptions,
  logFile: string,
  onRow: (row: MinuteRow) => void
): Promise<BusyReport> {
  const base = `http://127.0.0.1:${options.port}`
  const stream = `ws://127.0.0.1:${options.port}/signalk/v1/stream`
  const startedAt = new Date().toISOString()
  await prepare(options)
  const server = startServer(options, logFile)
  let serverExited = false
  server.on('exit', () => {
    serverExited = true
  })

  const sockets: WebSocket[] = []
  let stopping = false
  try {
    await waitForServer(base)

    let serverCount = 0
    const countServer = (data: string) => {
      const event = JSON.parse(data) as Delta
      if (event.type !== 'SERVERSTATISTICS') return
      serverCount = Object.values(event.data?.providerStatistics ?? {}).reduce(
        (sum, p) => sum + (p.deltaCount ?? 0),
        0
      )
    }
    sockets.push(
      await open(
        `${stream}?subscribe=none&serverevents=all&sendCachedValues=false`,
        countServer
      )
    )

    const clock: ClockState = { maxBehindMs: 0, maxGapMs: 0 }
    let lastDeltaAt = Date.now()
    // quiet for longer than two statistics intervals, so the server's count covers every delta sent
    const settle = async (): Promise<boolean> => {
      const giveUpAt = Date.now() + SETTLE_MAX_MS
      while (Date.now() - lastDeltaAt < QUIET_MS) {
        if (Date.now() > giveUpAt) return false
        await sleep(STATS_INTERVAL_MS)
      }
      return true
    }
    const subscribers: Subscriber[] = []
    for (let i = 0; i < options.subscribers; i++) {
      const total: SubscriberTotal = { received: 0, merged: 0, closed: false }
      const first = i === 0
      const socket = await open(
        `${stream}?subscribe=all&sendCachedValues=false`,
        (data) => {
          const delta = JSON.parse(data) as Delta
          if (first) watchClock(clock, delta, options.timeMultiplier)
          if (!delta.updates) return
          total.received++
          lastDeltaAt = Date.now()
          if (delta.$backpressure) total.merged++
        }
      )
      socket.onclose = () => {
        if (!stopping) total.closed = true
      }
      sockets.push(socket)
      subscribers.push({ socket, total, atLastRow: 0 })
    }

    let readerRequests = 0
    let failedRequests = 0
    let readersMaxMs = 0
    const self = await timed<string>(`${base}/signalk/v1/api/self`)
    const selfId = self.body?.replace(/^vessels\./, '')
    const readers = Array.from({ length: options.readers }, async () => {
      while (!stopping) {
        const { ms, body } = await timed<Record<string, unknown>>(
          `${base}/signalk/v1/api/vessels`
        )
        readerRequests++
        if (!body) failedRequests++
        readersMaxMs = Math.max(readersMaxMs, ms)
        await sleep(options.readIntervalS * 1000)
      }
    })

    // the counts start and end on a quiet server, so every delta between is counted on both sides
    await settle()
    const serverAtStart = serverCount
    const subscribersAtStart = subscribers.map((s) => s.total.received)
    await probe(server)

    const configUrl = `${base}/skServer/plugins/${PLUGIN_ID}/config`
    const post = (enabled: boolean) =>
      fetch(configUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(pluginConfig(options, enabled))
      })
    await post(true)

    const rows: MinuteRow[] = []
    const runMs = (options.hours * 3600000) / options.timeMultiplier
    const runStart = Date.now()
    let serverAtLastRow = serverAtStart
    let clientLagMaxMs = 0
    let lastTick = Date.now()
    const lagWatch = setInterval(() => {
      const now = Date.now()
      clientLagMaxMs = Math.max(clientLagMaxMs, now - lastTick - 100)
      lastTick = now
    }, 100)
    subscribers.forEach((s, i) => {
      s.atLastRow = subscribersAtStart[i]
    })

    while (Date.now() - runStart < runMs && !serverExited) {
      await sleep(Math.min(MINUTE_MS, runMs - (Date.now() - runStart)))
      const sample = await probe(server)
      const plugins = await timed<{ id: string; statusMessage?: string }[]>(
        `${base}/skServer/plugins`
      )
      const tree = await timed<Record<string, unknown>>(
        `${base}/signalk/v1/api/vessels`
      )
      if (!plugins.body || !tree.body) failedRequests++
      const status =
        plugins.body?.find((p) => p.id === PLUGIN_ID)?.statusMessage ?? ''
      const now = Date.now()
      const seconds = MINUTE_MS / 1000
      const rates = subscribers.map((s) => {
        const rate = (s.total.received - s.atLastRow) / seconds
        s.atLastRow = s.total.received
        return rate
      })
      const row: MinuteRow = {
        wallMinutes: (now - runStart) / MINUTE_MS,
        scenarioTime:
          clock.latestScenarioMs !== undefined
            ? new Date(clock.latestScenarioMs).toISOString()
            : '',
        clockBehindS:
          Math.max(
            clock.maxBehindMs,
            behindMs(clock, now, options.timeMultiplier)
          ) / 1000,
        ownBoatGapS: clock.maxGapMs / 1000,
        serverDeltasPerS: (serverCount - serverAtLastRow) / seconds,
        subscriberDeltasPerS: [Math.min(...rates), Math.max(...rates)],
        lagP99Ms: sample.lagP99Ms,
        lagMaxMs: sample.lagMaxMs,
        heapUsedMiB: sample.heapUsedMiB,
        rssMiB: sample.rssMiB,
        cpuShare: sample.cpuShare,
        targetsInStatus: targetsInStatus(status),
        targetsInTree: Object.keys(tree.body ?? {}).filter((k) => k !== selfId)
          .length,
        pluginListMs: plugins.ms,
        vesselsTreeMs: tree.ms,
        readersMaxMs
      }
      serverAtLastRow = serverCount
      clock.maxBehindMs = 0
      clock.maxGapMs = 0
      readersMaxMs = 0
      rows.push(row)
      onRow(row)
    }
    clearInterval(lagWatch)

    await post(false)
    const settled = await settle()
    const heldBack = heldBackInLog(await readFile(logFile, 'utf8'))
    const serverDeltas = serverCount - serverAtStart
    const totals = subscribers.map((s, i) => ({
      ...s.total,
      received: s.total.received - subscribersAtStart[i]
    }))
    stopping = true
    await Promise.all(readers)
    const problems = serverExited ? ['the server exited during the run'] : []
    if (!settled) {
      problems.push(
        `the server did not go quiet within ${SETTLE_MAX_MS / MINUTE_MS} minutes of the plugin stopping, so the delta counts may not agree`
      )
    }
    problems.push(
      ...judge(rows, serverDeltas - heldBack, totals, failedRequests)
    )
    return {
      options,
      startedAt,
      finishedAt: new Date().toISOString(),
      rows,
      serverDeltas,
      heldBack,
      subscribers: totals,
      readerRequests,
      failedRequests,
      clientLagMaxMs,
      problems,
      passed: problems.length === 0
    }
  } finally {
    stopping = true
    sockets.forEach((s) => s.close())
    if (!serverExited) server.kill('SIGTERM')
  }
}
