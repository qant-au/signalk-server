import { expect } from 'chai'
import { mkdtempSync, readFileSync } from 'fs'
import { rm } from 'fs/promises'
import { mock } from 'node:test'
import os from 'os'
import path from 'path'
import { Temporal } from '@js-temporal/polyfill'
import { parseTimeRangeParams, splitPathExpression } from '../src/api/history'
import { RecordKeeper } from '../simulator/history/keeper'
import { PLAYBACK_TICK_MS, RecordPlayback } from '../simulator/history/playback'
import {
  RecordHistory,
  ValuesRequest,
  aggregate,
  circularMean,
  durationMs
} from '../simulator/history/provider'
import {
  RECORD_ROWS,
  RECORD_STEP_MS,
  RunRecord,
  recordWords
} from '../simulator/history/record'
import simulatorPlugin from '../simulator/plugin/index'
import { Delta } from '../simulator/soak/deltas'

const SELF = 'vessels.urn:mrn:signalk:uuid:c0d79334-4e25-4245-8892-54e8ccc8021d'
const TARGET = 'vessels.urn:mrn:imo:mmsi:367123450'
const T0 = Date.parse('2024-03-16T12:00:00Z')
const RAD = Math.PI / 180

function own(values: { path: string; value: unknown }[]): Delta {
  return {
    context: 'vessels.self',
    updates: [
      {
        source: { label: 'simulator', type: 'plugin' },
        timestamp: new Date().toISOString(),
        values
      }
    ]
  }
}

function target(
  context: string,
  lat: number,
  lon: number,
  sog: number,
  cog: number
): Delta {
  return {
    ...own([
      { path: 'navigation.position', value: { latitude: lat, longitude: lon } },
      { path: 'navigation.speedOverGround', value: sog },
      { path: 'navigation.courseOverGroundTrue', value: cog },
      { path: 'navigation.state', value: 'motoring' }
    ]),
    context
  }
}

/**
 * A record of an hour: every second the speed rises by 0.01 from 1, the heading swings
 * across north, the position moves north, and a target is heard every 30 s
 */
function hourRecord(): RunRecord {
  const r = new RunRecord()
  for (let s = 0; s < 3600; s++) {
    const ms = T0 + s * 1000
    r.add(
      own([
        { path: 'navigation.speedOverGround', value: 1 + s * 0.01 },
        // 350° to 10° and back, every 40 s
        { path: 'navigation.headingTrue', value: heading(s) },
        {
          path: 'navigation.position',
          value: { latitude: 25 + s * 1e-5, longitude: -80 }
        },
        { path: 'navigation.state', value: 'motoring' },
        { path: 'environment.current', value: { drift: 1, setTrue: 2 } }
      ]),
      ms
    )
    if (s % 30 === 0) r.add(target(TARGET, 26, -80.1 + s * 1e-5, 5, 1), ms)
  }
  return r
}

function heading(s: number): number {
  const deg = 350 + (s % 40) / 2
  return (deg % 360) * RAD
}

const instant = (ms: number) => Temporal.Instant.fromEpochMilliseconds(ms)

/** a values query as the server's route parses one */
function query(q: Record<string, string>): ValuesRequest {
  const { timeRangeParams } = parseTimeRangeParams(q)
  return {
    ...(timeRangeParams as unknown as ValuesRequest),
    context: q.context,
    resolution: q.resolution === undefined ? undefined : Number(q.resolution),
    sourcePolicy: q.sourcePolicy as 'all' | undefined,
    pathSpecs: q.paths.split(',').map(splitPathExpression) as never
  }
}

function history(record: RunRecord, nowMs = T0 + 3599_000) {
  return new RecordHistory(() => record, {
    selfContext: SELF,
    nowMs: () => nowMs,
    unitsOf: (p) =>
      p === 'navigation.headingTrue' || p === 'navigation.courseOverGroundTrue'
        ? 'rad'
        : undefined
  })
}

describe('Simulator history', () => {
  describe('the record', () => {
    it('keeps every numeric path and the position, a row every ten seconds of scenario time holding the last value sent in it', () => {
      const r = hourRecord()
      expect(r.startMs).to.equal(T0)
      expect(r.endMs).to.equal(T0 + 3590_000)
      const rows = r.ownRows(T0, T0 + 3600_000)
      expect(rows).to.have.length(360)
      expect(rows[0].ms).to.equal(T0)
      // the last of the ten seconds in the first row: second 9
      expect(rows[0].value('navigation.speedOverGround')).to.be.closeTo(
        1.09,
        1e-12
      )
      expect(rows[1].value('navigation.position')).to.deep.equal([
        -80,
        25 + 19e-5
      ])
      // a string and an object are not numbers
      expect(rows[0].value('navigation.state')).to.equal(null)
      expect(r.ownPaths(T0, T0 + 3600_000)).to.deep.equal([
        'navigation.headingTrue',
        'navigation.position',
        'navigation.speedOverGround'
      ])
    })

    it('keeps each target as it was heard: its position, speed and course, a row for each ten seconds it was heard in', () => {
      const r = hourRecord()
      const rows = r.targetRows(TARGET, T0, T0 + 3600_000)
      expect(rows).to.have.length(120)
      expect(rows[1].ms).to.equal(T0 + 30_000)
      expect(rows[1].value('navigation.position')).to.deep.equal([
        -80.1 + 30e-5,
        26
      ])
      expect(rows[1].value('navigation.speedOverGround')).to.equal(5)
      expect(rows[1].value('navigation.courseOverGroundTrue')).to.equal(1)
      expect(r.targets(T0, T0 + 3600_000)).to.deep.equal([TARGET])
      expect(r.targetPaths(TARGET, T0, T0 + 3600_000)).to.deep.equal([
        'navigation.position',
        'navigation.speedOverGround',
        'navigation.courseOverGroundTrue'
      ])
    })

    it('holds a day at most, dropping the oldest, and its memory is fixed by its paths and target rows', () => {
      const r = new RunRecord(1000)
      const before = r.bytes
      for (let i = 0; i < RECORD_ROWS + 100; i++) {
        const ms = T0 + i * RECORD_STEP_MS
        r.add(own([{ path: 'a', value: i }]), ms)
        r.add(target(TARGET, 26, -80, 1, 1), ms)
      }
      const rows = r.ownRows(-Infinity, Infinity)
      expect(rows).to.have.length(RECORD_ROWS)
      expect(rows[0].value('a')).to.equal(100)
      // the targets' ring holds no more than it was given
      expect(r.targetRows(TARGET, -Infinity, Infinity)).to.have.length(1000)
      expect(r.startMs).to.equal(T0 + 100 * RECORD_STEP_MS)
      // a column of a day of doubles for the one path, and the target ring grown to its bound
      expect(r.bytes - before).to.equal(RECORD_ROWS * 8 + (1000 - 1000) * 32)
      expect(r.bytes).to.equal(RECORD_ROWS * (4 + 8 + 8 + 8) + 1000 * 32)
    })

    it('drops a target row more than a day older than the newest', () => {
      const r = new RunRecord()
      r.add(target(TARGET, 26, -80, 1, 1), T0)
      r.add(
        target('vessels.other', 26, -80, 1, 1),
        T0 + RECORD_ROWS * RECORD_STEP_MS
      )
      expect(r.targets(-Infinity, Infinity)).to.deep.equal(['vessels.other'])
    })

    it('saves and restores, and refuses a save for another sample', () => {
      const r = hourRecord()
      const saved = r.save({ sample: 'miami' })
      const back = RunRecord.restore(saved, 'miami')!
      expect(back.rows).to.equal(r.rows)
      const a = r.ownRows(T0, T0 + 3600_000)
      const b = back.ownRows(T0, T0 + 3600_000)
      expect(b.map((x) => x.value('navigation.position'))).to.deep.equal(
        a.map((x) => x.value('navigation.position'))
      )
      expect(b.map((x) => x.value('navigation.speedOverGround'))).to.deep.equal(
        a.map((x) => x.value('navigation.speedOverGround'))
      )
      expect(
        back
          .targetRows(TARGET, T0, T0 + 3600_000)
          .map((x) => x.value('navigation.position'))
      ).to.deep.equal(
        r
          .targetRows(TARGET, T0, T0 + 3600_000)
          .map((x) => x.value('navigation.position'))
      )
      // and carries on recording after it
      back.add(target(TARGET, 27, -81, 2, 2), T0 + 3600_000)
      expect(back.targetRows(TARGET, T0 + 3600_000, Infinity)).to.have.length(1)
      expect(RunRecord.restore(saved, 'saronic')).to.equal(undefined)
    })

    it('a keeper keeps the record across a resume and a restart, cuts it back to a restart earlier, and starts afresh with a fresh run', () => {
      const dir = mkdtempSync(path.join(os.tmpdir(), 'simulator-history-'))
      const file = path.join(dir, 'record.bin')
      const keeper = new RecordKeeper(
        () => file,
        () => undefined
      )
      keeper.begin('miami', T0, 'fresh')
      for (let s = 0; s < 600; s += 10)
        keeper.add(own([{ path: 'a', value: s }]), T0 + s * 1000)
      keeper.save()
      // a new process resuming reads it back
      const resumed = new RecordKeeper(
        () => file,
        () => undefined
      )
      resumed.begin('miami', T0 + 600_000, 'resume')
      expect(resumed.record.rows).to.equal(60)
      // a restart earlier drops what comes after
      resumed.begin('miami', T0 + 300_000, 'restart')
      expect(resumed.record.rows).to.equal(30)
      resumed.begin('miami', T0, 'fresh')
      expect(resumed.record.rows).to.equal(0)
      // another sample's record is not resumed
      const other = new RecordKeeper(
        () => file,
        () => undefined
      )
      other.begin('saronic', T0, 'resume')
      expect(other.record.rows).to.equal(0)
    })

    it('says how long it is for the status line', () => {
      const r = new RunRecord()
      expect(recordWords(r)).to.equal('record empty')
      r.add(own([{ path: 'a', value: 1 }]), T0)
      r.add(own([{ path: 'a', value: 1 }]), T0 + (2 * 60 + 14) * 60_000)
      expect(recordWords(r)).to.equal('record 2 h 14 min')
    })
  })

  describe('the History API', () => {
    const r = hourRecord()
    const h = history(r)

    it('takes every form of time range, a range with no end ending at the scenario time reached', async () => {
      const end = T0 + 3600_000
      const forms: [Record<string, string>, number, number][] = [
        [{ duration: 'PT10M' }, end - 600_000, end],
        [{ duration: '600' }, end - 600_000, end],
        [
          { from: '2024-03-16T12:10:00Z', duration: 'PT5M' },
          T0 + 600_000,
          T0 + 900_000
        ],
        [
          { to: '2024-03-16T12:10:00Z', duration: 'PT5M' },
          T0 + 300_000,
          T0 + 600_000
        ],
        [{ from: '2024-03-16T12:50:00Z' }, T0 + 3000_000, end],
        [
          { from: '2024-03-16T12:00:00Z', to: '2024-03-16T12:01:00Z' },
          T0,
          T0 + 60_000
        ]
      ]
      for (const [q, from, to] of forms) {
        const v = await h.getValues(
          query({ ...q, paths: 'navigation.speedOverGround' })
        )
        expect(v.range, JSON.stringify(q)).to.deep.equal({
          from: new Date(from).toISOString(),
          to: new Date(to).toISOString()
        })
        expect(v.data).to.have.length((to - from) / RECORD_STEP_MS)
      }
      expect(durationMs(Temporal.Duration.from('P1DT2H'))).to.equal(
        26 * 3600_000
      )
      expect(() => durationMs(Temporal.Duration.from('P1M'))).to.throw(
        'no fixed length'
      )
    })

    it('gives the values sent back, a row per ten seconds, and the position as [longitude, latitude]', async () => {
      const v = await h.getValues(
        query({
          from: '2024-03-16T12:00:00Z',
          to: '2024-03-16T12:01:00Z',
          paths: 'navigation.speedOverGround,navigation.position'
        })
      )
      expect(v.context).to.equal(SELF)
      expect(v.values).to.deep.equal([
        { path: 'navigation.speedOverGround', method: 'average' },
        { path: 'navigation.position', method: 'first' }
      ])
      expect(v.data[0][0]).to.equal('2024-03-16T12:00:00.000Z')
      expect(v.data[0][1]).to.be.closeTo(1.09, 1e-12)
      expect(v.data[2][2]).to.deep.equal([-80, 25 + 29e-5])
    })

    it('buckets at the resolution asked, every aggregate on a bucket of six rows', async () => {
      const ask = async (method: string) =>
        (
          await h.getValues(
            query({
              from: '2024-03-16T12:00:00Z',
              to: '2024-03-16T12:02:00Z',
              resolution: '60',
              paths: `navigation.speedOverGround:${method}`
            })
          )
        ).data.map((row) => row[1] as number)
      // the rows hold seconds 9, 19, ... 59: 1.09 to 1.59
      const first = [1.09, 1.19, 1.29, 1.39, 1.49, 1.59]
      const close = (got: number[], want: number[]) =>
        got.forEach((g, i) => expect(g).to.be.closeTo(want[i], 1e-9))
      close(await ask('average'), [1.34, 1.94])
      close(await ask('min'), [1.09, 1.69])
      close(await ask('max'), [1.59, 2.19])
      close(await ask('first'), [first[0], 1.69])
      close(await ask('last'), [first[5], 2.19])
      close(await ask('mid'), [1.34, 1.94])
      close(await ask('middle_index'), [first[3], 1.99])
      close(await ask('sma:2'), [1.34, 1.64])
      close(await ask('ema:0.5'), [1.34, 1.64])
      // the defaults: five buckets for sma, alpha 0.2 for ema
      close(await ask('sma'), [1.34, 1.64])
      close(await ask('ema'), [1.34, 1.34 * 0.8 + 1.94 * 0.2])
    })

    it('averages a path in radians round the circle, keeping its convention, and gives null where the samples cancel', async () => {
      expect(circularMean([359 * RAD, 1 * RAD])).to.be.closeTo(0, 1e-12)
      expect(circularMean([350 * RAD, 20 * RAD])).to.be.closeTo(5 * RAD, 1e-12)
      expect(circularMean([340 * RAD, 350 * RAD])).to.be.closeTo(
        345 * RAD,
        1e-12
      )
      expect(circularMean([-10 * RAD, -20 * RAD])).to.be.closeTo(
        -15 * RAD,
        1e-12
      )
      expect(circularMean([0, Math.PI])).to.equal(null)
      expect(
        aggregate(
          [[350 * RAD, 10 * RAD], [355 * RAD]],
          { aggregate: 'sma', parameter: ['2'] },
          true
        )
      ).to.deep.equal([0, circularMean([0, 355 * RAD])])
      const v = await h.getValues(
        query({
          from: '2024-03-16T12:00:00Z',
          to: '2024-03-16T12:01:00Z',
          resolution: '40',
          paths: 'navigation.headingTrue:average,navigation.headingTrue:max'
        })
      )
      // seconds 9, 19, 29, 39: 354.5°, 359.5°, 4.5°, 9.5°; their mean is 2°, not 182°
      expect(v.data[0][1] as number).to.be.closeTo(2 * RAD, 1e-9)
      // min and max are not angular
      expect(v.data[0][2] as number).to.be.closeTo(359.5 * RAD, 1e-9)
    })

    it('gives null where nothing was sent, below the record and ahead of it', async () => {
      const v = await h.getValues(
        query({
          from: '2024-03-16T11:59:40Z',
          to: '2024-03-16T12:00:20Z',
          paths:
            'navigation.speedOverGround,navigation.position,environment.depth.belowKeel'
        })
      )
      expect(
        v.data.map((row) => row.slice(1).map((x) => x === null))
      ).to.deep.equal([
        [true, true, true],
        [true, true, true],
        [false, false, true],
        [false, false, true]
      ])
      // a resolution finer than the record is the record's
      const fine = await h.getValues(
        query({
          duration: 'PT1M',
          resolution: '1',
          paths: 'navigation.speedOverGround'
        })
      )
      expect(fine.data).to.have.length(6)
    })

    it('answers for a target by its context, and lists the contexts heard and the paths sent', async () => {
      const v = await h.getValues(
        query({
          from: '2024-03-16T12:00:00Z',
          to: '2024-03-16T12:01:00Z',
          context: TARGET,
          paths: 'navigation.position,navigation.speedOverGround:max'
        })
      )
      expect(v.context).to.equal(TARGET)
      expect(v.data[0].slice(1)).to.deep.equal([[-80.1, 26], 5])
      expect(v.data[1].slice(1)).to.deep.equal([null, null])
      const all = parseTimeRangeParams({ duration: 'PT1H' }).timeRangeParams
      expect(await h.getContexts(all as never)).to.deep.equal([SELF, TARGET])
      expect(await h.getPaths(all as never)).to.deep.equal([
        'navigation.headingTrue',
        'navigation.position',
        'navigation.speedOverGround'
      ])
      expect(
        await h.getPaths({ ...(all as object), context: TARGET })
      ).to.have.length(3)
      // an hour before the record has none
      const before = parseTimeRangeParams({
        from: '2024-03-16T10:00:00Z',
        to: '2024-03-16T11:00:00Z'
      }).timeRangeParams
      expect(await h.getContexts(before as never)).to.deep.equal([])
      expect(await h.getPaths(before as never)).to.deep.equal([])
    })

    it('gives a source back under the source policy, and nothing for another source', async () => {
      const v = await h.getValues(
        query({
          duration: 'PT1M',
          sourcePolicy: 'all',
          paths: 'navigation.speedOverGround,navigation.speedOverGround|n2k.115'
        })
      )
      expect(v.values).to.deep.equal([
        {
          path: 'navigation.speedOverGround',
          method: 'average',
          $source: 'simulator'
        },
        {
          path: 'navigation.speedOverGround',
          method: 'average',
          $source: 'n2k.115'
        }
      ])
      expect(v.data.every((row) => row[2] === null)).to.equal(true)
      expect(v.data.some((row) => row[1] !== null)).to.equal(true)
    })

    it('takes the instants and durations the server hands over', async () => {
      const v = await h.getValues({
        from: instant(T0),
        duration: Temporal.Duration.from({ minutes: 1 }),
        pathSpecs: [
          {
            path: 'navigation.speedOverGround',
            aggregate: 'last',
            parameter: []
          }
        ]
      })
      expect(v.data).to.have.length(6)
    })
  })

  describe('the playback', () => {
    it('replays the record from a start time at the playback rate, and stops at its end', () => {
      const r = hourRecord()
      let wall = 0
      let tick: () => void = () => undefined
      let stopped = false
      const p = new RecordPlayback(
        () => r,
        SELF,
        () => wall,
        (f) => {
          tick = f
          return () => {
            stopped = true
          }
        }
      )
      let has: boolean | undefined
      p.hasAnyData(
        { startTime: new Date(T0 + 3000_000), playbackRate: 1 },
        (x) => {
          has = x
        }
      )
      expect(has).to.equal(true)
      p.hasAnyData(
        { startTime: new Date(T0 + 7200_000), playbackRate: 1 },
        (x) => {
          has = x
        }
      )
      expect(has).to.equal(false)
      const sent: Delta[] = []
      p.streamHistory(
        undefined,
        { startTime: new Date(T0 + 3000_000), playbackRate: '10' },
        (d) => sent.push(d as never)
      )
      wall += PLAYBACK_TICK_MS * 4
      tick()
      // ten seconds of record in a second at x10: the own row, then the target heard then
      expect(sent.map((d) => d.context)).to.deep.equal([SELF, TARGET])
      expect(sent[0].updates[0].timestamp).to.equal(
        new Date(T0 + 3000_000).toISOString()
      )
      expect(sent[0].updates[0].values.map((v) => v.path).sort()).to.deep.equal(
        [
          'navigation.headingTrue',
          'navigation.position',
          'navigation.speedOverGround'
        ]
      )
      expect(
        sent[0].updates[0].values.find((v) => v.path === 'navigation.position')!
          .value
      ).to.deep.equal({
        longitude: -80,
        latitude: 25 + 3009e-5
      })
      wall += 30_000
      tick()
      expect(sent.filter((d) => d.context === TARGET)).to.have.length(11)
      expect(stopped).to.equal(false)
      wall += 60_000
      tick()
      expect(stopped).to.equal(true)
    })

    it('gives a snapshot at a time: the own row and each target last heard', () => {
      const r = hourRecord()
      const p = new RecordPlayback(() => r, SELF)
      let deltas: Delta[] = []
      p.getHistory(new Date(T0 + 1800_000), [], (d) => {
        deltas = d as never
      })
      expect(deltas.map((d) => d.context)).to.deep.equal([SELF, TARGET])
      expect(deltas[1].updates[0].timestamp).to.equal(
        new Date(T0 + 1800_000).toISOString()
      )
    })
  })

  describe('the plugin', () => {
    const tmp = mkdtempSync(path.join(os.tmpdir(), 'simulator-history-plugin-'))

    before(() => {
      process.env.SIGNALK_SIMULATOR_SAMPLES = path.join(
        __dirname,
        '..',
        'simulator',
        'samples'
      )
    })

    after(async () => {
      mock.timers.reset()
      delete process.env.SIGNALK_SIMULATOR_SAMPLES
      await rm(tmp, { recursive: true, force: true })
    })

    it('registers its weather and history providers and the playback, records what it sends, and saves the record with the run', async () => {
      const providers: {
        weather?: {
          name: string
          methods: Record<string, (...a: unknown[]) => Promise<unknown>>
        }
        history?: RecordHistory
        playback?: RecordPlayback
      } = {}
      const errors: string[] = []
      const unregistered: string[] = []
      let status = ''
      const plugin = simulatorPlugin({
        handleMessage: () => undefined,
        setPluginStatus: (s: string) => {
          status = s
        },
        setPluginError: (message: string) => errors.push(message),
        getDataDirPath: () => tmp,
        error: (message: string) => errors.push(message),
        debug: () => undefined,
        registerDeltaInputHandler: () => undefined,
        resourcesApi: { setResource: async () => undefined },
        activateRoute: async () => undefined,
        clearDestination: async () => undefined,
        selfContext: SELF,
        getMetadata: () => undefined,
        registerWeatherProvider: (p: never) => {
          providers.weather = p
        },
        weatherApi: { unRegister: (id: string) => unregistered.push(id) },
        registerHistoryApiProvider: (p: never) => {
          providers.history = p
        },
        registerHistoryProvider: (p: never) => {
          providers.playback = p
        }
      } as unknown as Parameters<typeof simulatorPlugin>[0])
      mock.timers.enable({
        apis: ['setInterval', 'Date'],
        now: 1_700_000_000_000
      })
      const tick = async (n: number) => {
        for (let i = 0; i < n; i++) {
          mock.timers.tick(1000)
          await new Promise((resolve) => setImmediate(resolve))
        }
      }
      try {
        plugin.start({
          sample: 'miami-icw-2024-03-16',
          resume: false,
          timeMultiplier: 60,
          showTraffic: true
        })
        while (!status.startsWith('Under way') && !errors.length) await tick(1)
        await tick(30)
        expect(errors).to.deep.equal([])
        expect(providers.weather!.name).to.equal('Signal K Simulator')
        expect(Object.keys(providers.weather!.methods).sort()).to.deep.equal([
          'getForecasts',
          'getObservations',
          'getWarnings',
          'pluginId'
        ])
        const at = { latitude: 25.77, longitude: -80.18 }
        const observations = (await providers.weather!.methods.getObservations(
          at,
          {
            maxCount: 3
          }
        )) as { date: string; type: string }[]
        expect(observations).to.have.length(3)
        expect(observations[0].type).to.equal('observation')
        const points = (await providers.weather!.methods.getForecasts(
          at,
          'point',
          {
            maxCount: 2
          }
        )) as { date: string }[]
        expect(
          Date.parse(points[1].date) - Date.parse(points[0].date)
        ).to.equal(3600_000)
        expect(await providers.weather!.methods.getWarnings(at)).to.deep.equal(
          []
        )

        // the record has the half hour sent, the boat and the targets
        const v = await providers.history!.getValues(
          query({
            duration: 'PT10M',
            resolution: '60',
            paths: 'navigation.speedOverGround,navigation.position'
          })
        )
        expect(v.context).to.equal(SELF)
        expect(v.data).to.have.length(10)
        expect(v.data.every((row) => typeof row[1] === 'number')).to.equal(true)
        expect(v.data.every((row) => Array.isArray(row[2]))).to.equal(true)
        const contexts = await providers.history!.getContexts(
          parseTimeRangeParams({ duration: 'PT1H' }).timeRangeParams as never
        )
        expect(contexts[0]).to.equal(SELF)
        expect(contexts.length).to.be.greaterThan(10)
        expect(status).to.match(/, record \d+ min/)
        let has = false
        providers.playback!.hasAnyData(
          { startTime: new Date(Date.parse(v.range.from)), playbackRate: 1 },
          (x) => {
            has = x
          }
        )
        expect(has).to.equal(true)
      } finally {
        plugin.stop()
        mock.timers.reset()
      }
      expect(unregistered).to.deep.equal(['signalk-simulator'])
      const saved = RunRecord.restore(
        readFileSync(path.join(tmp, 'record.bin')),
        'miami-icw-2024-03-16'
      )
      expect(saved!.rows).to.be.greaterThan(100)
    })
  })
})
