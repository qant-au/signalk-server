/**
 * How many of a sample's AIS targets a boat would hear at one place and moment.
 *
 *   npx ts-node simulator/tools/ais-coverage.ts <sample> <lat> <lon> <ISO time> [antenna m]
 *
 * Takes each target's latest report in the minutes before the moment, and counts it as
 * heard when the reception model gives it a better than even chance at that distance.
 * Used to check the reception model against real data before routes exist.
 */
import path from 'path'
import {
  distanceNm,
  estimateStation,
  receptionProbability,
  receptionRangeNm
} from '../ais/reception'
import { AisReport, loadAisConfig, readAisReports } from '../ais/targets'

const LOOKBACK_MS = 10 * 60 * 1000
const DEFAULT_ANTENNA_M = 10
const HEARD_THRESHOLD = 0.5

async function main() {
  const [sample, latText, lonText, timeText, antennaText] =
    process.argv.slice(2)
  if (!sample || !latText || !lonText || !timeText) {
    console.error(
      'usage: ais-coverage.ts <sample> <lat> <lon> <ISO time> [antenna m]'
    )
    process.exit(2)
  }
  const sampleDir = path.resolve(__dirname, '..', 'samples', sample)
  const config = await loadAisConfig(sampleDir)
  const at = Date.parse(timeText)
  const lat = Number(latText)
  const lon = Number(lonText)
  const receiver = { antennaHeightM: Number(antennaText ?? DEFAULT_ANTENNA_M) }
  // A thinned source (AMSA keeps one report per vessel per hour) needs a longer look back.
  const lookback = Math.max(LOOKBACK_MS, (config.thinnedToSeconds ?? 0) * 1000)

  const latest = new Map<string, AisReport>()
  for await (const report of readAisReports(sampleDir, config)) {
    if (report.timeMs > at || report.timeMs < at - lookback) continue
    const previous = latest.get(report.id)
    if (!previous || report.timeMs > previous.timeMs)
      latest.set(report.id, report)
  }

  const counts = { A: { all: 0, heard: 0 }, B: { all: 0, heard: 0 } }
  for (const report of latest.values()) {
    const station = estimateStation(report.target)
    const range = receptionRangeNm(station, receiver)
    const distance = distanceNm(lat, lon, report.lat, report.lon)
    counts[station.aisClass].all++
    if (receptionProbability(distance, range) > HEARD_THRESHOLD) {
      counts[station.aisClass].heard++
    }
  }
  const total = counts.A.all + counts.B.all
  const heard = counts.A.heard + counts.B.heard
  console.log(
    `${sample} at ${lat}, ${lon}, ${new Date(at).toISOString()}, antenna ${receiver.antennaHeightM} m`
  )
  console.log(
    `  in the source:  ${total} targets (Class A ${counts.A.all}, Class B ${counts.B.all})`
  )
  console.log(
    `  heard on board: ${heard} targets (Class A ${counts.A.heard}, Class B ${counts.B.heard})`
  )
}

main().catch((error: Error) => {
  console.error(error.message)
  process.exit(1)
})
