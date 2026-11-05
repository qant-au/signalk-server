import { expect } from 'chai'
import { copyFileSync, mkdirSync, mkdtempSync, writeFileSync } from 'fs'
import { rm } from 'fs/promises'
import { mock } from 'node:test'
import os from 'os'
import path from 'path'
import {
  Scenario,
  listSamples,
  loadScenario
} from '../simulator/engine/scenario'
import simulatorPlugin from '../simulator/plugin/index'
import {
  DEAD_SLOW_KN,
  REGION_HALF_WIDTH_M,
  RESOURCE_TYPES,
  SampleResources,
  buffer,
  resourceCounts,
  routeResourceId,
  sampleResources
} from '../simulator/routes/resources'
import { Route, Waypoint } from '../simulator/routes/route'
import { Delta } from '../simulator/soak/deltas'
import { loadProfile } from '../simulator/vessels/profile'
import { validate } from '../src/api/resources/validate'

const SAMPLES = path.join(__dirname, '..', 'simulator', 'samples')
const VESSELS = path.join(__dirname, '..', 'simulator', 'vessels')
const METRES_PER_DEG = (6371000 * Math.PI) / 180
const RAD = Math.PI / 180

type Point = { lat: number; lon: number }

/** metres east and north of `origin` */
function local(origin: Point, p: Point): [number, number] {
  return [
    (p.lon - origin.lon) * METRES_PER_DEG * Math.cos(origin.lat * RAD),
    (p.lat - origin.lat) * METRES_PER_DEG
  ]
}

/** how far `p` is from the segment a-b, metres */
function toSegmentM(p: Point, a: Point, b: Point): number {
  const [bx, by] = local(a, b)
  const [px, py] = local(a, p)
  const len2 = bx * bx + by * by
  const t = len2 ? Math.max(0, Math.min(1, (px * bx + py * by) / len2)) : 0
  return Math.hypot(px - t * bx, py - t * by)
}

function inRing(p: Point, ring: [number, number][]): boolean {
  let inside = false
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i]
    const [xj, yj] = ring[j]
    if (
      yi > p.lat !== yj > p.lat &&
      p.lon < ((xj - xi) * (p.lat - yi)) / (yj - yi) + xi
    )
      inside = !inside
  }
  return inside
}

const middle = (a: Point, b: Point): Point => ({
  lat: (a.lat + b.lat) / 2,
  lon: (a.lon + b.lon) / 2
})

describe('Simulator resources along the routes', function () {
  this.timeout(60000)
  const scenarios = new Map<string, Scenario>()
  const resources = new Map<string, SampleResources>()

  before(async () => {
    for (const id of listSamples(SAMPLES)) {
      const s = await loadScenario(SAMPLES, id, {
        minDepthUnderKeelM: 1,
        receiverAntennaHeightM: 10
      })
      scenarios.set(id, s)
      resources.set(id, sampleResources(s.plannedRoute, s.route))
    }
  })

  it('gives every resource a stable id, distinct across the samples and the types', () => {
    const ids = new Set<string>()
    let n = 0
    for (const [id, s] of scenarios) {
      const again = sampleResources(s.plannedRoute, s.route)
      expect(again, id).to.deep.equal(resources.get(id))
      for (const type of RESOURCE_TYPES) {
        for (const r of resources.get(id)![type]) {
          expect(validate.uuid(r.id), r.id).to.equal(true)
          ids.add(r.id)
          n++
        }
      }
    }
    expect(ids.size).to.equal(n)
    expect(scenarios.size).to.equal(3)
  })

  it('keeps the route id the course has always followed', () => {
    for (const s of scenarios.values()) {
      expect(resources.get(s.sampleId)!.routes[0].id).to.equal(
        routeResourceId(s.route)
      )
    }
  })

  it('counts each sample', () => {
    const counts = Object.fromEntries(
      [...resources].map(([id, r]) => [id, resourceCounts(r)])
    )
    expect(counts).to.deep.equal({
      'manly-hamilton-island-2026-08-21': {
        routes: 1,
        waypoints: 29,
        notes: 0,
        regions: 2
      },
      'miami-icw-2024-03-16': { routes: 1, waypoints: 8, notes: 4, regions: 2 },
      'saronic-gulf-2018-07-13': {
        routes: 1,
        waypoints: 18,
        notes: 1,
        regions: 3
      }
    })
  })

  it('passes the server resource validation', () => {
    for (const r of resources.values()) {
      for (const type of RESOURCE_TYPES) {
        for (const { id, value } of r[type]) {
          expect(() => validate.resource(type, id, 'PUT', value)).not.to.throw()
        }
      }
    }
  })

  it('names each bridge, with its closed clearance and hold, and a note at it', () => {
    const miami = scenarios.get('miami-icw-2024-03-16')!
    const r = resources.get('miami-icw-2024-03-16')!
    const bridges = miami.plannedRoute.bridges!
    expect(bridges).to.have.length(4)
    for (const b of bridges) {
      const w = miami.plannedRoute.waypoints[b.waypoint]
      const wp = r.waypoints.find((x) => x.value.name === b.name)!.value
      expect(wp.type).to.equal('bridge')
      expect(wp.feature.properties).to.deep.equal({
        type: 'bridge',
        closedClearanceM: b.closedClearanceM,
        holdS: w.holdS
      })
      expect(wp.feature.geometry.coordinates).to.deep.equal([w.lon, w.lat])
      expect(wp.description).to.contain(`${b.closedClearanceM} m clearance`)
      const note = r.notes.find((x) => x.value.name === b.name)!.value
      expect(note.position).to.deep.equal({ latitude: w.lat, longitude: w.lon })
      expect(note.description).to.contain(`${b.closedClearanceM} m clearance`)
    }
    const kinds = r.waypoints.map((w) => w.value.type)
    expect(kinds.filter((k) => k === 'berth')).to.have.length(2)
  })

  it('puts a note at the anchorage with its note and stay', () => {
    const r = resources.get('saronic-gulf-2018-07-13')!
    const anchorage = r.waypoints.filter((w) => w.value.type === 'anchorage')
    expect(anchorage.map((w) => w.value.name)).to.deep.equal([
      'Skala bay, Angistri'
    ])
    expect(r.notes[0].value.name).to.equal('Skala bay, Angistri')
    expect(r.notes[0].value.description).to.match(
      /6 to 7 m on sand.*She stays 2 h 30 min\.$/
    )
    // the loop's berth, where she leaves and comes back, is one waypoint
    expect(
      r.waypoints.filter((w) => w.value.name === 'Zea Marina berth')
    ).to.have.length(1)
  })

  it('draws the dead slow regions where the slow legs are and nowhere else', () => {
    for (const [id, s] of scenarios) {
      const regions = resources
        .get(id)!
        .regions.map((r) => r.value.feature.geometry.coordinates[0])
      const wps = s.route.waypoints
      const slow: [Waypoint, Waypoint][] = []
      for (let i = 0; i < wps.length - 1; i++) {
        if (wps[i].speedKn! <= DEAD_SLOW_KN) slow.push([wps[i], wps[i + 1]])
      }
      for (let i = 0; i < wps.length - 1; i++) {
        const m = middle(wps[i], wps[i + 1])
        const inside = regions.some((ring) => inRing(m, ring))
        if (wps[i].speedKn! <= DEAD_SLOW_KN) {
          expect(inside, `${id} leg ${i}`).to.equal(true)
        } else if (
          slow.every(([a, b]) => toSegmentM(m, a, b) > REGION_HALF_WIDTH_M * 2)
        ) {
          expect(inside, `${id} leg ${i}`).to.equal(false)
        }
      }
      // every corner lies near a slow leg
      for (const ring of regions) {
        for (const [lon, lat] of ring) {
          const near = Math.min(
            ...slow.map(([a, b]) => toSegmentM({ lat, lon }, a, b))
          )
          expect(near).to.be.at.most(REGION_HALF_WIDTH_M * Math.SQRT2 + 1)
        }
      }
      for (const r of resources.get(id)!.regions) {
        expect(r.value.name).to.match(/, dead slow$/)
        expect(r.value.description).to.contain('not from a chart')
      }
    }
  })

  it('buffers a line squarely, closed and counter-clockwise', () => {
    const a = { lat: 25, lon: -80 }
    const b = { lat: 25, lon: -79.99 }
    const ring = buffer([a, b], 100)
    expect(ring).to.have.length(5)
    expect(ring[0]).to.deep.equal(ring[4])
    for (const [lon, lat] of ring) {
      expect(toSegmentM({ lat, lon }, a, b)).to.be.closeTo(100, 0.5)
    }
    // the shoelace sum is positive for a counter-clockwise ring
    let area = 0
    for (let i = 0; i < ring.length - 1; i++) {
      area += ring[i][0] * ring[i + 1][1] - ring[i + 1][0] * ring[i][1]
    }
    expect(area).to.be.above(0)
  })
})

describe('Simulator publishing the resources', function () {
  const tmp = mkdtempSync(path.join(os.tmpdir(), 'simulator-resources-'))
  const samples = path.join(tmp, 'samples')
  const profile = loadProfile('motor-yacht-20m', VESSELS)
  const START = Date.parse('2024-03-16T14:00:00Z')

  /** a berth, a bridge, an anchorage and a slow way in */
  const route: Route = {
    name: 'resources test',
    departure: new Date(START + 60000).toISOString(),
    vessel: {
      description: profile.name,
      lengthM: profile.lengthM,
      draftM: profile.draftM,
      typeCode: profile.typeCode,
      profile: profile.id
    },
    source: 'test',
    waypoints: [
      { name: 'Berth', lat: 25.0, lon: -80.0, speedKn: 3 },
      { name: 'Channel', lat: 25.005, lon: -80.0, speedKn: 10 },
      { lat: 25.03, lon: -80.0, speedKn: 10, holdS: 60 },
      {
        name: 'Bay',
        lat: 25.05,
        lon: -80.0,
        speedKn: 3,
        anchor: true,
        holdS: 120
      },
      { name: 'Way in', lat: 25.07, lon: -80.0, speedKn: 3 },
      { name: 'Arrival', lat: 25.075, lon: -80.0 }
    ],
    bridges: [{ waypoint: 2, name: 'Test bridge', closedClearanceM: 5 }]
  }

  before(() => {
    mkdirSync(path.join(tmp, 'vessels'))
    copyFileSync(
      path.join(VESSELS, `${profile.id}.json`),
      path.join(tmp, 'vessels', `${profile.id}.json`)
    )
    mkdirSync(path.join(samples, 'one'), { recursive: true })
    writeFileSync(
      path.join(samples, 'one', 'sample.json'),
      JSON.stringify({ id: 'one' })
    )
    writeFileSync(
      path.join(samples, 'one', 'route.json'),
      JSON.stringify(route)
    )
    process.env.SIGNALK_SIMULATOR_SAMPLES = samples
  })

  after(async () => {
    mock.timers.reset()
    delete process.env.SIGNALK_SIMULATOR_SAMPLES
    await rm(tmp, { recursive: true, force: true })
  })

  /** the plugin started, what it did in order, and what it logged */
  async function start(
    dataDir: string,
    setResource: (type: string, id: string) => Promise<void>
  ) {
    mkdirSync(dataDir, { recursive: true })
    const events: string[] = []
    const errors: string[] = []
    const logged: string[] = []
    let heard = false
    const plugin = simulatorPlugin({
      handleMessage: (_id: string, delta: Partial<Delta>) => {
        heard = true
        for (const u of delta.updates ?? []) {
          if (u.values.some((v) => v.path === 'navigation.position')) {
            events.push('position')
          }
        }
      },
      setPluginStatus: () => undefined,
      setPluginError: (message: string) => errors.push(message),
      getDataDirPath: () => dataDir,
      error: (message: string) => errors.push(message),
      debug: () => undefined,
      registerDeltaInputHandler: () => undefined,
      resourcesApi: {
        setResource: async (type: string, id: string) => {
          events.push(type)
          await setResource(type, id)
        }
      },
      activateRoute: async () => {
        events.push('course')
      },
      clearDestination: async () => undefined
    })
    const log = console.log
    console.log = (...args: unknown[]) => logged.push(args.join(' '))
    mock.timers.enable({ apis: ['setInterval', 'Date'], now: START })
    try {
      plugin.start({ seed: 1, sample: 'one', resume: false, startAtMinutes: 0 })
      while (!heard && !errors.length) {
        await new Promise((resolve) => setImmediate(resolve))
      }
      await new Promise((resolve) => setImmediate(resolve))
      for (let i = 0; i < 3; i++) {
        mock.timers.tick(1000)
        await new Promise((resolve) => setImmediate(resolve))
      }
    } finally {
      plugin.stop()
      mock.timers.reset()
      console.log = log
    }
    return { events, errors, logged }
  }

  it('publishes the route, then what is along it, before the course and the first position', async () => {
    const ids: string[] = []
    const { events, errors, logged } = await start(
      path.join(tmp, 'ok'),
      async (_type, id) => {
        ids.push(id)
      }
    )
    expect(errors).to.deep.equal([])
    const first = events.indexOf('course')
    expect(events.slice(0, first)).to.deep.equal([
      'routes',
      'waypoints',
      'waypoints',
      'waypoints',
      'waypoints',
      'waypoints',
      'waypoints',
      'notes',
      'notes',
      'regions',
      'regions'
    ])
    expect(events.indexOf('position')).to.be.above(first)
    expect(ids[0]).to.equal(routeResourceId(route))
    expect(logged.filter((l) => l.includes('published'))).to.deep.equal([
      'signalk-simulator: published 1 route, 6 waypoints, 2 notes, 2 regions'
    ])
  })

  it('says once when the server has no resources provider, and still sails', async () => {
    const { events, errors, logged } = await start(
      path.join(tmp, 'none'),
      async () => {
        throw new Error('No provider for routes')
      }
    )
    expect(errors).to.deep.equal([
      'could not publish the route or its resources: No provider for routes'
    ])
    expect(events.filter((e) => e === 'routes')).to.have.length(1)
    expect(
      events.some((e) => ['waypoints', 'notes', 'regions'].includes(e))
    ).to.equal(false)
    expect(events).to.include('position')
    expect(logged.filter((l) => l.includes('published'))).to.deep.equal([])
  })
})
