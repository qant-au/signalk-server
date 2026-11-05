/**
 * Loaded into the server process by the busy run (`node -r`), to measure what can only be
 * seen from inside it: event loop lag, memory and CPU. The busy run asks for a sample over
 * the IPC channel once a minute; each answer covers the time since the last one.
 */
import { monitorEventLoopDelay } from 'perf_hooks'

export interface ProbeSample {
  /** event loop delay over the interval, ms */
  lagP50Ms: number
  lagP99Ms: number
  lagMaxMs: number
  /** after a full garbage collection, so the heap is what is still held */
  heapUsedMiB: number
  rssMiB: number
  /** CPU time used over the interval, as a share of one core */
  cpuShare: number
}

const RESOLUTION_MS = 10
const MIB = 1024 * 1024
const NS_PER_MS = 1e6

const delay = monitorEventLoopDelay({ resolution: RESOLUTION_MS })
delay.enable()
let lastCpu = process.cpuUsage()
let lastAt = process.hrtime.bigint()

function sample(): ProbeSample {
  const collect = (global as { gc?: () => void }).gc
  if (collect) collect()
  const memory = process.memoryUsage()
  const cpu = process.cpuUsage(lastCpu)
  const now = process.hrtime.bigint()
  const elapsedUs = Number(now - lastAt) / 1000
  lastCpu = process.cpuUsage()
  lastAt = now
  const result: ProbeSample = {
    lagP50Ms: delay.percentile(50) / NS_PER_MS,
    lagP99Ms: delay.percentile(99) / NS_PER_MS,
    lagMaxMs: delay.max / NS_PER_MS,
    heapUsedMiB: memory.heapUsed / MIB,
    rssMiB: memory.rss / MIB,
    cpuShare: (cpu.user + cpu.system) / elapsedUs
  }
  delay.reset()
  return result
}

// the server goes with the busy run, however the run ends
process.on('disconnect', () => process.exit(0))

process.on('message', (message) => {
  if (message === 'sample') process.send?.({ probe: sample() })
})
