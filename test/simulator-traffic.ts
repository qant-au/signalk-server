import { expect } from 'chai'
import { mkdtempSync, writeFileSync } from 'fs'
import { rm } from 'fs/promises'
import os from 'os'
import path from 'path'
import { reportingIntervalSeconds } from '../simulator/ais/reception'
import { AisReport, readAisReports } from '../simulator/ais/targets'
import { NAV_STATES, targetDelta } from '../simulator/engine/deltas'
import { DroppedTargets } from '../simulator/engine/dropped'
import { Scenario } from '../simulator/engine/scenario'
import { Simulation } from '../simulator/engine/simulation'
import { Traffic } from '../simulator/engine/traffic'
import { Route, routeLegs } from '../simulator/routes/route'

// eslint-disable-next-line @typescript-eslint/no-require-imports
const schema = require(
  require.resolve('@signalk/signalk-schema', {
    paths: [path.join(__dirname, '..', 'packages', 'streams')]
  })
)

const MINUTE = 60000
const OPTIONS = { receiver: { antennaHeightM: 10 }, maxGapS: 900 }

function values(delta: {
  updates: { values: { path: string; value: unknown }[] }[]
}) {
  const out = new Map<string, unknown>()
  for (const u of delta.updates)
    for (const v of u.values) {
      if (v.path === '') {
        for (const [k, x] of Object.entries(v.value as object)) out.set(k, x)
      } else out.set(v.path, v.value)
    }
  return out
}

/** a track every minute for an hour, a mile north of the own boat at (0, 0) */
function track(
  id: string,
  extra: Partial<AisReport> = {},
  minutes = 60,
  latAt: (m: number) => number = () => 1 / 60
): AisReport[] {
  return Array.from({ length: minutes + 1 }, (_, m) => ({
    id,
    timeMs: m * MINUTE,
    lat: latAt(m),
    lon: 0,
    sogKn: 8,
    cogDeg: 90,
    headingDeg: 91,
    target: {
      typeCode: 70,
      lengthM: 120,
      beamM: 20,
      draughtM: 7.2,
      transceiver: 'A'
    },
    ...extra
  }))
}

describe('Simulator AIS traffic', () => {
  it('reads static, voyage and status columns, leaving out what is not there', async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'simulator-ais-'))
    writeFileSync(
      path.join(dir, 'ais.csv'),
      [
        'mmsi,time,lat,lon,sog,imo,call_sign,status,width,draft,dest,eta,rot',
        '366000001,2024-03-16T14:00:00Z,25.7,-80.2,9.5,IMO9395123,WDA1234,0,12,3.5,PORT EVERGLADES,2024-03-16T18:00:00Z,-6',
        '366000002,2024-03-16T14:00:00Z,25.7,-80.2,0,IMO0000000,,5,0,,,,'
      ].join('\n') + '\n'
    )
    const reports: AisReport[] = []
    for await (const r of readAisReports(dir, {
      file: 'ais.csv',
      idColumn: 'mmsi',
      timeColumn: 'time',
      timeFormat: 'iso-utc',
      latColumn: 'lat',
      lonColumn: 'lon',
      sogColumn: 'sog',
      imoColumn: 'imo',
      callSignColumn: 'call_sign',
      statusColumn: 'status',
      beamColumn: 'width',
      draughtColumn: 'draft',
      destinationColumn: 'dest',
      etaColumn: 'eta',
      rotColumn: 'rot'
    }))
      reports.push(r)
    await rm(dir, { recursive: true, force: true })
    expect(reports[0]).to.include({
      imo: '9395123',
      callSign: 'WDA1234',
      navStatus: 0,
      destination: 'PORT EVERGLADES',
      etaMs: Date.parse('2024-03-16T18:00:00Z'),
      rotDegMin: -6
    })
    expect(reports[0].target).to.include({ beamM: 12, draughtM: 3.5 })
    // an IMO of zeros, a zero beam and empty fields are not data
    expect(reports[1].imo).to.equal(undefined)
    expect(reports[1].callSign).to.equal(undefined)
    expect(reports[1].target.beamM).to.equal(undefined)
    expect(reports[1].navStatus).to.equal(5)
  })

  it('maps every AIS navigational status to a navigation.state the specification has', () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const enumValues = require(
      require.resolve(
        '@signalk/signalk-schema/schemas/groups/navigation.json',
        { paths: [path.join(__dirname, '..', 'packages', 'streams')] }
      )
    ).properties.state.allOf[1].properties.value.enum as string[]
    expect(NAV_STATES).to.have.length(16)
    for (const s of NAV_STATES) expect(enumValues).to.include(s)
    expect(NAV_STATES.slice(0, 9)).to.deep.equal([
      'motoring',
      'anchored',
      'not under command',
      'restricted manouverability',
      'constrained by draft',
      'moored',
      'aground',
      'fishing',
      'sailing'
    ])
  })

  it('sends each target in full: motion and class with every report, static data when due', () => {
    const traffic = new Traffic(
      track('366000001', {
        name: 'BESS TIMES',
        imo: '9395123',
        callSign: 'WDA1234',
        navStatus: 0,
        rotDegMin: 2,
        destination: 'PORT EVERGLADES',
        etaMs: Date.parse('2024-03-16T18:00:00Z')
      }),
      OPTIONS
    )
    const first = traffic.advance(0, 30000, 0, 0).heard[0]
    const full = values(targetDelta(first, 0))
    expect(first.withStatic).to.equal(true)
    expect(full.get('name')).to.equal('BESS TIMES')
    expect(full.get('mmsi')).to.equal('366000001')
    expect(full.get('communication')).to.deep.equal({ callsignVhf: 'WDA1234' })
    expect(full.get('registrations')).to.deep.equal({ imo: 'IMO 9395123' })
    expect(full.get('design.aisShipType')).to.deep.equal({
      id: 70,
      name: 'Cargo ship'
    })
    expect(full.get('design.length')).to.deep.equal({ overall: 120 })
    expect(full.get('design.beam')).to.equal(20)
    expect(full.get('design.draft')).to.deep.equal({ current: 7.2 })
    expect(full.get('navigation.destination.commonName')).to.equal(
      'PORT EVERGLADES'
    )
    expect(full.get('navigation.destination.eta')).to.equal(
      '2024-03-16T18:00:00.000Z'
    )
    expect(full.get('navigation.state')).to.equal('motoring')
    expect(full.get('navigation.rateOfTurn')).to.be.closeTo(
      (2 * Math.PI) / 180 / 60,
      1e-12
    )
    expect(full.get('sensors.ais.class')).to.equal('A')
    const d = {
      ...targetDelta(first, 0),
      context: 'vessels.urn:mrn:imo:mmsi:366000001'
    }
    const problems = (schema.validateFull(schema.deltaToFull(d)).errors ?? [])
      .map(
        (e: { dataPath: string; message: string }) =>
          `${e.dataPath} ${e.message}`
      )
      .filter((m: string) => !/url|uuid|aircraft|aton|sar/i.test(m))
    expect(problems).to.deep.equal([])

    // the next report, a minute on: motion and class, no static data
    const next = traffic.advance(30000, 90000, 0, 0).heard[0]
    const motion = values(targetDelta(next, 0))
    expect(next.withStatic).to.equal(false)
    expect(motion.has('name')).to.equal(false)
    expect(motion.has('design.length')).to.equal(false)
    expect(motion.get('sensors.ais.class')).to.equal('A')
    expect(motion.get('navigation.state')).to.equal('motoring')
  })

  it('leaves out what the source does not have, rather than making it up', () => {
    const traffic = new Traffic(
      track('anonymous-1', {
        headingDeg: undefined,
        target: { typeText: 'Pleasure craft', lengthM: 12 }
      }),
      OPTIONS
    )
    const v = values(targetDelta(traffic.advance(0, 30000, 0, 0).heard[0], 0))
    for (const path of [
      'name',
      'mmsi',
      'communication',
      'registrations',
      'design.aisShipType',
      'design.beam',
      'design.draft',
      'navigation.headingTrue',
      'navigation.rateOfTurn',
      'navigation.state',
      'navigation.destination.commonName'
    ]) {
      expect(v.has(path), path).to.equal(false)
    }
    expect(v.get('design.length')).to.deep.equal({ overall: 12 })
  })

  it('reports at the rate its class, speed, status and turning give', () => {
    expect(reportingIntervalSeconds('A', 0, 5)).to.equal(180)
    expect(reportingIntervalSeconds('A', 8, 0)).to.equal(10)
    expect(reportingIntervalSeconds('A', 8, 0, true)).to.be.closeTo(
      10 / 3,
      1e-9
    )
    expect(reportingIntervalSeconds('A', 18, 0, true)).to.equal(2)
    expect(reportingIntervalSeconds('B', 8)).to.equal(30)
    // a target turning hard reports more often than one holding its course
    const sends = (cog: (m: number) => number) => {
      const t = new Traffic(
        track('366000003').map((r, m) => ({ ...r, cogDeg: cog(m) })),
        OPTIONS
      )
      let n = 0
      for (let s = 1; s <= 1800; s++)
        n += t.advance((s - 1) * 1000, s * 1000, 0, 0).heard.length
      return n
    }
    const straight = sends(() => 90)
    const turning = sends((m) => (90 + 20 * m) % 360)
    expect(turning).to.be.above(2.5 * straight)
  })

  it('sends static data on the class interval, six minutes', () => {
    const t = new Traffic(track('366000004'), OPTIONS)
    let statics = 0
    for (let s = 1; s <= 60 * 60; s++) {
      for (const h of t.advance((s - 1) * 1000, s * 1000, 0, 0).heard)
        if (h.withStatic) statics++
    }
    expect(statics).to.be.within(10, 11)
  })

  it('loses a target that goes quiet and finds it again, static data first', () => {
    // in range, out of range for twenty minutes, back in range
    const far = (m: number) => (m >= 20 && m < 40 ? 2 : 1 / 60)
    const t = new Traffic(track('366000005', {}, 60, far), OPTIONS)
    const events: string[] = []
    for (let s = 1; s <= 60 * 60; s++) {
      const r = t.advance((s - 1) * 1000, s * 1000, 0, 0)
      for (const h of r.heard)
        if (h.withStatic) events.push(`static at ${Math.floor(s / 60)}`)
      for (const _ of r.lost) events.push(`lost at ${Math.floor(s / 60)}`)
    }
    const lost = events.filter((e) => e.startsWith('lost'))
    expect(lost).to.have.length(1)
    const lostAt = Number(lost[0].split(' ')[2])
    expect(lostAt).to.be.within(20, 25)
    // the first report heard again carries its static data, as on first hearing
    const back = events.filter(
      (e) => e.startsWith('static') && Number(e.split(' ')[2]) >= 40
    )
    expect(Number(back[0].split(' ')[2])).to.be.within(40, 41)
  })

  it('counts the targets present: forgotten when lost, all of them on stop', () => {
    const near = (m: number) => (m >= 20 && m < 40 ? 2 : 1 / 60)
    const route: Route = {
      name: 'still',
      departure: new Date(120 * MINUTE).toISOString(),
      vessel: { description: 'x', lengthM: 10, draftM: 1, typeCode: 37 },
      source: 'test',
      waypoints: [
        { lat: 0, lon: 0, speedKn: 1 },
        { lat: 0.001, lon: 0 }
      ]
    }
    const scenario: Scenario = {
      sampleId: 'test',
      route,
      plannedRoute: route,
      legs: routeLegs(route),
      adjustments: [],
      traffic: new Traffic(
        [...track('366000006', {}, 60, near), ...track('366000007')],
        OPTIONS
      ),
      notes: []
    }
    const present = new Set<string>()
    const sim = new Simulation(
      scenario,
      {
        timeMultiplier: 10,
        showTraffic: true,
        scenarioStartMs: 0,
        seed: 1,
        forget: (context) => present.delete(context)
      },
      (d) => {
        if (d.context !== 'vessels.self') present.add(d.context)
      },
      0
    )
    let dropped = false
    for (let wall = 1000; wall <= 360000; wall += 1000) {
      sim.tick(wall)
      expect(sim.trafficCount).to.equal(present.size)
      if (present.size === 1) dropped = true
    }
    expect(dropped).to.equal(true)
    expect(present.size).to.equal(2)
    sim.forgetAll()
    expect(present.size).to.equal(0)
    expect(sim.trafficCount).to.equal(0)
  })
  it("holds back other plugins' deltas for a dropped target until it is heard again", () => {
    const dropped = new DroppedTargets()
    const present = new Set<string>()
    const fromSimulator = (context: string) => {
      dropped.heard(context)
      present.add(context)
    }
    // the server's AIS status plugin, marking a target lost on its own timer
    const fromStatusPlugin = (context: string) => {
      if (!dropped.holdsBack(context)) present.add(context)
    }
    fromSimulator('vessels.urn:mrn:imo:mmsi:1')
    fromSimulator('vessels.urn:mrn:imo:mmsi:2')
    fromStatusPlugin('vessels.urn:mrn:imo:mmsi:2')
    expect(dropped.heldBack).to.equal(0)

    present.delete('vessels.urn:mrn:imo:mmsi:1')
    dropped.forget('vessels.urn:mrn:imo:mmsi:1')
    fromStatusPlugin('vessels.urn:mrn:imo:mmsi:1')
    fromStatusPlugin('vessels.urn:mrn:imo:mmsi:1')
    expect([...present]).to.deep.equal(['vessels.urn:mrn:imo:mmsi:2'])
    expect(dropped.heldBack).to.equal(2)

    fromSimulator('vessels.urn:mrn:imo:mmsi:1')
    fromStatusPlugin('vessels.urn:mrn:imo:mmsi:1')
    expect(present.size).to.equal(2)
    expect(dropped.heldBack).to.equal(2)
  })
})
