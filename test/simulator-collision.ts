import { expect } from 'chai'
import path from 'path'
import {
  CollisionWatch,
  Mover,
  WatchedTarget,
  closestApproach
} from '../simulator/ais/collision'
import { Scenario } from '../simulator/engine/scenario'
import { Simulation } from '../simulator/engine/simulation'
import { HeardTarget } from '../simulator/engine/traffic'
import { Route, routeLegs } from '../simulator/routes/route'
import { Delta, forSchema } from '../simulator/soak/deltas'

// eslint-disable-next-line @typescript-eslint/no-require-imports
const schema = require(
  require.resolve('@signalk/signalk-schema', {
    paths: [path.join(__dirname, '..', 'packages', 'streams')]
  })
)

const LAT = 25
const LON = -80
const M_PER_DEG = (6371000 * Math.PI) / 180
const KNOT = 1852 / 3600

/** a boat `east` and `north` metres from the own boat's position */
const at = (
  east: number,
  north: number,
  sogKn: number,
  cogDeg?: number
): Mover => ({
  lat: LAT + north / M_PER_DEG,
  lon: LON + east / (M_PER_DEG * Math.cos((LAT * Math.PI) / 180)),
  sogKn,
  cogDeg
})

describe('Simulator collision avoidance', () => {
  const own = at(0, 0, 10, 0)

  it('works out a target crossing ahead at right angles', () => {
    const a = closestApproach(own, at(500, 1000, 10, 270))!
    // closing at 10 kn each way: they meet the crossing point 250 m apart each side
    expect(a.timeToS).to.be.closeTo(1500 / (2 * 10 * KNOT), 0.5)
    expect(a.distanceM).to.be.closeTo(Math.hypot(250, 250), 1)
  })

  it('works out a target overtaking from astern', () => {
    const slow = at(0, 0, 5, 0)
    const a = closestApproach(slow, at(50, -500, 10, 0))!
    expect(a.timeToS).to.be.closeTo(500 / (5 * KNOT), 0.5)
    expect(a.distanceM).to.be.closeTo(50, 1)
  })

  it('works out a target on a reciprocal course', () => {
    const a = closestApproach(own, at(100, 2000, 10, 180))!
    expect(a.timeToS).to.be.closeTo(2000 / (20 * KNOT), 0.5)
    expect(a.distanceM).to.be.closeTo(100, 1)
  })

  it('works out a stopped target the boat is closing on', () => {
    const a = closestApproach(own, at(30, 1000, 0))!
    expect(a.timeToS).to.be.closeTo(1000 / (10 * KNOT), 0.5)
    expect(a.distanceM).to.be.closeTo(30, 1)
  })

  it('gives none for a target drawing away, or keeping station', () => {
    expect(closestApproach(own, at(0, -500, 0))).to.equal(undefined)
    expect(closestApproach(own, at(0, 800, 15, 0))).to.equal(undefined)
    expect(closestApproach(own, at(100, 100, 10, 0))).to.equal(undefined)
  })

  describe('the alarm', () => {
    const limits = { distanceM: 30, timeS: 120 }
    const target = (
      distanceM: number,
      timeToS: number,
      sogKn = 6
    ): WatchedTarget => ({
      context: 'vessels.urn:mrn:imo:mmsi:366000001',
      label: 'LUCY GOOSE',
      sogKn,
      approach: { distanceM, timeToS }
    })
    const step = (w: CollisionWatch, t: WatchedTarget) =>
      w.update([t], new Set()).notes.map((n) => n.value)

    it('warns inside the limits, alarms when close, holds to the margin and clears', () => {
      const w = new CollisionWatch(limits)
      expect(step(w, target(40, 100))).to.deep.equal([])
      expect(step(w, target(20, 200))).to.deep.equal([])
      expect(step(w, target(20, 110))).to.deep.equal([
        {
          state: 'warn',
          method: ['visual'],
          message: 'LUCY GOOSE: closest approach warning'
        }
      ])
      expect(step(w, target(20, 55))).to.deep.equal([
        {
          state: 'alarm',
          method: ['visual', 'sound'],
          message: 'LUCY GOOSE: closest approach alarm'
        }
      ])
      // out past the limits, but within the margin: held
      expect(step(w, target(35, 70))).to.deep.equal([])
      expect(step(w, target(35, 80))[0].state).to.equal('warn')
      expect(step(w, target(36, 130))).to.deep.equal([])
      expect(step(w, target(40, 130))[0]).to.include({ state: 'normal' })
      expect(w.active()).to.deep.equal([])
    })

    it('clears once the target is past and drawing away', () => {
      const w = new CollisionWatch(limits)
      step(w, target(10, 30))
      const passed = { ...target(0, 0), approach: undefined }
      expect(w.update([passed], new Set()).notes[0].value).to.deep.equal({
        state: 'normal',
        method: [],
        message: 'LUCY GOOSE: closest approach alarm'
      })
    })

    it('raises nothing for a target lying to its moorings', () => {
      const w = new CollisionWatch(limits)
      expect(step(w, target(5, 30, 0.3))).to.deep.equal([])
    })

    it('sends the approach with each report, every second when near, and null once past', () => {
      const w = new CollisionWatch(limits)
      const far = target(500, 600)
      const heard = new Set([far.context])
      expect(w.update([far], new Set()).approaches).to.deep.equal([])
      expect(w.update([far], heard).approaches).to.have.length(1)
      expect(w.update([target(50, 200)], new Set()).approaches).to.have.length(
        1
      )
      const past = { ...far, approach: undefined }
      expect(w.update([past], new Set()).approaches).to.deep.equal([
        { context: far.context, value: null }
      ])
      expect(w.update([past], new Set()).approaches).to.deep.equal([])
    })
  })

  describe('in a run', () => {
    const START = Date.parse('2024-03-16T14:00:00Z')
    const CONTEXT = 'vessels.urn:mrn:imo:mmsi:366000001'

    /** the own boat north at 10 kn from (25, -80); a target coming south down her track */
    function run() {
      const route: Route = {
        name: 'test',
        departure: new Date(START).toISOString(),
        vessel: { description: 'test', lengthM: 12, draftM: 1, typeCode: 37 },
        source: 'test',
        waypoints: [
          { name: 'A', lat: LAT, lon: LON, speedKn: 10 },
          { name: 'B', lat: LAT + 0.5, lon: LON }
        ]
      }
      let heard = true
      let lost = false
      const traffic = {
        restart() {},
        advance(_from: number, toMs: number) {
          if (lost) {
            lost = false
            heard = false
            return { heard: [], lost: [CONTEXT] }
          }
          if (!heard) return { heard: [], lost: [] }
          // 1000 m ahead at the start, 10 m to the east, closing at 20 kn
          const s = (toMs - START) / 1000
          const north = 1000 - 10 * KNOT * s
          const t = at(10, north, 10, 180)
          const target = {
            id: '366000001',
            context: CONTEXT,
            mmsi: '366000001',
            name: 'LUCY GOOSE',
            lat: t.lat,
            lon: t.lon,
            sogKn: 10,
            cogDeg: 180,
            turning: false,
            withStatic: false,
            atMs: toMs,
            station: { aisClass: 'A' },
            description: {},
            voyage: {}
          } as unknown as HeardTarget
          return { heard: [target], lost: [] }
        }
      }
      const scenario = {
        sampleId: 'test',
        route,
        plannedRoute: route,
        legs: routeLegs(route),
        adjustments: [],
        traffic,
        notes: []
      } as unknown as Scenario
      const sent: Delta[] = []
      const forgotten: string[] = []
      const sim = new Simulation(
        scenario,
        {
          timeMultiplier: 1,
          showTraffic: true,
          scenarioStartMs: START,
          seed: 1,
          forget: (c) => forgotten.push(`${c} after ${sent.length}`)
        },
        (d) => sent.push(d),
        0
      )
      return {
        sim,
        sent,
        forgotten,
        lose: () => {
          lost = true
        }
      }
    }

    const notes = (sent: Delta[]) =>
      sent
        .filter((d) => d.context === CONTEXT)
        .flatMap((d) => d.updates.flatMap((u) => u.values))
        .filter((v) => v.path === 'notifications.navigation.closestApproach')
        .map((v) => (v.value as { state: string }).state)

    it('puts the approach on the target, counting down, and raises its alarm', () => {
      const { sim, sent } = run()
      for (let i = 1; i <= 50; i++) sim.tick(i * 1000)
      const approaches = sent
        .filter((d) => d.context === CONTEXT)
        .flatMap((d) => d.updates.flatMap((u) => u.values))
        .filter((v) => v.path === 'navigation.closestApproach')
        .map((v) => v.value as { distance: number; timeTo: number })
      expect(approaches[0].distance).to.be.closeTo(10, 2)
      expect(approaches[0].timeTo).to.be.closeTo(97, 2)
      expect(approaches.at(-1)!.timeTo).to.be.below(approaches[0].timeTo - 40)
      expect(notes(sent)).to.deep.equal(['warn', 'alarm'])
      expect(sim.collisions.active()).to.have.length(1)
      for (const d of sent.filter((x) => x.context === CONTEXT)) {
        const v = schema.validateFull(
          schema.deltaToFull({ ...forSchema(d), context: CONTEXT })
        )
        expect(v.valid, JSON.stringify(v.errors)).to.equal(true)
      }
    })

    it('clears the alarm of a target lost mid-approach, and raises none while it is dropped', () => {
      const { sim, sent, forgotten, lose } = run()
      for (let i = 1; i <= 50; i++) sim.tick(i * 1000)
      lose()
      const from = sent.length
      sim.tick(51000)
      expect(notes(sent.slice(from))).to.deep.equal(['normal'])
      // the clear goes out before the target is dropped, so it does not bring it back
      const clearAt = sent.findIndex(
        (d, i) => i >= from && d.context === CONTEXT
      )
      expect(forgotten).to.deep.equal([`${CONTEXT} after ${clearAt + 1}`])
      const after = sent.length
      for (let i = 52; i <= 80; i++) sim.tick(i * 1000)
      expect(
        sent.slice(after).filter((d) => d.context === CONTEXT)
      ).to.deep.equal([])
      expect(sim.collisions.active()).to.deep.equal([])
    })
  })
})
