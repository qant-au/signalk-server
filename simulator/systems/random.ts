/**
 * Seeded randomness for the systems model. Every system takes its own stream, derived from
 * the run's seed and the system's id, so adding a tank to a profile does not change what
 * an engine does, and the same seed always gives the same run.
 */
export class Rng {
  private state: number

  constructor(seed: number, stream = '') {
    this.state = (seed ^ hash(stream)) >>> 0
  }

  /** mulberry32: uniform in [0, 1) */
  next(): number {
    this.state = (this.state + 0x6d2b79f5) >>> 0
    let t = this.state
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }

  between(low: number, high: number): number {
    return low + (high - low) * this.next()
  }

  /** standard normal, Box-Muller */
  normal(): number {
    const u = 1 - this.next()
    const v = this.next()
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v)
  }
}

/** FNV-1a, 32 bit */
export function hash(text: string): number {
  let h = 0x811c9dc5
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return h >>> 0
}

/**
 * A slow wander around zero (Ornstein-Uhlenbeck): it drifts, and is pulled back with time
 * constant `tauS`, so its spread settles at `sigma`. Added to a modelled value it gives the
 * small, correlated variation a real sensor shows, rather than noise from sample to sample.
 */
export class Drift {
  value = 0

  constructor(
    private readonly rng: Rng,
    private readonly sigma: number,
    private readonly tauS: number
  ) {}

  step(dtS: number): number {
    const decay = Math.exp(-dtS / this.tauS)
    this.value =
      this.value * decay +
      this.sigma * Math.sqrt(1 - decay * decay) * this.rng.normal()
    return this.value
  }
}
