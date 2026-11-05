import { expect } from 'chai'
import express from 'express'
import { AddressInfo } from 'net'
import { Server } from 'http'
import path from 'path'
import { Scenario } from '../simulator/engine/scenario'
import { Simulation } from '../simulator/engine/simulation'
import { Control, controlRoutes } from '../simulator/plugin/control'
import { Route, routeLegs } from '../simulator/routes/route'
import { loadProfile } from '../simulator/vessels/profile'
import { RunRecord } from '../simulator/history/record'
import { loadEnvironment } from '../simulator/weather/environment'
import { SampleWeather } from '../simulator/weather/provider'

const VESSELS = path.join(__dirname, '..', 'simulator', 'vessels')
const START = Date.parse('2024-03-16T14:00:00Z')
const MINUTE = 60000

function scenario(): Scenario {
  const profile = loadProfile('motor-yacht-20m', VESSELS)
  const route: Route = {
    name: 'test',
    departure: new Date(START).toISOString(),
    vessel: {
      description: profile.name,
      name: 'Test',
      lengthM: profile.lengthM,
      draftM: profile.draftM,
      typeCode: profile.typeCode,
      profile: profile.id
    },
    source: 'test',
    waypoints: [
      { name: 'A', lat: 25.0, lon: -80.0, speedKn: 10 },
      { name: 'B', lat: 25.5, lon: -80.0 }
    ]
  }
  return {
    sampleId: 'test',
    route,
    plannedRoute: route,
    legs: routeLegs(route),
    adjustments: [],
    profile,
    notes: []
  }
}

describe('Simulator REST surface', () => {
  let server: Server
  let base: string
  let simulation: Simulation
  let wallMs = 0
  const restarts: number[] = []
  const record = new RunRecord()

  before(async () => {
    const s = scenario()
    simulation = new Simulation(
      s,
      {
        timeMultiplier: 1,
        showTraffic: false,
        scenarioStartMs: START + 30 * MINUTE,
        seed: 1
      },
      (d) => record.add(d, simulation?.scenarioMs ?? START + 30 * MINUTE),
      0
    )
    // the Miami sample's weather, for the Weather API at the boat
    const weather = new SampleWeather(
      loadEnvironment(
        path.join(
          __dirname,
          '..',
          'simulator',
          'samples',
          'miami-icw-2024-03-16'
        )
      ),
      () => simulation.scenarioMs,
      'miami-icw-2024-03-16'
    )
    // a few of the model's steps, so the engines are running
    wallMs = 4000
    simulation.tick(wallMs)
    const control: Control = {
      run: () => ({
        options: { sample: 'test', showTraffic: false, seed: 1 },
        scenario: s,
        simulation,
        record,
        weather
      }),
      async setRun(change) {
        if (change.paused !== undefined || change.timeMultiplier !== undefined)
          simulation.retime(wallMs, {
            paused: change.paused,
            rate: change.timeMultiplier
          })
        if (change.scenarioMs === undefined) return
        if (change.scenarioMs < simulation.systems!.scenarioMs) {
          restarts.push(change.scenarioMs)
          return
        }
        simulation.jump(wallMs, change.scenarioMs)
      },
      faults: () => simulation.faults!
    }
    const app = express()
    app.use(express.json())
    const router = express.Router()
    controlRoutes(router, control)
    app.use('/plugins/signalk-simulator', router)
    server = app.listen(0)
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/plugins/signalk-simulator`
  })

  after(() => server.close())

  const call = async (method: string, p: string, body?: unknown) => {
    const res = await fetch(base + p, {
      method,
      headers: body ? { 'Content-Type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined
    })
    return { status: res.status, body: await res.json() }
  }

  it('reads the run', async () => {
    const { status, body } = await call('GET', '/run')
    expect(status).to.equal(200)
    expect(body.boat).to.include({ name: 'Test', profile: 'motor-yacht-20m' })
    expect(body.clock).to.include({ timeMultiplier: 1, paused: false })
    expect(body.clock.minutesIntoRoute).to.be.closeTo(30, 0.2)
    expect(body.position.state).to.equal('under way')
    expect(body.systems.enginesRunning).to.equal(2)
    expect(body.faults).to.deep.equal([])
    // the water she moves through; a motor boat has no sails
    expect(body.water.currentFrom).to.equal('seeded')
    expect(body.water.currentKn).to.be.within(0, 1)
    expect(body.water.currentSetDeg).to.be.within(0, 359)
    expect(body.water.speedThroughWaterKn).to.be.above(0)
    expect(body.water.leewayDeg).to.equal(0)
    expect(body.sails).to.equal(undefined)
    // the deck: under way by day, her one radar transmitting, the anchor up
    expect(body.deck).to.deep.include({
      lights: 'off',
      chainM: 0,
      windlass: false,
      trim: {},
      radars: { Radar: true }
    })
    expect(body.deck.stabilisers).to.equal(undefined)
    expect(body.nextPoint.bridge).to.equal(undefined)
    // her switches in their bank's order, the inverter standing by with the generator
    // or carrying the sockets, and nobody overboard
    expect(
      body.switches.map((s: { id: string; channel: number }) => [
        s.id,
        s.channel
      ])
    ).to.deep.equal([
      ['navLights', 1],
      ['anchorLight', 2],
      ['deckLights', 3],
      ['cabinLights', 4],
      ['freshWaterPump', 5],
      ['fridge', 6],
      ['freezer', 7],
      ['windlass', 8],
      ['radar', 9],
      ['bilgePump', 10]
    ])
    expect(
      body.switches.find((s: { id: string }) => s.id === 'radar')
    ).to.include({ name: 'Radar', state: 1 })
    expect(body.inverters).to.have.length(1)
    expect(body.inverters[0]).to.include({ id: 'inverter', bank: 'house' })
    expect(body.inverters[0].mode).to.be.oneOf(['inverting', 'standby'])
    expect(body.mob).to.deep.equal([])
  })

  it('reads the record and the Weather API at the boat', async () => {
    const { body } = await call('GET', '/run')
    expect(body.history.from).to.equal('2024-03-16T14:30:00.000Z')
    expect(body.history.rows).to.equal(record.rows)
    expect(body.history.bytes).to.equal(record.bytes)
    expect(body.weather.observation.type).to.equal('observation')
    expect(body.weather.observation.date).to.equal(
      new Date(simulation.scenarioMs).toISOString()
    )
    expect(body.weather.forecastTo).to.equal('2024-03-17T23:54:00.000Z')
    expect(body.weather.warnings).to.deep.equal([])
    // the instruments' weather alongside it
    expect(body.weather.windKn).to.be.a('number')
  })

  it('pauses, sets the multiplier and jumps, and refuses a bad change', async () => {
    let r = await call('PUT', '/run', { paused: true, timeMultiplier: 30 })
    expect(r.status).to.equal(200)
    expect(r.body.clock).to.include({ paused: true, timeMultiplier: 30 })
    r = await call('PUT', '/run', { minutesIntoRoute: 90 })
    // the answer gives the time jumped to, before the next tick has sent it
    expect(r.body.clock.minutesIntoRoute).to.equal(90)
    wallMs += 1000
    simulation.tick(wallMs)
    expect((await call('GET', '/run')).body.clock.minutesIntoRoute).to.equal(90)
    r = await call('PUT', '/run', {
      time: new Date(START + 10 * MINUTE).toISOString()
    })
    expect(r.status).to.equal(200)
    expect(restarts).to.deep.equal([START + 10 * MINUTE])
    expect((await call('PUT', '/run', { timeMultiplier: 0 })).status).to.equal(
      400
    )
    expect((await call('PUT', '/run', { paused: 'yes' })).status).to.equal(400)
    expect((await call('PUT', '/run', { time: 'soon' })).status).to.equal(400)
  })

  it('lists, raises and clears faults', async () => {
    let r = await call('GET', '/faults')
    expect(r.body.available.map((k: { kind: string }) => k.kind)).to.include(
      'gnssLost'
    )
    r = await call('POST', '/faults', { kind: 'gnssLost' })
    expect(r.status).to.equal(201)
    expect(r.body).to.include({ id: 'gnssLost:gnss', phase: 'developing' })
    expect(
      (await call('POST', '/faults', { kind: 'gnssLost' })).status
    ).to.equal(400)
    expect((await call('POST', '/faults', { kind: 'meteor' })).status).to.equal(
      400
    )
    expect((await call('POST', '/faults', {})).status).to.equal(400)
    r = await call('GET', '/faults')
    expect(r.body.active.map((f: { id: string }) => f.id)).to.deep.equal([
      'gnssLost:gnss'
    ])
    r = await call('DELETE', '/faults/gnssLost/gnss')
    expect(r.status).to.equal(200)
    expect(r.body.phase).to.equal('clearing')
    expect((await call('DELETE', '/faults/gnssLost/gnss')).status).to.equal(400)
  })
})
