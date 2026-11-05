/**
 * Write a sample's magnetic variation grid.
 *
 *   npx ts-node simulator/tools/magnetic-variation.ts <sample>
 *
 * Asks the NOAA NCEI magnetic field calculator for the declination on a grid over the
 * sample's route, on its departure date, and writes `magnetic-variation.json` beside the
 * route. It uses the International Geomagnetic Reference Field, which covers every sample's
 * date (the calculator offers the World Magnetic Model only from 2024); the IGRF is
 * published by IAGA for free use, and the calculator's output is US Government work.
 */
import { writeFile } from 'fs/promises'
import path from 'path'
import { loadRoute } from '../routes/route'
import { VARIATION_FILE, VariationFile } from '../systems/magnetic'

const CALCULATOR =
  'https://www.ngdc.noaa.gov/geomag-web/calculators/calculateDeclination'
/** the key NOAA publishes for scripted use of its calculators */
const PUBLIC_KEY = 'zNEw7'
/** grid spacing, degrees: the variation changes by well under a degree across it */
const SPACING_DEG = 0.5
const MARGIN_DEG = 0.25

interface CalculatorResult {
  model: string
  result: { declination: number }[]
}

function axis(low: number, high: number): number[] {
  const start = Math.floor((low - MARGIN_DEG) / SPACING_DEG) * SPACING_DEG
  const end = Math.ceil((high + MARGIN_DEG) / SPACING_DEG) * SPACING_DEG
  const out: number[] = []
  for (let x = start; x <= end + 1e-9; x += SPACING_DEG) out.push(+x.toFixed(4))
  return out
}

async function declination(
  lat: number,
  lon: number,
  date: Date
): Promise<CalculatorResult> {
  const query = new URLSearchParams({
    lat1: String(lat),
    lon1: String(lon),
    key: PUBLIC_KEY,
    model: 'IGRF',
    resultFormat: 'json',
    startYear: String(date.getUTCFullYear()),
    startMonth: String(date.getUTCMonth() + 1),
    startDay: String(date.getUTCDate())
  })
  const response = await fetch(`${CALCULATOR}?${query}`)
  if (!response.ok) {
    throw new Error(`${CALCULATOR}: HTTP ${response.status}`)
  }
  return (await response.json()) as CalculatorResult
}

async function main() {
  const sample = process.argv[2]
  if (!sample) {
    console.error('usage: magnetic-variation.ts <sample>')
    process.exit(2)
  }
  const dir = path.join(__dirname, '..', 'samples', sample)
  const route = await loadRoute(dir)
  const lats = route.waypoints.map((w) => w.lat)
  const lons = route.waypoints.map((w) => w.lon)
  const latitudes = axis(Math.min(...lats), Math.max(...lats))
  const longitudes = axis(Math.min(...lons), Math.max(...lons))
  const date = new Date(route.departure)
  let model = ''
  const degrees: number[][] = []
  for (const lat of latitudes) {
    const row: number[] = []
    for (const lon of longitudes) {
      const result = await declination(lat, lon, date)
      model = result.model
      row.push(result.result[0].declination)
    }
    degrees.push(row)
  }
  const file: VariationFile = {
    source:
      'NOAA NCEI magnetic field calculator (https://www.ngdc.noaa.gov/geomag/calculators/magcalc.shtml), International Geomagnetic Reference Field (IAGA), free to use',
    model,
    date: date.toISOString().slice(0, 10),
    latitudes,
    longitudes,
    degrees
  }
  await writeFile(
    path.join(dir, VARIATION_FILE),
    JSON.stringify(file, null, 2) + '\n'
  )
  console.log(
    `${sample}: ${model}, ${latitudes.length} x ${longitudes.length} points, ` +
      `${Math.min(...degrees.flat()).toFixed(2)} to ${Math.max(...degrees.flat()).toFixed(2)} degrees`
  )
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
