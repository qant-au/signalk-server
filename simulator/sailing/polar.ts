/**
 * A sailing boat's polar: her speed through the water at each true wind speed and true wind
 * angle, as a small table in her profile (simulator/vessels). Between the table's points
 * the speed is read linearly in both; below its lightest wind it falls to nothing in a
 * calm, above its strongest it holds, and inside its closest angle the sails do not draw.
 */
export interface PolarTable {
  /** the true wind speeds of the table's columns, knots, rising */
  twsKn: number[]
  /** the true wind angles of its rows, degrees off the bow, rising, at most 180 */
  twaDeg: number[]
  /** boat speed, knots: one row per angle, one value per wind speed */
  speedKn: number[][]
}

/** the best angle to the wind, upwind or downwind, and what she makes on it */
export interface OptimumAngle {
  /** the true wind angle, degrees off the bow */
  twaDeg: number
  /** her polar speed on it, knots */
  speedKn: number
  /** her speed towards the wind on it, knots: positive upwind, negative downwind */
  vmgKn: number
}

const RADIANS = Math.PI / 180
/** the optimum angles are searched this finely */
const SEARCH_STEP_DEG = 0.5

/** where `x` falls in the rising `xs`: the index below it and the share of the way on */
function locate(xs: number[], x: number): [number, number] {
  if (x <= xs[0]) return [0, 0]
  const last = xs.length - 1
  if (x >= xs[last]) return [last - 1, 1]
  let i = 0
  while (xs[i + 1] < x) i++
  return [i, (x - xs[i]) / (xs[i + 1] - xs[i])]
}

export class Polar {
  constructor(readonly table: PolarTable) {
    checkTable(table)
  }

  /** her speed through the water at a true wind speed and angle (either side), knots */
  speedKn(twsKn: number, twaDeg: number): number {
    const t = this.table
    const angle = Math.abs(((((twaDeg + 180) % 360) + 360) % 360) - 180)
    if (angle < t.twaDeg[0] || twsKn <= 0) return 0
    const [a, fa] = locate(t.twaDeg, angle)
    const at = (j: number) =>
      t.speedKn[a][j] + (t.speedKn[a + 1][j] - t.speedKn[a][j]) * fa
    if (twsKn < t.twsKn[0]) return (at(0) * twsKn) / t.twsKn[0]
    const [w, fw] = locate(t.twsKn, twsKn)
    return at(w) + (at(w + 1) - at(w)) * fw
  }

  /** the angle that makes the most to windward at a true wind speed */
  beat(twsKn: number): OptimumAngle {
    return this.optimum(twsKn, this.table.twaDeg[0], 90, 1)
  }

  /** the angle that makes the most to leeward at a true wind speed */
  gybe(twsKn: number): OptimumAngle {
    return this.optimum(twsKn, 90, 180, -1)
  }

  private optimum(
    twsKn: number,
    fromDeg: number,
    toDeg: number,
    sign: 1 | -1
  ): OptimumAngle {
    let best: OptimumAngle = {
      twaDeg: sign > 0 ? fromDeg : toDeg,
      speedKn: 0,
      vmgKn: 0
    }
    for (let a = fromDeg; a <= toDeg; a += SEARCH_STEP_DEG) {
      const speedKn = this.speedKn(twsKn, a)
      const vmgKn = speedKn * Math.cos(a * RADIANS)
      if (sign * vmgKn > sign * best.vmgKn) best = { twaDeg: a, speedKn, vmgKn }
    }
    return best
  }
}

/** a table that cannot be read throws, naming what is wrong with it */
function checkTable(t: PolarTable): void {
  const rising = (xs: number[]) => xs.every((x, i) => i === 0 || x > xs[i - 1])
  if (t.twsKn.length < 2 || !rising(t.twsKn) || t.twsKn[0] <= 0)
    throw new Error('polar: twsKn needs two or more rising wind speeds above 0')
  if (
    t.twaDeg.length < 2 ||
    !rising(t.twaDeg) ||
    t.twaDeg[0] <= 0 ||
    t.twaDeg[t.twaDeg.length - 1] > 180
  )
    throw new Error('polar: twaDeg needs two or more rising angles to 180')
  if (
    t.speedKn.length !== t.twaDeg.length ||
    t.speedKn.some(
      (row) =>
        row.length !== t.twsKn.length ||
        row.some((v) => !Number.isFinite(v) || v < 0)
    )
  )
    throw new Error('polar: speedKn needs a row of speeds for each angle')
}
