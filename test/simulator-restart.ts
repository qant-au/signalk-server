import { expect } from 'chai'
import { mkdtempSync } from 'fs'
import { rm } from 'fs/promises'
import os from 'os'
import path from 'path'
import simulatorPlugin from '../simulator/plugin/index'
import { Delta } from '../simulator/soak/deltas'

type InputDelta = {
  context?: string
  updates?: { values?: { path: string; value: unknown }[] }[]
}
type Handler = (delta: InputDelta, next: (delta: InputDelta) => void) => void

/** a mark from another plugin, as the server's AIS status plugin sends one for a target */
function aisStatusMark(context: string): InputDelta {
  return {
    context,
    updates: [
      {
        values: [{ path: 'sensors.ais.status', value: 'remove' }]
      }
    ]
  }
}

describe('Simulator targets across a restart', function () {
  this.timeout(60000)
  const dataDir = mkdtempSync(path.join(os.tmpdir(), 'simulator-restart-'))

  before(() => {
    process.env.SIGNALK_SIMULATOR_SAMPLES = path.join(
      __dirname,
      '..',
      'simulator',
      'samples'
    )
  })

  after(async () => {
    delete process.env.SIGNALK_SIMULATOR_SAMPLES
    await rm(dataDir, { recursive: true, force: true })
  })

  it("holds back other plugins' marks for the earlier run's targets after a restart", async () => {
    const targets = new Set<string>()
    const handlers: Handler[] = []
    const errors: string[] = []
    const plugin = simulatorPlugin({
      handleMessage: (_id: string, delta: Partial<Delta>) => {
        if (delta.context && delta.context !== 'vessels.self')
          targets.add(delta.context)
      },
      setPluginStatus: () => undefined,
      setPluginError: (message: string) => errors.push(message),
      getDataDirPath: () => dataDir,
      error: () => undefined,
      debug: () => undefined,
      registerDeltaInputHandler: (handler: Handler) => {
        handlers.push(handler)
      },
      resourcesApi: { setResource: async () => undefined },
      activateRoute: async () => undefined,
      clearDestination: async () => undefined
    })
    const settings = {
      sample: 'miami-icw-2024-03-16',
      resume: false,
      showTraffic: true,
      seed: 1
    }
    const waitFor = async (done: () => boolean) => {
      const deadline = Date.now() + 30000
      while (!done() && Date.now() < deadline && !errors.length)
        await new Promise((resolve) => setTimeout(resolve, 100))
    }

    plugin.start({ ...settings, startAtMinutes: 0 })
    await waitFor(() => targets.size > 0)
    const earlier = [...targets][0]
    expect(earlier, errors.join('; ')).to.be.a('string')
    // the next run starts at the far end of the route, where that target is not heard
    plugin.stop()
    targets.clear()
    plugin.start({ ...settings, startAtMinutes: 225 })
    await waitFor(() => targets.size > 0)
    expect(errors).to.deep.equal([])
    expect(targets.has(earlier)).to.equal(false)

    // while the second run sails: a mark for its own target passes, one for the first's does not
    const passed: InputDelta[] = []
    const handler = handlers[handlers.length - 1]
    const current = [...targets][0]
    handler(aisStatusMark(earlier), (d) => passed.push(d))
    handler(aisStatusMark(current), (d) => passed.push(d))
    plugin.stop()
    expect(passed.map((d) => d.context)).to.deep.equal([current])
  })
})
