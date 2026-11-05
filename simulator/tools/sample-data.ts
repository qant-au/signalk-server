/**
 * Fetch and prepare the data for a simulator sample.
 *
 *   npx ts-node simulator/tools/sample-data.ts fetch <sample>
 *   npx ts-node simulator/tools/sample-data.ts prepare <sample>
 *
 * `fetch` downloads the openly licensed files that are too large to keep in the
 * repository into the sample's cache/ folder. `prepare` turns source data the user has
 * downloaded themselves (see the sample's README) into the sample's restricted/ folder.
 * Both folders are ignored by git.
 */
import { createHash } from 'crypto'
import { createReadStream, createWriteStream, existsSync } from 'fs'
import { mkdir, readFile, rename } from 'fs/promises'
import path from 'path'
import { Readable } from 'stream'
import { pipeline } from 'stream/promises'
import { RestrictedConfig, prepareAmsa, preparePiraeus } from './sources'
import { openZipEntry } from './zip'

export interface Download {
  url: string
  file: string
  sha256?: string
  /** entries to extract next to the archive */
  extract?: string[]
}

export interface SampleConfig {
  id: string
  downloads?: Download[]
  restricted?: RestrictedConfig
}

const SIMULATOR_DIR = path.resolve(__dirname, '..')
const DOWNLOADS_DIR = path.join(SIMULATOR_DIR, 'downloads')

export function sampleDir(id: string): string {
  return path.join(SIMULATOR_DIR, 'samples', id)
}

async function loadSample(id: string): Promise<SampleConfig> {
  return JSON.parse(
    await readFile(path.join(sampleDir(id), 'sample.json'), 'utf8')
  )
}

async function sha256Of(file: string): Promise<string> {
  const hash = createHash('sha256')
  await pipeline(createReadStream(file), hash)
  return hash.digest('hex')
}

async function download(item: Download, cacheDir: string): Promise<void> {
  const target = path.join(cacheDir, item.file)
  if (
    existsSync(target) &&
    (!item.sha256 || (await sha256Of(target)) === item.sha256)
  ) {
    console.log(`have      ${item.file}`)
  } else {
    console.log(`download  ${item.file}`)
    const response = await fetch(item.url)
    if (!response.ok || !response.body) {
      throw new Error(`${item.url}: HTTP ${response.status}`)
    }
    const partial = `${target}.part`
    await pipeline(
      Readable.fromWeb(response.body as import('stream/web').ReadableStream),
      createWriteStream(partial)
    )
    if (item.sha256 && (await sha256Of(partial)) !== item.sha256) {
      throw new Error(`${item.file}: checksum does not match`)
    }
    await rename(partial, target)
  }

  for (const entry of item.extract ?? []) {
    const out = path.join(cacheDir, path.basename(entry))
    if (existsSync(out)) continue
    console.log(`extract   ${entry}`)
    await pipeline(await openZipEntry(target, entry), createWriteStream(out))
  }
}

async function fetchSample(id: string): Promise<void> {
  const config = await loadSample(id)
  const cacheDir = path.join(sampleDir(id), 'cache')
  await mkdir(cacheDir, { recursive: true })
  for (const item of config.downloads ?? []) {
    await download(item, cacheDir)
  }
}

async function prepareSample(id: string): Promise<void> {
  const config = await loadSample(id)
  const restricted = config.restricted
  if (!restricted) {
    console.log(`${id} has no restricted data to prepare`)
    return
  }
  const outputDir = path.join(sampleDir(id), 'restricted')
  if (restricted.source === 'amsa-cts') {
    const result = await prepareAmsa(
      restricted,
      DOWNLOADS_DIR,
      path.join(sampleDir(id), 'cache'),
      outputDir
    )
    console.log(
      `${outputDir}/ais.csv: ${result.points} points, ${result.vessels} vessels`
    )
  } else {
    const result = await preparePiraeus(restricted, DOWNLOADS_DIR, outputDir)
    console.log(
      `${outputDir}: ${result.points} AIS reports, ${result.vessels} vessels, ` +
        `${result.weatherRows} weather rows`
    )
  }
}

const USAGE = 'usage: sample-data.ts fetch|prepare <sample>'

if (require.main === module) {
  const [command, id] = process.argv.slice(2)
  const run =
    command === 'fetch'
      ? fetchSample
      : command === 'prepare'
        ? prepareSample
        : undefined
  if (!run || !id) {
    console.error(USAGE)
    process.exit(2)
  }
  run(id).catch((error: Error) => {
    console.error(error.message)
    process.exit(1)
  })
}
