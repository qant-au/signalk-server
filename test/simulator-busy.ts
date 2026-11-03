import { expect } from 'chai'
import {
  LIMITS,
  MinuteRow,
  SubscriberTotal,
  heapStillGrowing,
  heldBackInLog,
  judge,
  targetsInStatus
} from '../simulator/soak/busy'

function row(overrides: Partial<MinuteRow> = {}): MinuteRow {
  return {
    wallMinutes: 1,
    scenarioTime: '2024-03-16T15:00:00.000Z',
    clockBehindS: 5,
    ownBoatGapS: 1,
    serverDeltasPerS: 100,
    subscriberDeltasPerS: [100, 100],
    lagP99Ms: 20,
    lagMaxMs: 40,
    heapUsedMiB: 180,
    rssMiB: 450,
    cpuShare: 0.1,
    targetsInStatus: 300,
    targetsInTree: 300,
    pluginListMs: 5,
    vesselsTreeMs: 20,
    readersMaxMs: 30,
    ...overrides
  }
}

const all = (n: number): SubscriberTotal[] =>
  Array.from({ length: 2 }, () => ({ received: n, merged: 0, closed: false }))

describe('simulator busy run', () => {
  it('passes a run that kept up', () => {
    expect(judge([row(), row()], 1000, all(1000), 0)).to.deep.equal([])
  })

  it('fails when the scenario clock falls more than a minute behind', () => {
    const problems = judge(
      [row(), row({ clockBehindS: LIMITS.clockBehindS + 1 })],
      1000,
      all(1000),
      0
    )
    expect(problems).to.have.length(1)
    expect(problems[0]).to.contain('fell 61 s behind')
  })

  it('fails when a subscriber misses deltas, is merged under backpressure or is dropped', () => {
    const subscribers: SubscriberTotal[] = [
      { received: 1000, merged: 0, closed: false },
      { received: 998, merged: 0, closed: false },
      { received: 1000, merged: 3, closed: false },
      { received: 1000, merged: 0, closed: true }
    ]
    const problems = judge([row()], 1000, subscribers, 0)
    expect(problems).to.deep.equal([
      'subscriber 2 received 998 of 1000 deltas',
      'subscriber 3 received 1000 of 1000 deltas, 3 of them merged under backpressure',
      'subscriber 4 was disconnected'
    ])
  })

  it('fails when the server answers slower than a second, or not at all', () => {
    expect(judge([row({ pluginListMs: 1200 })], 10, all(10), 0)[0]).to.contain(
      '1200 ms'
    )
    expect(judge([row({ readersMaxMs: 1001 })], 10, all(10), 0)[0]).to.contain(
      '1001 ms'
    )
    expect(judge([row()], 10, all(10), 2)).to.deep.equal([
      '2 requests failed or went unanswered'
    ])
  })

  it('tells memory that levels off from memory still growing', () => {
    const levelling = [150, 170, 185, 192, 196, 198, 199, 200]
    expect(heapStillGrowing(levelling)).to.equal(undefined)
    const growing = [150, 170, 190, 210, 230, 250, 270, 290]
    expect(heapStillGrowing(growing)).to.contain('240 to 280 MiB')
    // a small rise on a small heap is noise, not a leak
    expect(heapStillGrowing([20, 20, 21, 22, 23, 24, 25, 26])).to.equal(
      undefined
    )
  })

  it('reads the target count from the plugin status', () => {
    expect(
      targetsInStatus(
        'Under way: 15:00 at x24, 8.5 kn, 379 AIS targets in range, 2 engines'
      )
    ).to.equal(379)
    expect(
      heldBackInLog(
        'signalk-simulator: stopped, 1290 deltas for lost targets held back\n'
      )
    ).to.equal(1290)
    expect(heldBackInLog('Stopped plugin')).to.equal(0)
    expect(targetsInStatus('Under way: 15:00 at x24, traffic off')).to.equal(
      undefined
    )
  })
})
