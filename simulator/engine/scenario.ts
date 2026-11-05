import { existsSync, readdirSync } from 'fs'
import { readFile } from 'fs/promises'
import path from 'path'
import { AisFileConfig, AisReport, readAisReports } from '../ais/targets'
import { DepthModel, DepthSource, loadDepthModel } from '../depth/depth'
import { Adjustment, DepthCheck, adjustRoute } from '../routes/adjust'
import { TurnCheck, clearTurns } from '../routes/turns'
import {
  Leg,
  Route,
  loadRoute,
  routeLegs,
  vesselsDirFor
} from '../routes/route'
import { VariationGrid, loadVariation } from '../systems/magnetic'
import { VesselProfile, loadProfile } from '../vessels/profile'
import { Environment, loadEnvironment } from '../weather/environment'
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
  /** each arc at a waypoint, checked against the depth and tightened where it cut a corner */
  turns?: TurnCheck[]
  depth?: DepthModel
  traffic?: Traffic
  /** what is on board, when the route names a profile */
  profile?: VesselProfile
  /** magnetic variation over the sample's area, when the sample has it */
  variation?: VariationGrid
  /** the sample's weather and water level (simulator/weather), when it lists them */
  environment?: Environment
  /** why traffic or depth is missing, for the status line */
  notes: string[]
}

/** the plugin's defaults, which the route tool checks a sample at */
export const DEFAULT_MIN_DEPTH_UNDER_KEEL_M = 1
export const DEFAULT_RECEIVER_ANTENNA_HEIGHT_M = 10
const MIN_CELL_M = 10
const TRAFFIC_MAX_GAP_S = 20 * 60
const THINNED_GAP_FACTOR = 1.5

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
  let legs: Leg[] | undefined
  let turns: TurnCheck[] = []
  if (sample.depth) {
    try {
      depth = loadDepthModel(dir, sample.depth.sources)
      const adjust = {
        minDepthM: planned.vessel.draftM + options.minDepthUnderKeelM,
        cellM: Math.max(MIN_CELL_M, Math.round(depth.resolutionM)),
        harbourRadiusM: sample.depth.harbourRadiusM,
        harbourNoDataIsWater: sample.depth.harbourNoDataIsWater
      }
      const result = adjustRoute(planned, depth, adjust)
      route = result.route
      adjustments = result.adjustments
      const unresolved = adjustments.filter((a) => !a.resolved).length
      if (unresolved)
        notes.push(`${unresolved} legs could not be cleared of shallow water`)
      const wps = route.waypoints
      const check = new DepthCheck(depth, adjust, [wps[0], wps[wps.length - 1]])
      legs = routeLegs(route)
      turns = clearTurns(legs, route.vessel.lengthM, (lat, lon) =>
        check.safe({ lat, lon })
      )
      const uncleared = turns.filter((t) => !t.clear).length
      if (uncleared)
        notes.push(`${uncleared} turns could not be kept in safe water`)
    } catch (error) {
      notes.push(`no depth: ${(error as Error).message}`)
    }
  } else {
    notes.push('no depth configured')
  }

  let traffic: Traffic | undefined
  if (sample.ais && existsSync(path.join(dir, sample.ais.file))) {
    const reports: AisReport[] = []
    // the own boat is one vessel: a report under its own MMSI is not traffic
    const own = planned.vessel.mmsi
    for await (const r of readAisReports(dir, sample.ais)) {
      if (r.id !== own) reports.push(r)
    }
    const maxGapS = Math.max(
      TRAFFIC_MAX_GAP_S,
      (sample.ais.thinnedToSeconds ?? 0) * THINNED_GAP_FACTOR
    )
    traffic = new Traffic(reports, {
      receiver: { antennaHeightM: options.receiverAntennaHeightM },
      maxGapS
    })
  } else if (sample.ais) {
    notes.push(
      `no traffic: ${sample.ais.file} is not here; see the sample's README`
    )
  }

  const environment = loadEnvironment(dir)
  for (const file of environment?.missing ?? []) {
    notes.push(`no ${file}: see the sample's README`)
  }

  const profile = planned.vessel.profile
    ? loadProfile(planned.vessel.profile, vesselsDirFor(dir))
    : undefined

  return {
    sampleId,
    route,
    plannedRoute: planned,
    legs: legs ?? routeLegs(route),
    adjustments,
    turns,
    depth,
    traffic,
    profile,
    variation: loadVariation(dir),
    environment,
    notes
  }
}
