import { expect } from 'chai'
import { execFile } from 'child_process'
import { EventEmitter } from 'events'
import {
  createReadStream,
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  writeFileSync
} from 'fs'
import { rm } from 'fs/promises'
import os from 'os'
import path from 'path'
import { Writable } from 'stream'
import { promisify } from 'util'
import DeMultiplexer from '../packages/streams/src/autodetect'
import Liner from '../packages/streams/src/liner'
import DeltaEditor from '../src/deltaeditor'
import type { DeltaCache } from '../packages/streams/src/types'
import { Scenario, loadScenario } from '../simulator/engine/scenario'
import { Simulation } from '../simulator/engine/simulation'
import { Delta } from '../simulator/soak/deltas'
import {
  MAX_LINE_CHARS,
  RECORD_TICK_MS,
  RecordSummary,
  logLines,
  recordRun
} from '../simulator/tools/record'

const SAMPLES = path.join(__dirname, '..', 'simulator', 'samples')
const SAMPLE = 'miami-icw-2024-03-16'
const MINUTES = 5
const run = promisify(execFile)

/** the server's own multiplexed log reader, as its file playback runs it, unthrottled */
function serverReader(): { demux: DeMultiplexer; parsed: Delta[] } {
  const app = Object.assign(new EventEmitter(), {
    selfContext: 'vessels.urn:mrn:imo:mmsi:000000000',
    isNmea2000OutAvailable: false,
    deltaCache: {
      setSourceDelta(): void {}
    } as unknown as DeltaCache,
    handleMessage(): void {},
    signalk: new EventEmitter()
  })
  const demux = new DeMultiplexer({
    app,
    providerId: 'replay',
    noThrottle: true
  })
  const parsed: Delta[] = []
  // the reader holds back once its output is full, as a stream does, so it is drained
  demux.pipe(
    new Writable({
      objectMode: true,
      write(d: Delta, _encoding, done) {
        parsed.push(d)
        done()
      }
    })
  )
  return { demux, parsed }
}

/** a delta's values and meta, in order, with its context and timestamp */
function flatten(deltas: Delta[]): string[] {
  const out: string[] = []
  for (const d of deltas)
    for (const u of d.updates) {
      const at = new Date(u.timestamp).getTime()
      for (const v of u.values)
        out.push(`${d.context} ${at} ${v.path} ${JSON.stringify(v.value)}`)
      for (const m of u.meta ?? [])
        out.push(`${d.context} ${at} meta ${m.path} ${JSON.stringify(m.value)}`)
    }
  return out
}

describe('Simulator recorded delta log', function () {
  this.timeout(120000)
  let scenario: Scenario
  let startMs: number
  let endMs: number
  const lines: string[] = []
  let summary: RecordSummary

  before(async () => {
    scenario = await loadScenario(SAMPLES, SAMPLE, {
      minDepthUnderKeelM: 1,
      receiverAntennaHeightM: 10
    })
    startMs = scenario.legs[0].departMs
    endMs = startMs + MINUTES * 60000
    summary = recordRun(
      scenario,
      { startMs, endMs, showTraffic: true, seed: 1 },
      (line) => lines.push(line)
    )
  })

  it('writes lines the server reads whole through its file playback', async () => {
    const { demux, parsed } = serverReader()
    const liner = new Liner({})
    liner.on('data', (line: string) => demux.write(line))
    // the file in the reads a file stream makes, so long lines straddle them as they would
    for (let i = 0, text = lines.join('\n') + '\n'; i < text.length;) {
      const next = i + 65536
      liner.write(text.slice(i, next))
      i = next
    }
    liner.end()
    await new Promise((resolve) => setImmediate(resolve))
    expect(parsed).to.have.length(lines.length)
    for (const line of lines) expect(line.length).to.be.at.most(MAX_LINE_CHARS)
    // the reader stamps each update with the line's time, which is the delta's own
    parsed.forEach((d, i) => {
      const ms = Number(lines[i].split(';')[0])
      for (const u of d.updates)
        expect(new Date(u.timestamp).getTime()).to.equal(ms)
    })
  })

  it('gives every line the time of its delta, in time order', () => {
    let last = -Infinity
    for (const line of lines) {
      const [ms, kind, ...json] = line.split(';')
      expect(ms).to.match(/^\d{13}$/)
      expect(kind).to.equal('I')
      const delta: Delta = JSON.parse(json.join(';'))
      for (const u of delta.updates)
        expect(Date.parse(u.timestamp)).to.equal(Number(ms))
      expect(Number(ms)).to.be.at.least(last)
      last = Number(ms)
    }
    expect(Number(lines[0].split(';')[0])).to.equal(startMs)
    expect(last).to.equal(endMs)
  })

  it('holds the own boat and the targets', () => {
    const contexts = new Set(
      lines.map((l) => JSON.parse(l.split(';').slice(2).join(';')).context)
    )
    expect(contexts.has('vessels.self')).to.equal(true)
    const targets = [...contexts].filter((c) => c !== 'vessels.self')
    expect(targets.length).to.be.above(10)
    expect(summary.ownDeltas).to.be.above(0)
    expect(summary.targetDeltas).to.be.above(0)
  })

  it('holds every value the Simulation sent, in the order it sent them', async () => {
    const sent: Delta[] = []
    // a scenario of its own: the traffic is read through once per run
    const fresh = await loadScenario(SAMPLES, SAMPLE, {
      minDepthUnderKeelM: 1,
      receiverAntennaHeightM: 10
    })
    const sim = new Simulation(
      fresh,
      {
        timeMultiplier: 1,
        showTraffic: true,
        scenarioStartMs: startMs,
        seed: 1
      },
      (d) => sent.push(d),
      startMs
    )
    for (let t = startMs + RECORD_TICK_MS; t <= endMs; t += RECORD_TICK_MS)
      sim.tick(t)
    expect(summary.deltas).to.equal(sent.length)
    expect(summary.ownDeltas + summary.targetDeltas).to.equal(sent.length)
    expect(summary.lines).to.equal(lines.length)
    const logged = lines.map((l) => JSON.parse(l.split(';').slice(2).join(';')))
    expect(flatten(logged)).to.deep.equal(flatten(sent))
  })

  it('shares a long delta across lines, each within the limit', () => {
    const values = Array.from({ length: 200 }, (_, i) => ({
      path: `electrical.batteries.b${i}.voltage`,
      value: 12 + i / 100
    }))
    const meta = Array.from({ length: 30 }, (_, i) => ({
      path: `electrical.batteries.b${i}.voltage`,
      value: { displayName: `Battery ${i}`, description: 'x'.repeat(40) }
    }))
    const delta = {
      context: 'vessels.self',
      updates: [
        {
          source: { label: 'simulator', type: 'plugin' },
          timestamp: '2024-03-16T14:00:00.000Z',
          values,
          meta
        }
      ]
    } as unknown as Delta
    const out = logLines(delta)
    expect(out.length).to.be.above(5)
    for (const l of out) expect(l.length).to.be.at.most(MAX_LINE_CHARS)
    const back = out.map((l) => JSON.parse(l.split(';').slice(2).join(';')))
    expect(flatten(back)).to.deep.equal(flatten([delta]))
  })

  it('writes the file whole from the command line, and nothing on a failure', async () => {
    const tmp = mkdtempSync(path.join(os.tmpdir(), 'simulator-record-'))
    try {
      const out = path.join(tmp, 'run.log')
      const tool = path.join(__dirname, '..', 'simulator', 'tools', 'record.ts')
      const { stdout } = await run('npx', [
        'ts-node',
        tool,
        SAMPLE,
        '--hours',
        '0.05',
        '--no-traffic',
        '--out',
        out
      ])
      const text = readFileSync(out, 'utf8')
      expect(text.endsWith('\n')).to.equal(true)
      const written = text.trimEnd().split('\n')
      expect(stdout).to.contain(`${written.length} lines written`)
      for (const l of written)
        expect(JSON.parse(l.split(';').slice(2).join(';')).context).to.equal(
          'vessels.self'
        )
      expect(readdirSync(tmp)).to.deep.equal(['run.log'])

      const failed = path.join(tmp, 'failed.log')
      const refused = await run('npx', [
        'ts-node',
        tool,
        SAMPLE,
        '--multiplier',
        '10',
        '--out',
        failed
      ]).then(
        () => undefined,
        (error: { code: number; stderr: string }) => error
      )
      expect(refused?.code).to.equal(1)
      expect(refused?.stderr).to.contain('no multiplier')
      expect(existsSync(failed)).to.equal(false)
    } finally {
      await rm(tmp, { recursive: true, force: true })
    }
  })

  it('reads a written file through the server reader too', async () => {
    const tmp = mkdtempSync(path.join(os.tmpdir(), 'simulator-record-'))
    try {
      const out = path.join(tmp, 'run.log')
      await run('npx', [
        'ts-node',
        path.join(__dirname, '..', 'simulator', 'tools', 'record.ts'),
        SAMPLE,
        '--hours',
        '0.02',
        '--out',
        out
      ])
      const { demux, parsed } = serverReader()
      const liner = new Liner({})
      liner.on('data', (line: string) => demux.write(line))
      await new Promise<void>((resolve, reject) =>
        createReadStream(out)
          .pipe(liner)
          .on('finish', () => resolve())
          .on('error', reject)
      )
      await new Promise((resolve) => setImmediate(resolve))
      expect(parsed.length).to.equal(
        readFileSync(out, 'utf8').trimEnd().split('\n').length
      )
    } finally {
      await rm(tmp, { recursive: true, force: true })
    }
  })

  it('gives a replay the own boat identity in its vessel settings', async () => {
    const tmp = mkdtempSync(path.join(os.tmpdir(), 'simulator-replay-'))
    try {
      const log = path.join(tmp, 'run.log')
      writeFileSync(log, lines.slice(0, 200).join('\n') + '\n')
      await run('npx', [
        'ts-node',
        path.join(__dirname, '..', 'simulator', 'tools', 'replay-settings.ts'),
        log,
        tmp
      ])
      const editor = new DeltaEditor()
      editor.load(path.join(tmp, 'baseDeltas.json'))
      const vessel = scenario.route.vessel
      expect(editor.getSelfValue('name')).to.equal(vessel.name)
      expect(editor.getSelfValue('mmsi')).to.equal(vessel.mmsi)
      expect(editor.getSelfValue('design.length')).to.deep.equal({
        overall: vessel.lengthM
      })
      const settings = JSON.parse(
        readFileSync(path.join(tmp, 'settings.json'), 'utf8')
      )
      expect(
        settings.pipedProviders[0].pipeElements[0].options.subOptions
      ).to.deep.equal({
        dataType: 'Multiplexed',
        filename: log,
        keepRunning: false
      })
    } finally {
      await rm(tmp, { recursive: true, force: true })
    }
  })
})
