/**
 * The targets the receiver has lost and the server has dropped, until they are heard
 * again. Other plugins still send for them: the server's AIS status plugin marks a target
 * `lost` and then `remove` on its own wall-clock timers, and each mark would bring the
 * target back into vessels.* with nothing but its MMSI and status, until the server's
 * hour-long prune. Deltas for a dropped target from anyone but the simulator are held back.
 */
export class DroppedTargets {
  private readonly contexts = new Set<string>()
  /** deltas held back since the start */
  heldBack = 0

  forget(context: string): void {
    this.contexts.add(context)
  }

  /** the simulator is sending for this context: heard again, or never dropped */
  heard(context: string | undefined): void {
    if (context !== undefined) this.contexts.delete(context)
  }

  /** whether a delta from elsewhere is for a dropped target, and so held back */
  holdsBack(context: string | undefined): boolean {
    if (context === undefined || !this.contexts.has(context)) return false
    this.heldBack++
    return true
  }
}
