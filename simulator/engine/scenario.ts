import { existsSync, readdirSync } from 'fs'
import { readFile } from 'fs/promises'
import path from 'path'
import { AisFileConfig, AisReport, readAisReports } from '../ais/targets'
import { DepthModel, DepthSource, loadDepthModel } from '../depth/depth'
import { Adjustment, adjustRoute } from '../routes/adjust'
import { Leg, Route, loadRoute, routeLegs } from '../routes/route'
import { Traffic } from './traffic'

/**
 * Everything a run needs, loaded from a sample folder: the route adjusted to the depth
 * the boat needs, the depth grid for reporting depth under the boat, and the AIS traffic
 * when the sample's AIS is available on this machine.
 */
export interface SampleFile {
  id: string
  ais?: AisFileConfig
  depth?: {
    sources: DepthSource[]
    harbourRadiusM: number
    harbourNoDataIsWater: boolean
  }
}

export interface ScenarioOptions {
  minDepthUnderKeelM: number
  receiverAntennaHeightM: number
}

export interface Scenario {
  sampleId: string
  route: Route
  plannedRoute: Route
  legs: Leg[]
  adjustments: Adjustment[]
  depth?: DepthModel
  traffic?: Traffic
  /** why traffic or depth is missing, for the status line */
  notes: string[]
}

const MIN_CELL_M = 10
const TRAFFIC_MAX_GAP_S = 20 * 60
const THINNED_GAP_FACTOR = 1.5
const STATIC_INTERVAL_S = 6 * 60

export function listSamples(samplesDir: string): string[] {
  if (!existsSync(samplesDir)) return []
  return readdirSync(samplesDir, { withFileTypes: true })
    .filter(
      (e) =>
        e.isDirectory() &&
        existsSync(path.join(samplesDir, e.name, 'route.json'))
    )
    .map((e) => e.name)
    .sort()
}

export async function loadScenario(
  samplesDir: string,
  sampleId: string,
  options: ScenarioOptions
): Promise<Scenario> {
  const dir = path.join(samplesDir, sampleId)
  const sample: SampleFile = JSON.parse(
    await readFile(path.join(dir, 'sample.json'), 'utf8')
  )
  const planned = await loadRoute(dir)
  const notes: string[] = []

  let depth: DepthModel | undefined
  let route = planned
  let adjustments: Adjustment[] = []
  if (sample.depth) {
    try {
      depth = loadDepthModel(dir, sample.depth.sources)
      const result = adjustRoute(planned, depth, {
        minDepthM: planned.vessel.draftM + options.minDepthUnderKeelM,
        cellM: Math.max(MIN_CELL_M, Math.round(depth.resolutionM)),
        harbourRadiusM: sample.depth.harbourRadiusM,
        harbourNoDataIsWater: sample.depth.harbourNoDataIsWater
      })
      route = result.route
      adjustments = result.adjustments
      const unresolved = adjustments.filter((a) => !a.resolved).length
      if (unresolved)
        notes.push(`${unresolved} legs could not be cleared of shallow water`)
    } catch (error) {
      notes.push(`no depth: ${(error as Error).message}`)
    }
  } else {
    notes.push('no depth configured')
  }

  let traffic: Traffic | undefined
  if (sample.ais && existsSync(path.join(dir, sample.ais.file))) {
    const reports: AisReport[] = []
    for await (const r of readAisReports(dir, sample.ais)) reports.push(r)
    const maxGapS = Math.max(
      TRAFFIC_MAX_GAP_S,
      (sample.ais.thinnedToSeconds ?? 0) * THINNED_GAP_FACTOR
    )
    traffic = new Traffic(reports, {
      receiver: { antennaHeightM: options.receiverAntennaHeightM },
      maxGapS,
      staticIntervalS: STATIC_INTERVAL_S
    })
  } else if (sample.ais) {
    notes.push(
      `no traffic: ${sample.ais.file} is not here; see the sample's README`
    )
  }

  return {
    sampleId,
    route,
    plannedRoute: planned,
    legs: routeLegs(route),
    adjustments,
    depth,
    traffic,
    notes
  }
}
