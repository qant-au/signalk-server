import { expect } from 'chai'
import { Route } from '../simulator/routes/route'
import { routeResource, routeResourceId } from '../simulator/routes/resource'
import { ScenarioClock } from '../simulator/soak/clock'
import {
  degreesToRadians,
  knotsToMetresPerSecond,
  ownBoatDelta
} from '../simulator/soak/deltas'

const ROUTE: Route = {
  name: 'Test passage',
  departure: '2024-01-01T00:00:00Z',
  vessel: { description: '12 m yacht', lengthM: 12, typeCode: 36 },
  source: 'test',
  waypoints: [
    { lat: -27.45, lon: 153.19, speedKn: 4 },
    { lat: -27.4, lon: 153.25 }
  ]
}

describe('simulator soak', () => {
  it('runs scenario time in step with the wall clock', () => {
    const clock = new ScenarioClock(Date.UTC(2024, 0, 1), 1_000_000)
    expect(clock.scenarioTime(1_000_000)).to.equal(Date.UTC(2024, 0, 1))
    expect(clock.scenarioTime(1_060_000)).to.equal(Date.UTC(2024, 0, 1, 0, 1))
  })

  it('sends the own boat in Signal K units, stamped with the time it is sent', () => {
    const scenario = Date.UTC(2024, 2, 16, 14)
    const sent = Date.UTC(2026, 10, 2, 2)
    const delta = ownBoatDelta(
      {
        lat: 25.8,
        lon: -80.15,
        sogKn: 10,
        cogDeg: 90,
        legIndex: 0,
        finished: false
      },
      scenario,
      sent
    )
    expect(delta.context).to.equal('vessels.self')
    const update = delta.updates[0]
    expect(update.timestamp).to.equal(new Date(sent).toISOString())
    const values = Object.fromEntries(
      update.values.map((v) => [v.path, v.value])
    )
    expect(values['navigation.position']).to.deep.equal({
      latitude: 25.8,
      longitude: -80.15
    })
    expect(values['navigation.speedOverGround']).to.be.closeTo(5.144, 0.001)
    expect(values['navigation.courseOverGroundTrue']).to.be.closeTo(
      Math.PI / 2,
      1e-12
    )
    expect(values['navigation.datetime']).to.equal(
      new Date(scenario).toISOString()
    )
    expect(knotsToMetresPerSecond(1)).to.be.closeTo(0.5144, 0.0001)
    expect(degreesToRadians(180)).to.be.closeTo(Math.PI, 1e-12)
  })

  it('publishes a route as a GeoJSON line under a stable id', () => {
    const resource = routeResource(ROUTE)
    expect(resource.feature.geometry.coordinates).to.deep.equal([
      [153.19, -27.45],
      [153.25, -27.4]
    ])
    const id = routeResourceId(ROUTE)
    expect(id).to.match(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
    )
    expect(routeResourceId(ROUTE)).to.equal(id)
    expect(routeResourceId({ ...ROUTE, name: 'Another' })).to.not.equal(id)
  })
})
