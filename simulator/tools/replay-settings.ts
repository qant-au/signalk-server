/**
 * Makes a replay's configuration directory for bin/simulator-replay: its settings.json,
 * settings/simulator-replay.json with the log as the file the playback reads, and its
 * baseDeltas.json, the own boat's identity as the log gives it.
 *
 *   npx ts-node simulator/tools/replay-settings.ts <log> <configuration directory>
 *
 * A server keeps the own vessel's identity (name, MMSI, dimensions, antenna offsets, call
 * sign) in its own vessel settings and drops those paths from any provider's deltas
 * (src/staticDataFilter.ts), so a replayed boat would be nameless. They are read from the
 * log's first own delta lines, which carry them, and written where the server's vessel
 * settings live, as the Admin UI's vessel page writes them.
 */
import { createReadStream, readFileSync, writeFileSync } from 'fs'
import path from 'path'
import { createInterface } from 'readline'
import DeltaEditor from '../../src/deltaeditor'
import { Delta } from '../soak/deltas'

/** the own vessel paths a server takes from its vessel settings alone (src/staticDataFilter.ts) */
const SERVER_IDENTITY_PATHS: ReadonlySet<string> = new Set([
  '',
  'design.aisShipType',
  'design.beam',
  'design.length',
  'design.draft',
  'sensors.gps.fromBow',
  'sensors.gps.fromCenter',
  'communication'
])

/** the own boat's identity values in a log's first lines: those at its first time */
async function logIdentity(
  file: string
): Promise<{ path: string; value: unknown }[]> {
  const found: { path: string; value: unknown }[] = []
  const lines = createInterface({ input: createReadStream(file) })
  let firstMs: string | undefined
  for await (const line of lines) {
    const [ms, , ...json] = line.split(';')
    firstMs ??= ms
    if (ms !== firstMs) break
    const delta: Delta = JSON.parse(json.join(';'))
    if (delta.context !== 'vessels.self') continue
    for (const u of delta.updates) {
      for (const v of u.values) {
        if (SERVER_IDENTITY_PATHS.has(v.path)) found.push(v)
      }
    }
  }
  lines.close()
  return found
}

async function main() {
  const [log, dir] = process.argv.slice(2)
  if (!log || !dir) {
    console.error('usage: replay-settings.ts <log> <configuration directory>')
    process.exit(2)
  }
  const settings = JSON.parse(
    readFileSync(
      path.join(__dirname, '..', '..', 'settings', 'simulator-replay.json'),
      'utf8'
    )
  )
  settings.pipedProviders[0].pipeElements[0].options.subOptions.filename =
    path.resolve(log)
  writeFileSync(
    path.join(dir, 'settings.json'),
    JSON.stringify(settings, null, 2)
  )
  const editor = new DeltaEditor()
  const identity = await logIdentity(log)
  for (const { path: p, value } of identity) {
    // the vessel's name and MMSI sit at its root, set one by one as the Admin UI sets them
    if (p === '') {
      for (const [k, v] of Object.entries(value as object)) {
        editor.setSelfValue(k, v)
      }
    } else editor.setSelfValue(p, value)
  }
  editor.saveSync(path.join(dir, 'baseDeltas.json'))
  const name = identity.find((v) => v.path === '' && 'name' in Object(v.value))
  console.log(
    `replaying ${path.resolve(log)}; the own boat's identity from the log: ${identity.length} values${name ? `, ${(name.value as { name: string }).name}` : ''}`
  )
}

if (require.main === module) {
  main().catch((error) => {
    console.error(`replay settings failed: ${(error as Error).message}`)
    process.exit(1)
  })
}
