import { existsSync, readFileSync } from 'fs'
import path from 'path'

/**
 * Magnetic variation over a sample's area on its date, as a grid of values from the
 * International Geomagnetic Reference Field (see simulator/tools/magnetic-variation.ts), read between the
 * grid points bilinearly. Over a passage of a few days the date's own change, a fraction
 * of a degree a decade, is far smaller than a compass shows, so one date serves the run.
 */
export interface VariationFile {
  /** where the values come from, and the model's licence */
  source: string
  model: string
  /** the date the values are for, ISO 8601 */
  date: string
  latitudes: number[]
  longitudes: number[]
  /** degrees, positive east: degrees[i][j] is at latitudes[i], longitudes[j] */
  degrees: number[][]
}

export const VARIATION_FILE = 'magnetic-variation.json'

export class VariationGrid {
  constructor(readonly file: VariationFile) {}

  /** variation at a position, degrees, positive east; held at the edge outside the grid */
  at(lat: number, lon: number): number {
    const { latitudes, longitudes, degrees } = this.file
    const [i, fi] = cell(latitudes, lat)
    const [j, fj] = cell(longitudes, lon)
    const v = (a: number, b: number) => degrees[a][b]
    const south = v(i, j) + (v(i, j + 1) - v(i, j)) * fj
    const north = v(i + 1, j) + (v(i + 1, j + 1) - v(i + 1, j)) * fj
    return south + (north - south) * fi
  }
}

/** the lower index of the grid cell holding x, and how far across it x lies */
function cell(axis: number[], x: number): [number, number] {
  const last = axis.length - 2
  let i = 0
  while (i < last && x > axis[i + 1]) i++
  const f = (x - axis[i]) / (axis[i + 1] - axis[i])
  return [i, Math.min(1, Math.max(0, f))]
}

export function loadVariation(sampleDir: string): VariationGrid | undefined {
  const file = path.join(sampleDir, VARIATION_FILE)
  if (!existsSync(file)) return undefined
  return new VariationGrid(JSON.parse(readFileSync(file, 'utf8')))
}
