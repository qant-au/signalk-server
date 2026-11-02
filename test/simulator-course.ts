import { expect } from 'chai'
import { copyFileSync, mkdirSync, mkdtempSync, writeFileSync } from 'fs'
import { rm } from 'fs/promises'
import { mock } from 'node:test'
import os from 'os'
import path from 'path'
import simulatorPlugin from '../simulator/plugin/index'
import { routeResourceId } from '../simulator/routes/resource'
import {
  Route,
  Waypoint,
  nextPointIndex,
  positionAt,
  routeLegs,
  turnMiddleMs
} from '../simulator/routes/route'
import { Delta } from '../simulator/soak/deltas'
import { loadProfile } from '../simulator/vessels/profile'

const VESSELS = path.join(__dirname, '..', 'simulator', 'vessels')
const START = Date.parse('2018-07-13T07:00:00Z')
const MINUTE = 60000
const RAD = Math.PI / 180
const EARTH_RADIUS_M = 6371000
const profile = loadProfile('motor-yacht-20m', VESSELS)

function offset(from: Waypoint, bearingDeg: number, nm: number): Waypoint {
  return {
    lat: from.lat + (nm * Math.cos(bearingDeg * RAD)) / 60,
    lon:
      from.lon +
      (nm * Math.sin(bearingDeg * RAD)) / (60 * Math.cos(from.lat * RAD))
  }
}

/** out of a berth, a starboard and a port turn, a stop at anchor, and in to a berth */
function passage(name = 'course test'): Route {
  const legs: [number, number, number, Partial<Waypoint>?][] = [
    [90, 1, 6],
    [160, 2, 10],
    [100, 2, 10],
    [30, 2, 10, { anchor: true, holdS: 15 * 60 }],
    [300, 1, 6]
  ]
  const waypoints: Waypoint[] = []
  let at: Waypoint = { lat: 37.75, lon: 23.5 }
  legs.forEach(([bearing, nm, speedKn, extra], i) => {
    waypoints.push({ ...at, ...extra, name: `w${i}`, speedKn })
    at = offset(at, bearing, nm)
  })
  waypoints.push({ ...at, name: 'berth' })
  return {
    name,
    departure: new Date(START + 10 * MINUTE).toISOString(),
    vessel: {
      description: profile.name,
      lengthM: profile.lengthM,
      draftM: profile.draftM,
      typeCode: profile.typeCode,
      profile: profile.id
    },
    source: 'test',
    waypoints
  }
}

/** the Course API's cross track error: positive with the boat to the right of the track */
function crossTrackM(
  p: { latitude: number; longitude: number },
  from: Waypoint,
  to: Waypoint
): number {
  const angular = (a: Waypoint, b: Waypoint) => {
    const dLat = (b.lat - a.lat) * RAD
    const dLon = (b.lon - a.lon) * RAD
    return (
      2 *
      Math.asin(
        Math.sqrt(
          Math.sin(dLat / 2) ** 2 +
            Math.cos(a.lat * RAD) *
              Math.cos(b.lat * RAD) *
              Math.sin(dLon / 2) ** 2
        )
      )
    )
  }
  const bearing = (a: Waypoint, b: Waypoint) =>
    Math.atan2(
      Math.sin((b.lon - a.lon) * RAD) * Math.cos(b.lat * RAD),
      Math.cos(a.lat * RAD) * Math.sin(b.lat * RAD) -
        Math.sin(a.lat * RAD) *
          Math.cos(b.lat * RAD) *
          Math.cos((b.lon - a.lon) * RAD)
    )
  const v = { lat: p.latitude, lon: p.longitude }
  return (
    Math.asin(
      Math.sin(angular(from, v)) *
        Math.sin(bearing(from, v) - bearing(from, to))
    ) * EARTH_RADIUS_M
  )
}

describe('Simulator next route point', () => {
  const route = passage()
  const legs = routeLegs(route)

  it('starts on the first leg, holds a stop until it leaves, and ends with no point', () => {
    expect(nextPointIndex(legs, START)).to.equal(1)
    legs.forEach((leg, i) => {
      const mid = (leg.departMs + leg.arriveMs) / 2
      expect(nextPointIndex(legs, mid), `leg ${i}`).to.equal(i + 1)
    })
    const anchorLeg = legs.findIndex((l) => l.to.anchor)
    const holding = legs[anchorLeg].arriveMs + 5 * MINUTE
    expect(nextPointIndex(legs, holding)).to.equal(anchorLeg + 1)
    expect(nextPointIndex(legs, legs[anchorLeg + 1].departMs + 1)).to.equal(
      anchorLeg + 2
    )
    expect(nextPointIndex(legs, legs[legs.length - 1].arriveMs + 1)).to.equal(
      undefined
    )
  })

  it('passes a waypoint it turns through at the middle of the arc', () => {
    for (let i = 0; i < legs.length - 1; i++) {
      const turn = legs[i].turn
      if (!turn) continue
      const middle = turnMiddleMs(turn)
      expect(nextPointIndex(legs, turn.startMs + 1)).to.equal(i + 1)
      expect(nextPointIndex(legs, middle - 1)).to.equal(i + 1)
      expect(nextPointIndex(legs, middle + 1)).to.equal(i + 2)
      expect(nextPointIndex(legs, turn.endMs - 1)).to.equal(i + 2)
      expect(positionAt(legs, middle - 1).legIndex).to.equal(i)
      expect(positionAt(legs, middle + 1).legIndex).to.equal(i + 1)
      // the arc's middle is where the boat comes abeam of the waypoint, its closest to it
      const near = (t: number) => {
        const p = positionAt(legs, t)
        return Math.hypot(
          (p.lat - legs[i].to.lat) * 111195,
          (p.lon - legs[i].to.lon) * 111195 * Math.cos(p.lat * RAD)
        )
      }
      for (const f of [0.1, 0.3, 0.45, 0.55, 0.7, 0.9]) {
        const t = turn.startMs + f * (turn.endMs - turn.startMs)
        expect(near(middle)).to.be.at.most(near(t) + 1e-6)
      }
    }
  })
})

interface Event {
  kind: 'course' | 'clear' | 'position'
  pointIndex?: number
  href?: string
  ms?: number
  position?: { latitude: number; longitude: number }
}

describe('Simulator course', function () {
  const tmp = mkdtempSync(path.join(os.tmpdir(), 'simulator-course-'))
  const samples = path.join(tmp, 'samples')

  before(() => {
    mkdirSync(path.join(tmp, 'vessels'))
    copyFileSync(
      path.join(VESSELS, `${profile.id}.json`),
      path.join(tmp, 'vessels', `${profile.id}.json`)
    )
    for (const sample of ['first', 'second']) {
      mkdirSync(path.join(samples, sample), { recursive: true })
      writeFileSync(
        path.join(samples, sample, 'sample.json'),
        JSON.stringify({ id: sample })
      )
      writeFileSync(
        path.join(samples, sample, 'route.json'),
        JSON.stringify(passage(`${sample} passage`))
      )
    }
    process.env.SIGNALK_SIMULATOR_SAMPLES = samples
  })

  after(async () => {
    mock.timers.reset()
    delete process.env.SIGNALK_SIMULATOR_SAMPLES
    await rm(tmp, { recursive: true, force: true })
  })

  /** the plugin on mocked timers, with its course and positions in the order they went */
  async function sail(
    dataDir: string,
    settings: Record<string, unknown>,
    ticks: number
  ): Promise<{ events: Event[]; published: string[] }> {
    mkdirSync(dataDir, { recursive: true })
    const events: Event[] = []
    const published: string[] = []
    const errors: string[] = []
    let named = false
    const plugin = simulatorPlugin({
      handleMessage: (_id: string, delta: Partial<Delta>) => {
        named = true
        for (const u of delta.updates ?? []) {
          const datetime = u.values.find(
            (v) => v.path === 'navigation.datetime'
          )
          const position = u.values.find(
            (v) => v.path === 'navigation.position'
          )
          if (position && datetime) {
            events.push({
              kind: 'position',
              ms: Date.parse(datetime.value as string),
              position: position.value as Event['position']
            })
          }
        }
      },
      setPluginStatus: () => undefined,
      setPluginError: (message: string) => errors.push(message),
      getDataDirPath: () => dataDir,
      error: (message: string) => errors.push(message),
      debug: () => undefined,
      resourcesApi: {
        setResource: async (_type: string, id: string) => {
          published.push(id)
        }
      },
      activateRoute: async (route: { href: string; pointIndex: number }) => {
        events.push({ kind: 'course', ...route })
      },
      clearDestination: async () => {
        events.push({ kind: 'clear' })
      }
    })
    mock.timers.enable({
      apis: ['setInterval', 'Date'],
      now: 1_700_000_000_000
    })
    try {
      plugin.start({ seed: 2, ...settings })
      while (!named && !errors.length) {
        await new Promise((resolve) => setImmediate(resolve))
      }
      // the course is set once the scenario is up, before the first tick
      await new Promise((resolve) => setImmediate(resolve))
      expect(errors).to.deep.equal([])
      for (let i = 0; i < ticks; i++) {
        mock.timers.tick(1000)
        await new Promise((resolve) => setImmediate(resolve))
      }
    } finally {
      plugin.stop()
      mock.timers.reset()
    }
    return { events, published }
  }

  const legs = routeLegs(passage('first passage'))
  const href = `/resources/routes/${routeResourceId(passage('first passage'))}`
  const endS = (legs[legs.length - 1].arriveMs - START) / 1000

  let run: { events: Event[]; published: string[] }
  before(async () => {
    run = await sail(
      path.join(tmp, 'whole'),
      { sample: 'first', resume: false, startAtMinutes: 0 },
      Math.ceil(endS) + 30
    )
  })

  it('makes the published route the active route before the first position', () => {
    expect(run.published).to.include(routeResourceId(passage('first passage')))
    const first = run.events.find((e) => e.kind !== 'clear')!
    expect(first).to.deep.equal({ kind: 'course', href, pointIndex: 1 })
  })

  it('moves the next point on in the tick the boat passes it, one at a time', () => {
    let pointIndex: number | undefined
    let steps = 0
    for (const e of run.events) {
      if (e.kind === 'course') {
        if (pointIndex !== undefined) {
          expect(e.pointIndex).to.equal(pointIndex + 1)
          steps++
        }
        pointIndex = e.pointIndex
        expect(e.href).to.equal(href)
      } else if (e.kind === 'clear') {
        pointIndex = undefined
      } else {
        // every position goes out with the course already on the leg the boat is on
        expect(pointIndex, new Date(e.ms!).toISOString()).to.equal(
          nextPointIndex(legs, e.ms!)
        )
      }
    }
    expect(steps).to.equal(legs.length - 1)
  })

  it('clears the course on arrival, and sets nothing after', () => {
    const clears = run.events.filter((e) => e.kind === 'clear')
    expect(clears).to.have.length(1)
    const at = run.events.indexOf(clears[0])
    expect(
      run.events.slice(at + 1).filter((e) => e.kind === 'course')
    ).to.deep.equal([])
    const lastBefore = run.events
      .slice(0, at)
      .filter((e) => e.kind === 'position')
      .pop()!
    expect(lastBefore.ms).to.be.at.most(legs[legs.length - 1].arriveMs)
  })

  it('holds the track to within metres on a leg and cuts inside each turn', () => {
    const turns = legs.map((l) => l.turn)
    let straightMax = 0
    for (const e of run.events) {
      if (e.kind !== 'position') continue
      const i = nextPointIndex(legs, e.ms!)
      if (i === undefined || e.ms! < legs[0].departMs) continue
      const leg = legs[i - 1]
      if (e.ms! < leg.departMs) continue
      const inTurn = [turns[i - 2], turns[i - 1]].some(
        (t) => t && e.ms! >= t.startMs && e.ms! <= t.endMs
      )
      if (!inTurn) {
        straightMax = Math.max(
          straightMax,
          Math.abs(crossTrackM(e.position!, leg.from, leg.to))
        )
      }
    }
    expect(straightMax).to.be.above(0.5).and.below(12)
    for (let i = 0; i < legs.length - 1; i++) {
      const turn = legs[i].turn
      if (!turn) continue
      // abeam of the waypoint, the boat is inside the corner by about the arc's cut
      const before = run.events
        .filter((e) => e.kind === 'position' && e.ms! < turnMiddleMs(turn))
        .pop()!
      const xte = crossTrackM(before.position!, legs[i].from, legs[i].to)
      const cutM = turn.radiusM * (1 - Math.cos((turn.deltaDeg * RAD) / 2))
      expect(Math.sign(xte), `turn ${i}`).to.equal(Math.sign(turn.deltaDeg))
      expect(Math.abs(xte), `turn ${i}`).to.be.above(straightMax)
      expect(Math.abs(xte), `turn ${i}`).to.be.closeTo(
        Math.abs(cutM),
        straightMax + 2
      )
    }
  })

  it('sets the new route before the first position on a change of sample', async () => {
    const dir = path.join(tmp, 'change')
    await sail(dir, { sample: 'first', resume: true }, 1500)
    const { events } = await sail(dir, { sample: 'second', resume: true }, 5)
    const first = events.find((e) => e.kind !== 'clear')!
    expect(first).to.deep.equal({
      kind: 'course',
      href: `/resources/routes/${routeResourceId(passage('second passage'))}`,
      pointIndex: 1
    })
  })

  it('picks the course up at the right point on resume', async () => {
    const dir = path.join(tmp, 'resume')
    await sail(dir, { sample: 'first', resume: true }, 1500)
    const { events } = await sail(dir, { sample: 'first', resume: true }, 5)
    const course = events.find((e) => e.kind === 'course')!
    const position = events.find((e) => e.kind === 'position')!
    expect(events.indexOf(course)).to.be.below(events.indexOf(position))
    expect(course.pointIndex).to.equal(nextPointIndex(legs, position.ms!))
    expect(course.pointIndex).to.be.above(1)
  })
})
