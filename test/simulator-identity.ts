import { expect } from 'chai'
import { copyFileSync, mkdirSync, mkdtempSync, writeFileSync } from 'fs'
import { rm } from 'fs/promises'
import os from 'os'
import path from 'path'
import { loadScenario } from '../simulator/engine/scenario'
import simulatorPlugin from '../simulator/plugin/index'
import { Route } from '../simulator/routes/route'
import {
  Delta,
  IDENTITY_FIELDS,
  identityDelta,
  vesselIdentity
} from '../simulator/soak/deltas'
import {
  listProfiles,
  loadProfile,
  resolveProfile
} from '../simulator/vessels/profile'

// The server pins signalk-schema 1.0; the deltas are validated against the newer copy the
// streams package uses, as the systems tests do.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const schema = require(
  require.resolve('@signalk/signalk-schema', {
    paths: [path.join(__dirname, '..', 'packages', 'streams')]
  })
)

const VESSELS = path.join(__dirname, '..', 'simulator', 'vessels')
const profiles = listProfiles(VESSELS).map((id) => loadProfile(id, VESSELS))
const yacht = profiles.find((p) => p.id === 'motor-yacht-20m')!

function route(mmsi = '367555210'): Route {
  return {
    name: 'identity test',
    departure: '2024-03-16T14:00:00Z',
    vessel: {
      description: yacht.name,
      name: 'Coquina',
      mmsi,
      lengthM: yacht.lengthM,
      draftM: yacht.draftM,
      typeCode: yacht.typeCode,
      profile: yacht.id
    },
    source: 'test',
    waypoints: [
      { lat: 25.7, lon: -80.2, speedKn: 6 },
      { lat: 25.72, lon: -80.2, speedKn: 6 },
      { lat: 25.74, lon: -80.2 }
    ]
  }
}

function values(delta: Delta): Map<string, unknown> {
  const out = new Map<string, unknown>()
  for (const u of delta.updates) {
    for (const v of u.values) {
      if (v.path === '') {
        for (const [k, x] of Object.entries(v.value as object)) out.set(k, x)
      } else out.set(v.path, v.value)
    }
  }
  return out
}

describe('Simulator vessel identity', () => {
  it('gives every profile an air height and an AIS antenna, from length unless it says', () => {
    for (const p of profiles) {
      expect(p.airHeightM, p.id).to.be.above(p.draftM)
      expect(p.aisAntenna.fromBowM, p.id).to.be.within(0, p.lengthM)
      expect(Math.abs(p.aisAntenna.fromCenterM), p.id).to.be.at.most(
        p.beamM / 2
      )
    }
    const sail = profiles.find((p) => p.id === 'sailing-yacht-15m')!
    const motor = profiles.find((p) => p.id === 'motor-sailer-15m')!
    // a sailing yacht's masthead stands far above a motor boat's arch of the same length
    expect(sail.airHeightM).to.be.closeTo(22.8, 1e-9)
    expect(motor.airHeightM).to.be.closeTo(4.8, 1e-9)
    const given = resolveProfile({
      id: 'x',
      name: 'x',
      lengthM: 12,
      airHeightM: 17,
      maxDraftM: 2.4,
      aisAntenna: { fromBowM: 9, fromCenterM: -0.5 }
    })
    expect(given.airHeightM).to.equal(17)
    expect(given.maxDraftM).to.equal(2.4)
    expect(given.aisAntenna).to.deep.equal({ fromBowM: 9, fromCenterM: -0.5 })
  })

  it('sends the name, MMSI and dimensions on the specification paths, schema-valid', () => {
    const p = { ...yacht, maxDraftM: 2 }
    const { delta, sent } = identityDelta(vesselIdentity(route().vessel, p), 0)
    expect(sent).to.deep.equal([...IDENTITY_FIELDS])
    const v = values(delta)
    expect(v.get('name')).to.equal('Coquina')
    expect(v.get('mmsi')).to.equal('367555210')
    expect(v.get('design.length')).to.deep.equal({ overall: p.lengthM })
    expect(v.get('design.beam')).to.equal(p.beamM)
    expect(v.get('design.draft')).to.deep.equal({
      current: p.draftM,
      maximum: 2
    })
    expect(v.get('design.airHeight')).to.equal(p.airHeightM)
    expect(v.get('design.displacement')).to.equal(p.displacementT * 1000)
    expect(v.get('design.aisShipType')).to.deep.equal({
      id: 37,
      name: 'Pleasure'
    })
    expect(v.get('sensors.ais.fromBow')).to.equal(p.aisAntenna.fromBowM)
    expect(v.get('sensors.ais.fromCenter')).to.equal(p.aisAntenna.fromCenterM)
    const meta = delta.updates[0].meta!.map((m) => m.path)
    expect(meta).to.include.members(['design.length', 'sensors.ais.fromBow'])
    const d = { ...delta, context: 'vessels.urn:mrn:imo:mmsi:367555210' }
    expect(schema.validateDelta(d).valid).to.equal(true)
    // a delta alone cannot carry the document-level identity the full model wants
    const full = schema.validateFull(schema.deltaToFull(d))
    const problems = (full.errors ?? [])
      .map(
        (e: { dataPath: string; message: string }) =>
          `${e.dataPath} ${e.message}`
      )
      .filter((m: string) => !/url|uuid|aircraft|aton|sar/i.test(m))
    expect(problems).to.deep.equal([])
  })

  it('leaves out whatever is withheld', () => {
    const { delta, sent } = identityDelta(
      vesselIdentity(route().vessel, yacht),
      0,
      new Set(['name', 'design.length'])
    )
    const v = values(delta)
    expect(v.has('name')).to.equal(false)
    expect(v.has('design.length')).to.equal(false)
    expect(v.get('mmsi')).to.equal('367555210')
    expect(sent).to.not.include('name')
  })

  describe('the plugin', () => {
    const tmp = mkdtempSync(path.join(os.tmpdir(), 'simulator-identity-'))
    const samples = path.join(tmp, 'samples')

    before(() => {
      mkdirSync(path.join(samples, 'test'), { recursive: true })
      mkdirSync(path.join(tmp, 'vessels'))
      copyFileSync(
        path.join(VESSELS, `${yacht.id}.json`),
        path.join(tmp, 'vessels', `${yacht.id}.json`)
      )
      writeFileSync(
        path.join(samples, 'test', 'sample.json'),
        JSON.stringify({
          id: 'test',
          ais: {
            file: 'ais.csv',
            idColumn: 'mmsi',
            timeColumn: 'time',
            timeFormat: 'iso-utc',
            latColumn: 'lat',
            lonColumn: 'lon',
            sogColumn: 'sog'
          }
        })
      )
      // a target with the own boat's MMSI, and another vessel
      writeFileSync(
        path.join(samples, 'test', 'ais.csv'),
        [
          'mmsi,time,lat,lon,sog',
          '367555210,2024-03-16T14:00:00Z,25.70,-80.2,0',
          '367000001,2024-03-16T14:00:00Z,25.71,-80.2,3'
        ].join('\n') + '\n'
      )
      writeFileSync(
        path.join(samples, 'test', 'route.json'),
        JSON.stringify(route())
      )
      process.env.SIGNALK_SIMULATOR_SAMPLES = samples
    })

    after(async () => {
      delete process.env.SIGNALK_SIMULATOR_SAMPLES
      await rm(tmp, { recursive: true, force: true })
    })

    /** the server's base-delta editor, as the plugin sees it: a store of self values */
    function editor(initial: Record<string, unknown> = {}) {
      const store = new Map(Object.entries(initial))
      return {
        store,
        getSelfValue: (p: string) => store.get(p),
        setSelfValue: (p: string, v: unknown) => {
          store.set(p, v)
        },
        removeSelfValue: (p: string) => {
          store.delete(p)
        }
      }
    }

    async function start(config?: {
      base?: ReturnType<typeof editor>
      vessel?: Record<string, unknown>
    }) {
      const dataDir = mkdtempSync(path.join(tmp, 'data-'))
      const deltas: Delta[] = []
      const statuses: string[] = []
      const plugin = simulatorPlugin({
        handleMessage: (_id: string, delta: Partial<Delta>) =>
          deltas.push(delta as Delta),
        setPluginStatus: (s: string) => statuses.push(s),
        setPluginError: (s: string) => statuses.push(`error: ${s}`),
        getDataDirPath: () => dataDir,
        error: (s: string) => statuses.push(`error: ${s}`),
        debug: () => undefined,
        resourcesApi: { setResource: async () => undefined },
        activateRoute: async () => undefined,
        clearDestination: async () => undefined,
        config: config && {
          baseDeltaEditor: config.base,
          settings: { vessel: config.vessel }
        }
      })
      plugin.start({ sample: 'test', resume: false })
      const deadline = Date.now() + 5000
      while (!statuses.some((s) => s.startsWith('Under way'))) {
        if (Date.now() > deadline) throw new Error(statuses.join(' | '))
        await new Promise((resolve) => setTimeout(resolve, 50))
      }
      const during = new Map(config?.base?.store)
      plugin.stop()
      const update = (source: string) =>
        deltas
          .flatMap((d) => d.updates)
          .filter((u) =>
            source === 'defaults'
              ? (u as { $source?: string }).$source === 'defaults'
              : u.source?.label === source
          )
      const own = update('simulator').find((u) =>
        u.values.some((v) => v.path === 'design.airHeight')
      )!
      return {
        during,
        after: new Map(config?.base?.store),
        defaults: update('defaults'),
        plugin: values({ context: 'vessels.self', updates: [own] }),
        status: statuses.find((s) => s.startsWith('Under way'))!
      }
    }

    it('puts what the server keeps for itself into its vessel settings, in memory, and takes it back on stop', async () => {
      const base = editor()
      const run = await start({ base })
      expect(run.during.get('name')).to.equal('Coquina')
      expect(run.during.get('mmsi')).to.equal('367555210')
      expect(run.during.get('design.length')).to.deep.equal({
        overall: yacht.lengthM
      })
      // sent as the server sends its own settings, so its self-data filter keeps them
      const lentValues = values({
        context: 'vessels.self',
        updates: [run.defaults[0]]
      })
      expect(lentValues.get('name')).to.equal('Coquina')
      expect(lentValues.get('design.beam')).to.equal(yacht.beamM)
      // the rest the plugin sends as itself
      expect([...run.plugin.keys()].sort()).to.deep.equal([
        'design.airHeight',
        'design.displacement',
        'sensors.ais.fromBow',
        'sensors.ais.fromCenter'
      ])
      expect(run.status).to.include(
        "set name, MMSI, length, beam, draft, ship type in the server's vessel settings, until stopped"
      )
      expect(run.status).to.include('sent air height, displacement')
      expect(run.after.size).to.equal(0)
      expect(run.defaults).to.have.length(2)
    })

    it("leaves the owner's vessel settings alone, and says so", async () => {
      const base = editor({
        name: 'Second Wind',
        'design.length': { overall: 11.9 }
      })
      const run = await start({ base, vessel: { mmsi: '503123456' } })
      expect(run.during.get('name')).to.equal('Second Wind')
      expect(run.during.has('mmsi')).to.equal(false)
      expect(run.during.get('design.length')).to.deep.equal({ overall: 11.9 })
      expect(run.during.get('design.beam')).to.equal(yacht.beamM)
      expect(run.status).to.include("left the owner's name, MMSI, length")
      // on stop only what the plugin set goes; the owner's stays
      expect([...run.after.keys()].sort()).to.deep.equal([
        'design.length',
        'name'
      ])
    })

    it('says what it could not set where it cannot reach the server settings', async () => {
      const run = await start()
      expect(run.status).to.include(
        "could not set name, MMSI, length, beam, draft, ship type: no access to the server's vessel settings"
      )
    })

    it('is one vessel: its own MMSI in the AIS is not traffic', async () => {
      const scenario = await loadScenario(samples, 'test', {
        minDepthUnderKeelM: 1,
        receiverAntennaHeightM: 10
      })
      expect(scenario.traffic!.size).to.equal(1)
    })
  })
})
