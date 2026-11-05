import { existsSync, readFileSync, renameSync, writeFileSync } from 'fs'
import { RunRecord } from './record'
import type { Delta } from '../soak/deltas'

/**
 * The run's record from start to stop: kept across a resume and a restart, saved with the
 * run, and started afresh with a fresh run.
 */
export type RecordStart =
  /** the plugin restarted the run itself, at a scenario time from the page */
  | 'restart'
  /** the run carries on from where the saved run reached */
  | 'resume'
  /** a new run */
  | 'fresh'

export class RecordKeeper {
  record = new RunRecord()
  private sample?: string

  constructor(
    /** where the record is saved: the plugin's data directory */
    private readonly file: () => string,
    private readonly log: (message: string) => void
  ) {}

  /** the record for a run starting at a scenario time */
  begin(sample: string, startMs: number, how: RecordStart): void {
    const kept = this.sample === sample && how !== 'fresh'
    if (!kept) {
      this.record =
        how === 'resume'
          ? (this.load(sample) ?? new RunRecord())
          : new RunRecord()
    }
    this.sample = sample
    // a run restarted earlier than it had got to sends those hours again
    this.record.truncateAfter(startMs - 1)
  }

  add(delta: Delta, scenarioMs: number): void {
    this.record.add(delta, scenarioMs)
  }

  /** written whole and then renamed, so a stop mid-write cannot leave half a file */
  save(): void {
    if (!this.sample) return
    const temporary = this.file() + '.tmp'
    writeFileSync(temporary, this.record.save({ sample: this.sample }))
    renameSync(temporary, this.file())
  }

  private load(sample: string): RunRecord | undefined {
    if (!existsSync(this.file())) return undefined
    try {
      const restored = RunRecord.restore(readFileSync(this.file()), sample)
      if (!restored)
        this.log(`the saved record is for another run; starting a fresh one`)
      return restored
    } catch (error) {
      this.log(`ignoring the saved record: ${(error as Error).message}`)
      return undefined
    }
  }
}
