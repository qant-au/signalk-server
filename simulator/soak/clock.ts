/**
 * Maps wall-clock time onto scenario time. The scenario starts at a chosen moment of the
 * route and runs `rate` scenario seconds per real second: 1 for real time, higher to cover
 * a long passage quickly.
 */
export class ScenarioClock {
  constructor(
    private readonly scenarioStartMs: number,
    private readonly wallStartMs: number,
    readonly rate = 1
  ) {
    if (!(rate > 0)) {
      throw new Error(`the time multiplier must be positive, got ${rate}`)
    }
  }

  scenarioTime(wallMs: number): number {
    return this.scenarioStartMs + (wallMs - this.wallStartMs) * this.rate
  }
}
