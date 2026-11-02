import { readdirSync } from 'fs'
import path from 'path'
import { GeoTiffGrid } from './geotiff'
import { NetcdfGrid } from './netcdf'

/**
 * Elevation along a sample's waters, in metres relative to the grid's datum (negative is
 * below the surface), from one or more grids tried in order. A point no grid covers, or
 * that a grid marks as no data, is treated as land: the publishers leave land empty, and a
 * simulated boat should not sail where there is no survey.
 */
export interface DepthGrid {
  resolutionM: number
  elevation(lat: number, lon: number): number | undefined
}

export interface DepthSource {
  /** a file in the sample folder; a `*` matches any characters within the file name */
  file: string
  format: 'geotiff' | 'netcdf'
}

export class DepthModel {
  constructor(readonly grids: DepthGrid[]) {}

  get resolutionM(): number {
    return Math.min(...this.grids.map((g) => g.resolutionM))
  }

  elevation(lat: number, lon: number): number | undefined {
    for (const grid of this.grids) {
      const value = grid.elevation(lat, lon)
      if (value !== undefined) return value
    }
    return undefined
  }

  /** water depth in metres, or undefined on land and where nothing was surveyed */
  depth(lat: number, lon: number): number | undefined {
    const elevation = this.elevation(lat, lon)
    return elevation !== undefined && elevation < 0 ? -elevation : undefined
  }
}

function expand(sampleDir: string, pattern: string): string[] {
  if (!pattern.includes('*')) return [path.join(sampleDir, pattern)]
  const dir = path.join(sampleDir, path.dirname(pattern))
  const [prefix, suffix] = path.basename(pattern).split('*')
  return readdirSync(dir)
    .filter((f) => f.startsWith(prefix) && f.endsWith(suffix))
    .sort()
    .map((f) => path.join(dir, f))
}

export function loadDepthModel(
  sampleDir: string,
  sources: DepthSource[]
): DepthModel {
  const grids: DepthGrid[] = []
  for (const source of sources) {
    for (const file of expand(sampleDir, source.file)) {
      grids.push(
        source.format === 'netcdf'
          ? new NetcdfGrid(file)
          : new GeoTiffGrid(file)
      )
    }
  }
  if (!grids.length) {
    throw new Error(
      `${sampleDir}: no depth files found; run the sample's fetch first`
    )
  }
  return new DepthModel(grids)
}
