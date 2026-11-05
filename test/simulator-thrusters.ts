import { expect } from 'chai'
import path from 'path'
import { Scenario } from '../simulator/engine/scenario'
import { Simulation } from '../simulator/engine/simulation'
import { Route, Waypoint, routeLegs } from '../simulator/routes/route'
import { Delta } from '../simulator/soak/deltas'
import {
  StaleStateError,
  SystemsModel,
  SystemsState
} from '../simulator/systems/model'
import {
  VesselProfile,
  listProfiles,
  loadProfile
} from '../simulator/vessels/profile'

const VESSELS = path.join(__dirname, '..', 'simulator', 'vessels')
const START = Date.parse('2024-03-16T13:50:00Z')
const MINUTE = 60000
const RAD = Math.PI / 180
const profiles = listProfiles(VESSELS).map((id) => loadProfile(id, VESSELS))
const byId = (id: string) => profiles.find((p) => p.id === id)!

function offset(from: Waypoint, bearingDeg: number, nm: number): Waypoint {
  return {
    lat: from.lat + (nm * Math.cos(bearingDeg * RAD)) / 60,
    lon:
      from.lon +
      (nm * Math.sin(bearingDeg * RAD)) / (60 * Math.cos(from.lat * RAD))
  }
}

/** out of a berth at 3 kn, a stop at anchor, out to sea at 10 kn, and back to a berth */
function berthToBerth(profile: VesselProfile): Scenario {
  const a: Waypoint = { lat: 25.75, lon: -80.18, speedKn: 3, name: 'berth' }
  const b = { ...offset(a, 90, 0.5), speedKn: 6, anchor: true, holdS: 1800 }
  const c = { ...offset(b, 90, 3), speedKn: 3 }
  const d = { ...offset(c, 270, 0.5), name: 'berth' }
  const route: Route = {
    name: 'thrusters',
    departure: new Date(START + 10 * MINUTE).toISOString(),
    vessel: {
      description: profile.name,
      lengthM: profile.lengthM,
      draftM: profile.draftM,
      typeCode: profile.typeCode,
      profile: profile.id
    },
    source: 'test',
    waypoints: [a, b, c, d]
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

interface Sample {
  ms: number
  state: string
  thrusters: Record<string, string>
  houseCurrentA?: number
  runS: Record<string, number>
}

/** every model step, ticked at the step rate */
function sail(profile: VesselProfile, seed = 1) {
  const scenario = berthToBerth(profile)
  const legs = scenario.legs
  const endMs = legs[legs.length - 1].arriveMs + 5 * MINUTE
  let pending: Delta[] = []
  const sim = new Simulation(
    scenario,
    { timeMultiplier: 1, showTraffic: false, scenarioStartMs: START, seed },
    (d) => pending.push(d),
    0
  )
  const samples: Sample[] = []
  for (let wall = 2000; START + wall <= endMs; wall += 2000) {
    pending = []
    sim.tick(wall)
    const v = new Map<string, unknown>()
    for (const d of pending)
      for (const u of d.updates)
        for (const x of u.values) v.set(x.path, x.value)
    const thrusters: Record<string, string> = {}
    const runS: Record<string, number> = {}
    for (const t of profile.thrusters) {
      thrusters[t.id] = v.get(`propulsion.${t.id}.state`) as string
      runS[t.id] = v.get(`propulsion.${t.id}.runTime`) as number
    }
    samples.push({
      ms: Date.parse(v.get('navigation.datetime') as string),
      state: v.get('navigation.state') as string,
      thrusters,
      houseCurrentA: v.get('electrical.batteries.house.current') as
        number | undefined,
      runS
    })
  }
  return { scenario, sim, samples }
}

describe('Simulator thrusters', () => {
  it('fits a bow thruster from 12 m, a stern thruster from 18 m, hydraulic from 30 m', () => {
    const fitted = Object.fromEntries(
      profiles.map((p) => [
        p.id,
        p.thrusters.map((t) => `${t.id} ${t.type} ${t.powerKw}`)
      ])
    )
    expect(fitted).to.deep.equal({
      'boat-4m': [],
      'electric-launch-7m': [],
      // a catamaran berths on its two engines, far apart
      'hybrid-catamaran-60ft': [],
      'motor-sailer-15m': ['bowThruster electric 8'],
      'motor-yacht-20m': [
        'bowThruster electric 14',
        'sternThruster electric 14'
      ],
      'motor-yacht-34m': [
        'bowThruster hydraulic 40.5',
        'sternThruster hydraulic 40.5'
      ],
      'motor-yacht-45m': [
        'bowThruster hydraulic 71',
        'sternThruster hydraulic 71'
      ],
      'sailing-yacht-15m': ['bowThruster electric 8'],
      'sailing-yacht-9m': [],
      'yacht-12m': ['bowThruster electric 5']
    })
  })

  for (const id of ['motor-yacht-20m', 'motor-yacht-45m', 'yacht-12m']) {
    it(`runs ${id}'s thrusters in bursts leaving and coming alongside, never at anchor or at sea`, () => {
      const p = byId(id)
      const { scenario, samples } = sail(p)
      const legs = scenario.legs
      for (const t of p.thrusters) {
        const running = samples.filter((s) => s.thrusters[t.id] === 'started')
        expect(running.length, `${t.id} ran`).to.be.above(0)
        for (const s of running) {
          expect(s.state, new Date(s.ms).toISOString()).to.equal('motoring')
          // only within the first or last few boat lengths: minutes from either berth
          const fromStart = s.ms - legs[0].departMs
          const toEnd = legs[legs.length - 1].arriveMs - s.ms
          expect(Math.min(fromStart, toEnd)).to.be.below(2 * MINUTE)
        }
        // in bursts: it starts and stops more than once on each manoeuvre
        let starts = 0
        samples.forEach((s, i) => {
          if (
            i &&
            s.thrusters[t.id] === 'started' &&
            samples[i - 1].thrusters[t.id] !== 'started'
          )
            starts++
        })
        expect(starts, `${t.id} bursts`).to.be.at.least(4)
        // a burst is a few seconds
        expect(running.length * 2).to.be.below(starts * 10)
      }
    })
  }

  it('pulls hundreds of amps from the house bank in a burst, on the energy books', () => {
    const p = byId('motor-yacht-20m')
    const { sim } = sail(p)
    const bow = sim.systems!.summary().thrusters.bowThruster
    const peak = bow.peak!
    // a 14 kW thruster on 24 V: the bank carries most of it, the alternators the rest
    expect(-peak.currentA).to.be.above(300)
    expect(-peak.currentA * peak.voltage).to.be.within(
      0.5 * peak.drawW,
      1.1 * peak.drawW
    )
    const house = sim.systems!.books().banks.find((b) => b.id === 'house')!
    expect(house.outJ.thrusters).to.be.above(0)
  })

  it('drives a hydraulic thruster off a running main engine, drawing no bank', () => {
    const p = byId('motor-yacht-45m')
    const { sim } = sail(p)
    for (const b of sim.systems!.books().banks) {
      expect(b.outJ.thrusters ?? 0, b.id).to.equal(0)
    }
    expect(sim.systems!.summary().thrusters.bowThruster.runS).to.be.above(0)
  })

  it('carries the thrusters through a saved run, and refuses one saved without them', () => {
    const p = byId('motor-yacht-20m')
    const m = new SystemsModel(p, { seed: 1, startMs: START })
    const saved = m.save()
    expect(saved.thrusters.map((t) => t.id)).to.deep.equal([
      'bowThruster',
      'sternThruster'
    ])
    const without = {
      ...saved,
      thrusters: undefined
    } as unknown as SystemsState
    expect(
      () => new SystemsModel(p, { seed: 1, startMs: START, state: without })
    ).to.throw(StaleStateError)
    expect(
      () =>
        new SystemsModel(p, {
          seed: 1,
          startMs: START,
          state: { ...saved, version: 4 }
        })
    ).to.throw(StaleStateError)
  })
})
