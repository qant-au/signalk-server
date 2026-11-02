import { expect } from 'chai'
import { readdirSync, readFileSync } from 'fs'
import path from 'path'
import { AisReport } from '../simulator/ais/targets'
import {
  DeriveConfig,
  passageBetween,
  simplify,
  waypointsFromPassage
} from '../simulator/routes/derive'
import {
  Route,
  initialCourseDeg,
  positionAt,
  routeLegs
} from '../simulator/routes/route'

const HOUR = 3600 * 1000

function route(overrides: Partial<Route> = {}): Route {
  return {
    name: 'test',
    departure: '2024-01-01T00:00:00Z',
    vessel: {
      description: 'test boat',
      lengthM: 12,
      draftM: 1.8,
      typeCode: 36
    },
    source: 'test',
    waypoints: [
      { lat: 0, lon: 0, speedKn: 6 },
      { lat: 0.1, lon: 0, speedKn: 3, holdS: 600 },
      { lat: 0.1, lon: 0.1 }
    ],
    ...overrides
  }
}

function report(
  timeMs: number,
  lat: number,
  lon: number,
  sogKn: number
): AisReport {
  return { id: 'v', timeMs, lat, lon, sogKn, target: {} }
}

const CONFIG: DeriveConfig = {
  startBox: [-1, -1, 1, 0.05],
  endBox: [-1, 0.95, 1, 2],
  minLengthM: 10,
  maxLengthM: 30,
  simplifyM: 50,
  minMovingKn: 1,
  minHoldS: 120,
  minLegKn: 3,
  maxLegKn: 16
}

describe('simulator routes', () => {
  describe('legs and timing', () => {
    it('times each leg from its speed and adds holds before leaving', () => {
      const legs = routeLegs(route())
      const start = Date.parse('2024-01-01T00:00:00Z')
      expect(legs).to.have.length(2)
      expect(legs[0].distanceNm).to.be.closeTo(6.0, 0.01)
      expect(legs[0].arriveMs - start).to.be.closeTo(HOUR, 60000)
      expect(legs[1].departMs - legs[0].arriveMs).to.equal(600 * 1000)
      expect(legs[1].arriveMs - legs[1].departMs).to.be.closeTo(2 * HOUR, 60000)
    })

    it('rejects a route without leg speeds or with one waypoint', () => {
      expect(() =>
        routeLegs(
          route({
            waypoints: [
              { lat: 0, lon: 0 },
              { lat: 1, lon: 0 }
            ]
          })
        )
      ).to.throw('no leg speed')
      expect(() =>
        routeLegs(route({ waypoints: [{ lat: 0, lon: 0, speedKn: 5 }] }))
      ).to.throw('at least two')
    })

    it('gives courses in degrees true', () => {
      expect(initialCourseDeg(0, 0, 1, 0)).to.be.closeTo(0, 1e-9)
      expect(initialCourseDeg(0, 0, 0, 1)).to.be.closeTo(90, 1e-9)
      expect(initialCourseDeg(0, 0, -1, 0)).to.be.closeTo(180, 1e-9)
      expect(initialCourseDeg(0, 0, 0, -1)).to.be.closeTo(270, 1e-9)
    })

    it('places the boat along the route, holding and finishing', () => {
      const legs = routeLegs(route())
      const start = Date.parse('2024-01-01T00:00:00Z')
      const before = positionAt(legs, start - 1000)
      expect(before).to.include({ lat: 0, lon: 0, sogKn: 0, finished: false })
      const half = positionAt(legs, start + HOUR / 2)
      expect(half.lat).to.be.closeTo(0.05, 0.001)
      expect(half).to.include({ sogKn: 6, legIndex: 0 })
      const holding = positionAt(legs, legs[0].arriveMs + 60000)
      expect(holding).to.include({ lat: 0.1, lon: 0, sogKn: 0, legIndex: 1 })
      const after = positionAt(legs, legs[1].arriveMs + 1)
      expect(after).to.include({ lat: 0.1, lon: 0.1, sogKn: 0, finished: true })
    })
  })

  describe('deriving a route from AIS', () => {
    it('simplifies a track, keeping the ends and any forced points', () => {
      const points = Array.from({ length: 11 }, (_, i) => ({
        lat: i * 0.001,
        lon: 0
      }))
      expect(simplify(points, 10)).to.deep.equal([0, 10])
      expect(simplify(points, 10, [4])).to.deep.equal([0, 4, 10])
      const bent = [...points, { lat: 0.01, lon: 0.01 }]
      expect(simplify(bent, 10)).to.deep.equal([0, 10, 11])
    })

    it('finds the passage between the boxes in either direction', () => {
      const north = [0, 0.5, 1].map((lat, i) => report(i * 1000, lat, 0, 6))
      expect(passageBetween(north, CONFIG)?.map((r) => r.lat)).to.deep.equal([
        0, 0.5, 1
      ])
      const south = [1, 0.5, 0].map((lat, i) => report(i * 1000, lat, 0, 6))
      expect(passageBetween(south, CONFIG)?.map((r) => r.lat)).to.deep.equal([
        0, 0.5, 1
      ])
      expect(
        passageBetween(north, { ...CONFIG, viaBoxes: [[0.5, 0.4, 0.6, 0.6]] })
      ).to.equal(undefined)
    })

    it('turns stops into holds and keeps only geometry and speeds', () => {
      const passage = [
        report(0, 0, 0, 6),
        report(600_000, 0.05, 0, 6),
        report(660_000, 0.05, 0, 0.2),
        report(960_000, 0.05, 0, 0.1),
        report(1_020_000, 0.051, 0, 8),
        report(1_620_000, 0.1, 0, 8)
      ]
      const waypoints = waypointsFromPassage(passage, CONFIG)
      expect(waypoints.map((w) => w.lat)).to.deep.equal([0, 0.05, 0.1])
      // from the first stopped report to the first moving one after it
      expect(waypoints[1].holdS).to.equal(360)
      expect(waypoints[0].speedKn).to.equal(6)
      expect(waypoints[1].speedKn).to.equal(8)
      for (const w of waypoints) {
        expect(Object.keys(w)).to.satisfy((keys: string[]) =>
          keys.every((k) => ['lat', 'lon', 'speedKn', 'holdS'].includes(k))
        )
      }
    })
  })

  describe('the sample routes', () => {
    const samples = path.join(__dirname, '..', 'simulator', 'samples')
    for (const sample of readdirSync(samples)) {
      it(`${sample} has a usable route with no source vessel identity`, () => {
        const text = readFileSync(
          path.join(samples, sample, 'route.json'),
          'utf8'
        )
        const r: Route = JSON.parse(text)
        const legs = routeLegs(r)
        expect(legs.length).to.be.greaterThan(2)
        expect(r.vessel.lengthM).to.be.within(10, 30)
        expect(text).to.not.match(/mmsi|vessel_id|craft_id|imo|call_?sign/i)
        for (const leg of legs) {
          expect(leg.speedKn).to.be.within(2, 16)
        }
        // harbour legs at either end are slower than the fastest open-water leg
        const fastest = Math.max(...legs.map((l) => l.speedKn))
        expect(legs[0].speedKn).to.be.lessThan(fastest)
        expect(legs[legs.length - 1].speedKn).to.be.lessThan(fastest)
      })
    }
  })
})
