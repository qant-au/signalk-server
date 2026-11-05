import { expect } from 'chai'
import { copyFileSync, mkdirSync, mkdtempSync, writeFileSync } from 'fs'
import { rm } from 'fs/promises'
import { mock } from 'node:test'
import os from 'os'
import path from 'path'
import { NotificationManager } from '../src/api/notifications/notificationManager'
import type { NotificationApplication } from '../src/api/notifications'
import { isNight } from '../simulator/deck/deck'
import { Scenario } from '../simulator/engine/scenario'
import { MobAlarm, Simulation } from '../simulator/engine/simulation'
import simulatorPlugin from '../simulator/plugin/index'
import { Route, Waypoint, routeLegs } from '../simulator/routes/route'
import { Delta, forSchema } from '../simulator/soak/deltas'
import { hasInverter } from '../simulator/switching/inverters'
import { mobFix, mobWords } from '../simulator/switching/mob'
import {
  bankChannels,
  bankPath,
  switchList,
  switchPath,
  switchValue
} from '../simulator/switching/switches'
import { SystemsSummary } from '../simulator/systems/model'
import {
  VesselProfile,
  listProfiles,
  loadProfile
} from '../simulator/vessels/profile'

// eslint-disable-next-line @typescript-eslint/no-require-imports
const schema = require(
  require.resolve('@signalk/signalk-schema', {
    paths: [path.join(__dirname, '..', 'packages', 'streams')]
  })
)

const VESSELS = path.join(__dirname, '..', 'simulator', 'vessels')
const MINUTE = 60000
const HOUR = 60 * MINUTE
/** the sun sets off Miami at about 23:28 UTC on this day, and rises at about 11:20 */
const MIDDAY = Date.parse('2024-03-16T17:00:00Z')
const NIGHT = Date.parse('2024-03-17T01:00:00Z')
const LAT = 25.5
const LON = -80

function scenarioFor(
  profile: VesselProfile,
  waypoints: Waypoint[],
  departMs: number
): Scenario {
  const route: Route = {
    name: 'switching test',
    departure: new Date(departMs).toISOString(),
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
  return {
    sampleId: 'test',
    route,
    plannedRoute: route,
    legs: routeLegs(route),
    adjustments: [],
    profile,
    depth: { depth: () => 8 } as unknown as Scenario['depth'],
    notes: []
  }
}

/** out of a berth, to an anchorage for this many hours, on, and in to a berth */
const viaAnchorage = (holdH: number, speedKn = 8): Waypoint[] => [
  { name: 'berth', lat: LAT, lon: LON, speedKn },
  {
    name: 'anchorage',
    lat: LAT + 2 / 60,
    lon: LON,
    speedKn,
    holdS: holdH * 3600,
    anchor: true
  },
  { name: 'north', lat: LAT + 6 / 60, lon: LON, speedKn },
  { name: 'in', lat: LAT + 7 / 60, lon: LON }
]

interface Tick {
  ms: number
  values: Map<string, unknown>
  summary: SystemsSummary
  lat: number
  lon: number
}

class Run {
  readonly sim: Simulation
  readonly sent: Delta[] = []
  private wallMs = 0

  constructor(
    readonly scenario: Scenario,
    startMs: number,
    rate = 10,
    extra: {
      mob?: MobAlarm
      systemsState?: Simulation['options']['systemsState']
    } = {}
  ) {
    this.sim = new Simulation(
      scenario,
      {
        timeMultiplier: rate,
        showTraffic: false,
        scenarioStartMs: startMs,
        seed: 1,
        ...extra
      },
      (d) => this.sent.push(d),
      0
    )
  }

  until(ms: number): Tick[] {
    const out: Tick[] = []
    while (this.sim.scenarioMs < ms) {
      const from = this.sent.length
      this.wallMs += 1000
      const result = this.sim.tick(this.wallMs)
      const values = new Map<string, unknown>()
      for (const d of this.sent.slice(from))
        for (const u of d.updates)
          for (const v of u.values) values.set(v.path, v.value)
      out.push({
        ms: this.sim.systems!.scenarioMs,
        values,
        summary: this.sim.systems!.summary(),
        lat: result.position.lat,
        lon: result.position.lon
      })
    }
    return out
  }

  /** a PUT as a display sends it */
  put(id: string, value: unknown) {
    return this.sim.systems!.putSwitch(id, switchValue(value)!)
  }

  book(name: string): number {
    return this.sim
      .systems!.books()
      .banks.reduce((sum, b) => sum + (b.outJ[name] ?? 0), 0)
  }
}

const profile = (id: string) => loadProfile(id, VESSELS)
const state = (t: Tick, id: string) => t.values.get(switchPath(id))
const lastTick = (ticks: Tick[]) => ticks[ticks.length - 1]

describe('Simulator switching', () => {
  describe('the switches', () => {
    it('reads the values KIP and the switch displays send', () => {
      for (const v of [1, true, 'on', 'ON', ' On '])
        expect(switchValue(v), String(v)).to.equal(true)
      for (const v of [0, false, 'off', 'Off'])
        expect(switchValue(v), String(v)).to.equal(false)
      for (const v of [2, -1, 'yes', '1', null, undefined, {}])
        expect(switchValue(v), String(v)).to.equal(undefined)
    })

    it('gives each boat its switches, the 4 m boat only her lights and bilge pump', () => {
      expect(switchList(profile('boat-4m')).map((s) => s.id)).to.deep.equal([
        'navLights',
        'bilgePump'
      ])
      expect(
        switchList(profile('motor-yacht-45m')).map((s) => s.id)
      ).to.deep.equal([
        'navLights',
        'anchorLight',
        'deckLights',
        'cabinLights',
        'freshWaterPump',
        'fridge',
        'freezer',
        'fuelTransferPump',
        'windlass',
        'stabilisers',
        'radarX',
        'radarS',
        'bilgePump'
      ])
      for (const id of listProfiles(VESSELS)) {
        const list = switchList(profile(id))
        const channels = bankChannels(profile(id))
        expect(list.length, id).to.be.at.most(16)
        // numbered from 1 in the list's order, and the same every time it is asked
        expect([...channels.values()], id).to.deep.equal(
          list.map((_, i) => i + 1)
        )
        expect([...bankChannels(profile(id))], id).to.deep.equal([...channels])
        for (const s of list)
          expect(s.displayName, `${id} ${s.id}`).to.be.a('string')
      }
    })
  })

  describe('the lights', () => {
    it('holds the navigation lights where they are put until the lights she should show change', () => {
      const run = new Run(
        scenarioFor(profile('motor-yacht-20m'), viaAnchorage(2), NIGHT),
        NIGHT - 2 * MINUTE
      )
      const under = run.until(NIGHT + 5 * MINUTE)
      expect(lastTick(under).values.get('navigation.lights')).to.equal(
        'motoring'
      )
      expect(state(lastTick(under), 'navLights')).to.equal(1)
      expect(run.put('navLights', 'off')).to.deep.equal({ ok: true })
      const dark = run.until(NIGHT + 12 * MINUTE).slice(1)
      for (const t of dark) {
        expect(t.values.get('navigation.lights')).to.equal('off')
        expect(state(t, 'navLights')).to.equal(0)
      }
      const before = run.book('navigation lights')
      run.until(NIGHT + 14 * MINUTE)
      expect(run.book('navigation lights')).to.equal(before)
      // she anchors: the lights she should show change, and the hand comes off
      const anchoredAt = run.scenario.legs[1].departMs - 2 * HOUR
      const anchored = run.until(anchoredAt + 5 * MINUTE)
      const t = lastTick(anchored)
      expect(t.values.get('navigation.state')).to.equal('anchored')
      expect(t.values.get('navigation.lights')).to.equal('anchored')
      expect(state(t, 'anchorLight')).to.equal(1)
      expect(state(t, 'navLights')).to.equal(0)
      // and the anchor light held off at anchor
      expect(run.put('anchorLight', false).ok).to.equal(true)
      const off = lastTick(run.until(anchoredAt + 8 * MINUTE))
      expect(off.values.get('navigation.lights')).to.equal('off')
      expect(state(off, 'anchorLight')).to.equal(0)
    })

    it('lights the navigation lights by day on a PUT, with their draw, until she anchors', () => {
      const run = new Run(
        scenarioFor(profile('motor-yacht-20m'), viaAnchorage(1), MIDDAY),
        MIDDAY + 8 * MINUTE
      )
      run.until(MIDDAY + 10 * MINUTE)
      expect(run.book('navigation lights')).to.equal(0)
      run.put('navLights', true)
      const lit = run.until(MIDDAY + 13 * MINUTE).slice(1)
      expect(
        lit.every((t) => t.values.get('navigation.lights') === 'motoring')
      ).to.equal(true)
      expect(run.book('navigation lights')).to.be.greaterThan(0)
      // she anchors: what she is doing changes, and the hand comes off
      const anchoredAt = run.scenario.legs[1].departMs - HOUR
      const t = lastTick(run.until(anchoredAt + 2 * MINUTE))
      expect(t.values.get('navigation.state')).to.equal('anchored')
      expect(t.values.get('navigation.lights')).to.equal('off')
      expect(state(t, 'navLights')).to.equal(0)
    })
  })

  describe('held off', () => {
    it('keeps the stabilisers off once switched off, with the roll back, until switched on', () => {
      const run = new Run(
        scenarioFor(
          profile('motor-yacht-34m'),
          [
            { name: 'berth', lat: LAT, lon: LON, speedKn: 12 },
            { name: 'north', lat: LAT + 0.5, lon: LON }
          ],
          MIDDAY
        ),
        MIDDAY
      )
      const roll = (ticks: Tick[]) =>
        ticks.reduce(
          (sum, t) =>
            sum +
            Math.abs(
              (t.values.get('navigation.attitude') as { roll: number }).roll
            ),
          0
        ) / ticks.length
      const on = run.until(MIDDAY + 30 * MINUTE).slice(-60)
      expect(on.every((t) => state(t, 'stabilisers') === 1)).to.equal(true)
      expect(run.put('stabilisers', 0)).to.deep.equal({ ok: true })
      const off = run.until(MIDDAY + 50 * MINUTE).slice(5)
      expect(off.every((t) => state(t, 'stabilisers') === 0)).to.equal(true)
      expect(
        off.every(
          (t) => (t.values.get('navigation.speedOverGround') as number) > 3
        )
      ).to.equal(true)
      expect(roll(off.slice(-60))).to.be.greaterThan(2 * roll(on))
      expect(run.put('stabilisers', 1)).to.deep.equal({ ok: true })
      const back = run.until(MIDDAY + 55 * MINUTE).slice(5)
      expect(back.every((t) => state(t, 'stabilisers') === 1)).to.equal(true)
    })

    it('holds a radar on standby, refuses it transmitting alongside, and lets it watch at anchor', () => {
      const run = new Run(
        scenarioFor(profile('motor-yacht-20m'), viaAnchorage(1), MIDDAY),
        MIDDAY - 10 * MINUTE
      )
      run.until(MIDDAY - 5 * MINUTE)
      expect(run.put('radar', 'on')).to.deep.equal({
        ok: false,
        message: 'the radar does not transmit alongside'
      })
      const leaving = run.until(MIDDAY + 5 * MINUTE)
      expect(state(lastTick(leaving), 'radar')).to.equal(1)
      run.put('radar', 'off')
      const anchoredAt = run.scenario.legs[1].departMs - HOUR
      const passage = run.until(anchoredAt - MINUTE).slice(1)
      expect(passage.every((t) => state(t, 'radar') === 0)).to.equal(true)
      // still on standby at anchor, until switched on to watch there
      run.until(anchoredAt + 5 * MINUTE)
      expect(run.put('radar', 1)).to.deep.equal({ ok: true })
      const watching = run.until(anchoredAt + 10 * MINUTE).slice(1)
      expect(watching.every((t) => state(t, 'radar') === 1)).to.equal(true)
      expect(lastTick(watching).values.get('navigation.state')).to.equal(
        'anchored'
      )
      // and a PUT can never make it transmit alongside, even held on
      const legs = run.scenario.legs
      const end = run.until(legs[legs.length - 1].arriveMs + 5 * MINUTE)
      expect(state(lastTick(end), 'radar')).to.equal(0)
    })
  })

  describe('the windlass', () => {
    it('heaves the chain in on a PUT, stops it where it is put off, and is refused with the anchor up', () => {
      const run = new Run(
        scenarioFor(profile('motor-yacht-20m'), viaAnchorage(2), MIDDAY),
        MIDDAY + 5 * MINUTE,
        2
      )
      expect(run.put('windlass', 1)).to.deep.equal({
        ok: false,
        message: 'the anchor is up'
      })
      const anchoredAt = run.scenario.legs[1].departMs - 2 * HOUR
      run.until(anchoredAt + 10 * MINUTE)
      const out = run.sim.systems!.summary().deck.chainM
      expect(out).to.be.greaterThan(40)
      const drawn = run.book('windlass')
      expect(run.put('windlass', true)).to.deep.equal({ ok: true })
      const heaving = run.until(anchoredAt + 11 * MINUTE).slice(2)
      expect(heaving.every((t) => state(t, 'windlass') === 1)).to.equal(true)
      const chain = (t: Tick) =>
        t.values.get('navigation.anchor.rodeCounterLength') as number
      expect(chain(lastTick(heaving))).to.be.lessThan(out - 10)
      expect(run.book('windlass')).to.be.greaterThan(drawn)
      expect(run.put('windlass', 'off')).to.deep.equal({ ok: true })
      const stopped = run.until(anchoredAt + 13 * MINUTE).slice(2)
      expect(stopped.every((t) => state(t, 'windlass') === 0)).to.equal(true)
      expect(new Set(stopped.map(chain)).size).to.equal(1)
      // on again, it comes in to short stay and stops itself
      run.put('windlass', 1)
      const short = lastTick(run.until(anchoredAt + 20 * MINUTE))
      expect(state(short, 'windlass')).to.equal(0)
      expect(chain(short)).to.be.closeTo(8 + 0.08 * 20, 0.05)
    })
  })

  describe('the house loads', () => {
    it('draws for the deck lights while they are on, and for the fresh water pump as water is drawn', () => {
      const run = new Run(
        scenarioFor(profile('motor-yacht-20m'), viaAnchorage(4), MIDDAY),
        MIDDAY + HOUR,
        10
      )
      const day = run.until(MIDDAY + 2 * HOUR)
      expect(day.every((t) => state(t, 'deckLights') === 0)).to.equal(true)
      expect(run.book('deck lights')).to.equal(0)
      // the pressure pump runs a few seconds every few minutes
      const pumping = day.filter((t) => state(t, 'freshWaterPump') === 1)
      expect(pumping.length).to.be.greaterThan(0)
      expect(pumping.length).to.be.lessThan(day.length / 4)
      expect(run.book('fresh water pump')).to.be.greaterThan(0)
      run.put('deckLights', 1)
      run.put('freshWaterPump', 0)
      const used = run.sim.systems!.summary().freshUsedL
      const lit = run.until(MIDDAY + 3 * HOUR).slice(1)
      expect(lit.every((t) => state(t, 'deckLights') === 1)).to.equal(true)
      expect(lit.every((t) => state(t, 'freshWaterPump') === 0)).to.equal(true)
      // 6 W a metre for the hour
      expect(run.book('deck lights')).to.be.closeTo(6 * 20 * 3600, 6 * 20 * 60)
      expect(run.sim.systems!.summary().freshUsedL).to.equal(used)
      expect(run.put('freshWaterPump', 1)).to.deep.equal({
        ok: true,
        message: 'on: it runs as water is drawn'
      })
      run.put('deckLights', 0)
      const back = run.until(MIDDAY + 4 * HOUR).slice(1)
      expect(back.every((t) => state(t, 'deckLights') === 0)).to.equal(true)
      expect(run.sim.systems!.summary().freshUsedL).to.be.greaterThan(used)
    })

    it('lets a fridge warm while switched off and cools it again when switched on', () => {
      const p = profile('motor-yacht-20m')
      const run = new Run(
        scenarioFor(p, viaAnchorage(8), MIDDAY),
        MIDDAY + HOUR,
        60
      )
      const temp = (t: Tick) =>
        (t.values.get('environment.inside.fridge.temperature') as number) -
        273.15
      run.until(MIDDAY + 2 * HOUR)
      const fridges = run.book('fridges')
      run.put('fridge', 'off')
      const warming = run
        .until(MIDDAY + 5 * HOUR)
        .filter((t) => t.values.has('environment.inside.fridge.temperature'))
      expect(warming.every((t) => state(t, 'fridge') === 0)).to.equal(true)
      expect(temp(lastTick(warming))).to.be.greaterThan(10)
      // the freezer's compressor still draws; the fridge's does not
      const freezerOnly = run.book('fridges') - fridges
      run.put('fridge', 'on')
      const cooling = run
        .until(MIDDAY + 8 * HOUR)
        .filter((t) => t.values.has('environment.inside.fridge.temperature'))
      expect(temp(lastTick(cooling))).to.be.lessThan(6)
      expect(run.book('fridges') - fridges).to.be.greaterThan(freezerOnly)
    })

    it('lights the cabin from sunset until the crew turns in, and holds a PUT until then', () => {
      const run = new Run(
        scenarioFor(profile('motor-yacht-20m'), viaAnchorage(8), MIDDAY),
        MIDDAY + 4 * HOUR,
        60
      )
      const ticks = run.until(NIGHT + 3 * HOUR)
      for (const t of ticks) {
        const hour = (((t.ms / HOUR + LON / 15) % 24) + 24) % 24
        const want = isNight(t.ms, t.lat, t.lon) && hour >= 6.5 && hour < 22.5
        expect(state(t, 'cabinLights'), new Date(t.ms).toISOString()).to.equal(
          want ? 1 : 0
        )
      }
      expect(run.put('cabinLights', 'on')).to.deep.equal({ ok: true })
      const late = run.until(NIGHT + 4 * HOUR).slice(1)
      expect(late.every((t) => state(t, 'cabinLights') === 1)).to.equal(true)
    })

    it("runs the 45 m yacht's fuel transfer pump on a PUT, and keeps it off once switched off", () => {
      const run = new Run(
        scenarioFor(profile('motor-yacht-45m'), viaAnchorage(4, 12), MIDDAY),
        MIDDAY - 10 * MINUTE,
        10
      )
      run.until(MIDDAY - 8 * MINUTE)
      const answer = run.put('fuelTransferPump', 1)
      expect(answer.ok).to.equal(true)
      const topping = run.until(MIDDAY - 5 * MINUTE).slice(1)
      if (answer.message === undefined) {
        expect(
          topping.some((t) => state(t, 'fuelTransferPump') === 1)
        ).to.equal(true)
        expect(run.book('fuel transfer pump')).to.be.greaterThan(0)
      } else {
        expect(answer.message).to.equal('the day tanks are full')
      }
      run.put('fuelTransferPump', 0)
      const held = run.until(MIDDAY + 4 * HOUR).slice(1)
      expect(held.every((t) => state(t, 'fuelTransferPump') === 0)).to.equal(
        true
      )
    })

    it('keeps the bilge pump off with water in the bilge until the high water float closes', () => {
      const run = new Run(
        scenarioFor(profile('motor-yacht-20m'), viaAnchorage(4), MIDDAY),
        MIDDAY + HOUR,
        2
      )
      run.until(MIDDAY + HOUR + MINUTE)
      run.sim.faults!.raise('bilgeFlooding', 'bilge')
      const filling = run.until(MIDDAY + HOUR + 4 * MINUTE)
      expect(filling.some((t) => state(t, 'bilgePump') === 1)).to.equal(true)
      expect(run.put('bilgePump', 0)).to.deep.equal({ ok: true })
      const off = run.until(MIDDAY + HOUR + 30 * MINUTE).slice(2)
      const closed = off.findIndex(
        (t) => t.values.get('electrical.switches.bilgeHighWater.state') === 1
      )
      expect(closed).to.be.greaterThan(0)
      for (const t of off.slice(0, closed))
        expect(state(t, 'bilgePump')).to.equal(0)
      // the high water float runs it again
      expect(
        off.slice(closed + 1).some((t) => state(t, 'bilgePump') === 1)
      ).to.equal(true)
      // and on the switch bank too
      const channel = bankChannels(profile('motor-yacht-20m')).get('bilgePump')!
      for (const t of off)
        expect(t.values.get(bankPath(channel))).to.equal(state(t, 'bilgePump'))
    })
  })

  describe('the switch bank', () => {
    it('sends every switch on its bank channel too, named, and keeps the numbers and holds across a restore', () => {
      const p = profile('motor-yacht-34m')
      const channels = bankChannels(p)
      const run = new Run(
        scenarioFor(p, viaAnchorage(1), MIDDAY),
        MIDDAY - 5 * MINUTE
      )
      const ticks = run.until(MIDDAY + 3 * MINUTE)
      for (const t of ticks) {
        for (const [id, n] of channels) {
          if (id === 'bilgePump') continue
          expect(t.values.get(bankPath(n)), `${id} ${n}`).to.equal(state(t, id))
        }
      }
      const meta = new Map(
        run.sent
          .flatMap((d) => d.updates.flatMap((u) => u.meta ?? []))
          .map((m) => [m.path, m.value.displayName])
      )
      for (const s of switchList(p)) {
        const n = channels.get(s.id)!
        expect(meta.get(`electrical.switches.bank.0.${n}`)).to.equal(
          s.displayName
        )
        expect(meta.get(`electrical.switches.bank.0.${n}.state`)).to.equal(
          s.displayName
        )
        expect(meta.get(`electrical.switches.${s.id}.state`)).to.equal(
          s.displayName
        )
      }
      run.put('deckLights', 1)
      run.put('radarS', 0)
      run.until(MIDDAY + 5 * MINUTE)
      const saved = run.sim.systems!.save()
      const again = new Run(
        scenarioFor(p, viaAnchorage(1), MIDDAY),
        saved.nowMs,
        10,
        { systemsState: saved }
      )
      const after = again.until(saved.nowMs + 5 * MINUTE)
      for (const t of after) {
        expect(state(t, 'deckLights')).to.equal(1)
        expect(state(t, 'radarS')).to.equal(0)
        expect(state(t, 'radarX')).to.equal(1)
        expect(t.values.get(bankPath(channels.get('deckLights')!))).to.equal(1)
      }
    })
  })

  describe('the inverter', () => {
    it('is sent on every profile with one, and on none of the rest', () => {
      const has: string[] = []
      for (const id of listProfiles(VESSELS)) {
        const p = profile(id)
        const run = new Run(
          scenarioFor(p, viaAnchorage(1), MIDDAY),
          MIDDAY + 5 * MINUTE
        )
        const t = lastTick(run.until(MIDDAY + 7 * MINUTE))
        const paths = [...t.values.keys()].filter((k) =>
          k.startsWith('electrical.inverters.')
        )
        if (hasInverter(p)) {
          has.push(id)
          expect(paths.sort(), id).to.deep.equal(
            [
              'ac.apparentPower',
              'ac.current',
              'ac.frequency',
              'ac.lineNeutralVoltage',
              'ac.realPower',
              'dc.current',
              'dc.voltage',
              'inverterMode'
            ].map((k) => `electrical.inverters.inverter.${k}`)
          )
        } else {
          expect(paths, id).to.deep.equal([])
        }
      }
      expect(has).to.deep.equal([
        'hybrid-catamaran-60ft',
        'motor-sailer-15m',
        'motor-yacht-20m',
        'sailing-yacht-15m',
        'yacht-12m'
      ])
    })

    it('stands by on shore power and with a generator running, and inverts what the books say otherwise', () => {
      const p = profile('motor-yacht-20m')
      const run = new Run(
        scenarioFor(p, viaAnchorage(8), MIDDAY),
        MIDDAY - 10 * MINUTE,
        60
      )
      const ticks = run.until(MIDDAY + 10 * HOUR)
      const modes = new Set<unknown>()
      let acJ = 0
      for (const t of ticks) {
        const mode = t.values.get('electrical.inverters.inverter.inverterMode')
        modes.add(mode)
        const alongside = t.values.get('navigation.state') === 'moored'
        if (alongside || t.summary.generatorsRunning > 0)
          expect(mode, new Date(t.ms).toISOString()).to.equal('standby')
        else expect(mode).to.be.oneOf(['inverting', 'idle'])
        const live = mode === 'inverting' || mode === 'idle'
        expect(
          t.values.get('electrical.inverters.inverter.ac.lineNeutralVoltage')
        ).to.equal(live ? p.acVoltage : 0)
        acJ += t.summary.inverter!.acW * 60
      }
      expect([...modes].sort()).to.deep.equal(['inverting', 'standby'])
      // what it puts out is what the books took from the house bank, less its losses
      const books = run.sim.systems!.books()
      const house = books.banks.find((b) => b.id === 'house')!
      expect(acJ).to.be.closeTo(
        0.9 * house.outJ.inverter,
        0.05 * house.outJ.inverter
      )
    })

    it('faults, sheds its loads and raises its alarm until it clears', () => {
      const run = new Run(
        scenarioFor(profile('motor-yacht-20m'), viaAnchorage(2), MIDDAY),
        MIDDAY + 2 * MINUTE,
        10
      )
      run.until(MIDDAY + 4 * MINUTE)
      expect(run.sim.systems!.summary().inverter!.mode).to.equal('inverting')
      run.sim.faults!.raise('inverterFailure', 'inverter')
      const before = run.book('inverter')
      const faulted = run.until(MIDDAY + 9 * MINUTE)
      for (const t of faulted) {
        expect(
          t.values.get('electrical.inverters.inverter.inverterMode')
        ).to.equal('faulted')
        expect(
          t.values.get('electrical.inverters.inverter.ac.realPower')
        ).to.equal(0)
        expect(
          t.values.get('electrical.inverters.inverter.ac.lineNeutralVoltage')
        ).to.equal(0)
      }
      expect(run.book('inverter')).to.equal(before)
      const alarm = faulted
        .map((t) =>
          t.values.get(
            'notifications.electrical.inverters.inverter.inverterMode'
          )
        )
        .find(Boolean) as { state: string; method: string[]; message: string }
      expect(alarm).to.deep.equal({
        state: 'alarm',
        method: ['visual', 'sound'],
        message: 'Inverter failure: no AC from the batteries'
      })
      run.sim.faults!.clear('inverterFailure', 'inverter')
      const back = run.until(MIDDAY + 11 * MINUTE)
      expect(
        back
          .map((t) =>
            t.values.get(
              'notifications.electrical.inverters.inverter.inverterMode'
            )
          )
          .find(Boolean)
      ).to.include({ state: 'normal' })
      expect(
        lastTick(back).values.get('electrical.inverters.inverter.inverterMode')
      ).to.equal('inverting')
    })
  })

  describe('a person overboard', () => {
    /** the server's own notification manager, reading her position from the deltas sent */
    function serverNotifications(run: () => Run) {
      const emitted: Delta[] = []
      let position: unknown
      const app = {
        handleMessage: (_id: string, delta: Delta) => emitted.push(delta),
        get signalk() {
          for (const d of run().sent)
            for (const u of d.updates)
              for (const v of u.values)
                if (v.path === 'navigation.position') position = v.value
          return { self: { navigation: { position: { value: position } } } }
        }
      }
      const manager = new NotificationManager(
        app as unknown as NotificationApplication
      )
      const mob: MobAlarm = {
        raise: (message) => manager.mob(message),
        resolve: (id) => manager.clear(id as never)
      }
      return { emitted, manager, mob }
    }

    it('raises MOB through the server at emergency where she was, stands the pilot by, follows the person, and resolves it when recovered', () => {
      const box: { run?: Run } = {}
      const server = serverNotifications(() => box.run!)
      const run = new Run(
        scenarioFor(profile('motor-yacht-20m'), viaAnchorage(1), MIDDAY),
        MIDDAY + 2 * MINUTE,
        2,
        { mob: server.mob }
      )
      box.run = run
      run.until(MIDDAY + 3 * MINUTE)
      const pilot = run.sim.pilot!
      pilot.engage()
      run.until(MIDDAY + 4 * MINUTE)
      expect(pilot.engaged).to.equal(true)
      // where she was, as her last position went out
      const sentAt = run.sent
        .flatMap((d) => d.updates.flatMap((u) => u.values))
        .filter((v) => v.path === 'navigation.position')
        .pop()!.value as { latitude: number; longitude: number }
      const at = { lat: sentAt.latitude, lon: sentAt.longitude }
      const fault = run.sim.faults!.raise('personOverboard')
      expect(fault.at).to.deep.equal(at)
      const ticks = run.until(MIDDAY + 6 * MINUTE)
      expect(pilot.engaged).to.equal(false)
      const raised = server.emitted
        .flatMap((d) => d.updates.flatMap((u) => u.values))
        .filter((v) => v.path.startsWith('notifications.mob.'))
      expect(raised).to.have.length(1)
      const value = raised[0].value as {
        state: string
        message: string
        position: { latitude: number; longitude: number }
      }
      expect(value.state).to.equal('emergency')
      expect(value.message).to.match(/^Person overboard at \d\d:\d\d:\d\d UTC$/)
      expect(value.position).to.deep.equal({
        latitude: at.lat,
        longitude: at.lon
      })
      // nothing else is raised for it: the boat's alarm panel stays out of it
      const ownNotes = ticks.flatMap((t) =>
        [...t.values.keys()].filter((k) => k.startsWith('notifications.'))
      )
      expect(ownNotes).to.deep.equal([])
      // she goes on north at 8 kn, so the person falls astern
      const mobs = run.sim.mobs()
      expect(mobs).to.have.length(1)
      const fix = mobs[0].fix!
      expect(fix.side).to.equal('astern')
      expect(fix.bearingDeg).to.be.closeTo(180, 5)
      expect(fix.distanceM).to.be.closeTo((2 * 60 * 8 * 1852) / 3600, 30)
      expect(mobs[0].words).to.equal(mobWords(fix))
      run.until(MIDDAY + 7 * MINUTE)
      expect(run.sim.mobs()[0].fix!.distanceM).to.be.greaterThan(fix.distanceM)
      // recovered
      const cleared = run.sim.faults!.clear('personOverboard', 'crew')
      expect(cleared.course).to.equal('recovered')
      run.until(MIDDAY + 8 * MINUTE)
      const id = Object.keys(server.manager.list)[0]
      expect(server.manager.list[id].value?.state).to.equal('normal')
      expect(run.sim.mobs()).to.deep.equal([])
    })

    it('follows a MOB another display raised on the server, and drops it when it is cleared', () => {
      const run = new Run(
        scenarioFor(profile('motor-yacht-20m'), viaAnchorage(1), MIDDAY),
        MIDDAY + 2 * MINUTE,
        2
      )
      run.until(MIDDAY + 4 * MINUTE)
      const here = run.sim.last!.position
      const at = { latitude: here.lat, longitude: here.lon + 0.01 }
      run.sim.heardMob('abc', {
        state: 'emergency',
        position: at,
        message: 'MOB'
      })
      const [m] = run.sim.mobs()
      expect(m.by).to.equal('notification')
      const p = run.sim.last!.position
      const fix = mobFix(
        {
          lat: p.lat,
          lon: p.lon,
          headingDeg: run.sim.systems!.pilotContext().headingDeg
        },
        { lat: at.latitude, lon: at.longitude }
      )
      expect(m.fix).to.deep.equal(fix)
      expect(fix.side).to.equal('to starboard')
      run.sim.heardMob('abc', { state: 'normal', position: at })
      expect(run.sim.mobs()).to.deep.equal([])
    })

    it('says where the person is from her bow', () => {
      const boat = { lat: LAT, lon: LON, headingDeg: 90 }
      const ahead = mobFix(boat, { lat: LAT, lon: LON + 0.001 })
      expect(ahead.side).to.equal('ahead')
      expect(mobFix(boat, { lat: LAT, lon: LON - 0.001 }).side).to.equal(
        'astern'
      )
      expect(mobFix(boat, { lat: LAT - 0.001, lon: LON }).side).to.equal(
        'to starboard'
      )
      expect(mobFix(boat, { lat: LAT + 0.001, lon: LON }).side).to.equal(
        'to port'
      )
      expect(
        mobWords({ distanceM: 120.4, bearingDeg: 263.2, side: 'astern' })
      ).to.equal('person overboard, 120 m astern, bearing 263°')
    })
  })

  describe('the plugin', () => {
    const tmp = mkdtempSync(path.join(os.tmpdir(), 'simulator-switching-'))
    const samples = path.join(tmp, 'samples')
    const p = profile('motor-yacht-20m')
    const departMs = Date.parse('2024-03-16T12:30:00Z')

    before(() => {
      mkdirSync(path.join(tmp, 'vessels'))
      copyFileSync(
        path.join(VESSELS, `${p.id}.json`),
        path.join(tmp, 'vessels', `${p.id}.json`)
      )
      mkdirSync(path.join(samples, 'switching'), { recursive: true })
      writeFileSync(
        path.join(samples, 'switching', 'sample.json'),
        JSON.stringify({ id: 'switching' })
      )
      writeFileSync(
        path.join(samples, 'switching', 'route.json'),
        JSON.stringify(scenarioFor(p, viaAnchorage(1), departMs).route)
      )
      process.env.SIGNALK_SIMULATOR_SAMPLES = samples
    })

    after(async () => {
      mock.timers.reset()
      delete process.env.SIGNALK_SIMULATOR_SAMPLES
      await rm(tmp, { recursive: true, force: true })
    })

    it("takes a PUT on every switch, by name and on the bank, answering as the server's ActionResult has it, and raises and resolves MOB through the Notifications API", async () => {
      type Handler = (
        context: string,
        path: string,
        value: unknown
      ) => { state: string; statusCode?: number; message?: string }
      const handlers = new Map<string, Handler>()
      const supportsPut: string[] = []
      const sent: Partial<Delta>[] = []
      const errors: string[] = []
      const subscribers: ((d: Delta) => void)[] = []
      let position: unknown
      const app = {
        handleMessage: (_id: string, delta: Partial<Delta>) => {
          sent.push(delta)
          for (const u of delta.updates ?? []) {
            for (const v of u.values ?? [])
              if (v.path === 'navigation.position') position = v.value
            for (const m of u.meta ?? [])
              if ((m.value as { supportsPut?: boolean }).supportsPut)
                supportsPut.push(m.path)
          }
        },
        get signalk() {
          return { self: { navigation: { position: { value: position } } } }
        }
      }
      const manager = new NotificationManager({
        handleMessage: (_id: string, delta: Delta) => {
          for (const s of subscribers) s(delta)
        },
        get signalk() {
          return app.signalk
        }
      } as unknown as NotificationApplication)
      const plugin = simulatorPlugin({
        handleMessage: app.handleMessage,
        setPluginStatus: () => undefined,
        setPluginError: (message: string) => errors.push(message),
        getDataDirPath: () => tmp,
        error: (message: string) => errors.push(message),
        debug: () => undefined,
        registerDeltaInputHandler: () => undefined,
        resourcesApi: { setResource: async () => undefined },
        activateRoute: async () => undefined,
        clearDestination: async () => undefined,
        registerPutHandler: (
          _context: string,
          putPath: string,
          handler: Handler
        ) => {
          handlers.set(putPath, handler)
          app.handleMessage('test', {
            updates: [
              { meta: [{ path: putPath, value: { supportsPut: true } }] }
            ]
          } as unknown as Partial<Delta>)
        },
        notifications: {
          mob: (message?: string) => manager.mob(message),
          clear: (id: string) => manager.clear(id as never)
        },
        subscriptionmanager: {
          subscribe: (
            _command: unknown,
            _unsubscribes: unknown,
            _error: unknown,
            callback: (d: Delta) => void
          ) => subscribers.push(callback)
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
          sample: 'switching',
          resume: false,
          startAtMinutes: 5,
          timeMultiplier: 2
        })
        while (!handlers.size && !errors.length)
          await new Promise((resolve) => setImmediate(resolve))
        expect(errors).to.deep.equal([])
        const channels = bankChannels(p)
        const expected = switchList(p).flatMap((s) => [
          switchPath(s.id),
          bankPath(channels.get(s.id)!)
        ])
        expect([...handlers.keys()].sort()).to.deep.equal(expected.sort())
        expect(supportsPut.sort()).to.deep.equal(expected.sort())
        await tick(5)
        const put = (at: string, value: unknown) =>
          handlers.get(at)!('vessels.self', at, value)
        expect(put(switchPath('deckLights'), true)).to.deep.equal({
          state: 'COMPLETED',
          statusCode: 200,
          message: undefined
        })
        expect(put(bankPath(channels.get('radar')!), 'off')).to.deep.include({
          state: 'COMPLETED',
          statusCode: 200
        })
        expect(put(switchPath('windlass'), 1)).to.deep.equal({
          state: 'COMPLETED',
          statusCode: 400,
          message: 'the anchor is up'
        })
        expect(put(switchPath('fridge'), 'maybe')).to.deep.equal({
          state: 'COMPLETED',
          statusCode: 400,
          message: 'a switch takes 1 or 0, true or false, "on" or "off"'
        })
        await tick(5)
        const latest = new Map<string, unknown>()
        for (const d of sent)
          for (const u of d.updates ?? [])
            for (const v of u.values ?? []) latest.set(v.path, v.value)
        expect(latest.get(switchPath('deckLights'))).to.equal(1)
        expect(latest.get(bankPath(channels.get('deckLights')!))).to.equal(1)
        expect(latest.get(switchPath('radar'))).to.equal(0)

        // a person overboard: the server's MOB alarm, raised and resolved
        const res = await fetchFaults(plugin, 'POST', {
          kind: 'personOverboard'
        })
        expect(res.status).to.equal(201)
        await tick(3)
        const raised = Object.values(manager.list)
        expect(raised).to.have.length(1)
        expect(raised[0].value?.state).to.equal('emergency')
        expect(raised[0].path).to.match(/^notifications\.mob\./)
        await fetchFaults(plugin, 'DELETE', undefined, '/personOverboard/crew')
        await tick(3)
        expect(Object.values(manager.list)[0].value?.state).to.equal('normal')
      } finally {
        plugin.stop()
        mock.timers.reset()
      }
    })
  })

  describe('the schema', () => {
    it('takes the inverter, and still has no place for the switches', () => {
      const run = new Run(
        scenarioFor(profile('motor-yacht-20m'), viaAnchorage(1), MIDDAY),
        MIDDAY + 20 * MINUTE
      )
      run.until(MIDDAY + 22 * MINUTE)
      const values = new Map<string, unknown>()
      for (const d of run.sent)
        for (const u of d.updates)
          for (const v of u.values) values.set(v.path, v.value)
      const valid = (p: string) => {
        const delta = {
          context: 'vessels.urn:mrn:imo:mmsi:230099999',
          updates: [
            {
              source: { label: 'simulator', type: 'test' },
              timestamp: new Date(MIDDAY).toISOString(),
              values: [{ path: p, value: values.get(p) }]
            }
          ]
        }
        return schema.validateFull(schema.deltaToFull(delta)).valid as boolean
      }
      const inverter = [...values.keys()].filter((k) =>
        k.startsWith('electrical.inverters.')
      )
      expect(inverter).to.have.length(8)
      for (const k of inverter) expect(valid(k), k).to.equal(true)
      const switches = [...values.keys()].filter((k) =>
        k.startsWith('electrical.switches.')
      )
      expect(switches).to.include('electrical.switches.bank.0.1.state')
      for (const k of switches) {
        expect(valid(k), k).to.equal(false)
        const kept = forSchema({
          context: 'vessels.self',
          updates: [
            {
              source: { label: 'simulator', type: 'test' },
              timestamp: '',
              values: [{ path: k, value: values.get(k) }]
            }
          ]
        }).updates[0].values
        expect(kept, k).to.deep.equal([])
      }
    })
  })
})

/** the plugin's faults routes, called as its REST surface would be */
async function fetchFaults(
  plugin: ReturnType<typeof simulatorPlugin>,
  method: 'POST' | 'DELETE',
  body?: unknown,
  suffix = ''
): Promise<{ status: number; body: unknown }> {
  const routes = new Map<
    string,
    (req: unknown, res: unknown) => Promise<void>
  >()
  const router = {
    get: () => undefined,
    put: () => undefined,
    post: (p: string, h: (req: unknown, res: unknown) => Promise<void>) =>
      routes.set(`POST ${p}`, h),
    delete: (p: string, h: (req: unknown, res: unknown) => Promise<void>) =>
      routes.set(`DELETE ${p}`, h)
  }
  plugin.registerWithRouter(router as never)
  const out = { status: 0, body: undefined as unknown }
  const res = {
    status(code: number) {
      out.status = code
      return res
    },
    json(b: unknown) {
      out.body = b
    }
  }
  const [, kind, target] = suffix.split('/')
  const handler = routes.get(
    method === 'POST' ? 'POST /faults' : 'DELETE /faults/:kind/:target'
  )!
  await handler({ body, params: { kind, target } }, res)
  return out
}
