/**
 * Maps wall-clock time onto scenario time, one scenario second per real second. The
 * scenario starts at a chosen moment of the route and runs in step with the wall clock.
 */
export class ScenarioClock {
  constructor(
    private readonly scenarioStartMs: number,
    private readonly wallStartMs: number
  ) {}

  scenarioTime(wallMs: number): number {
    return this.scenarioStartMs + (wallMs - this.wallStartMs)
  }
}
