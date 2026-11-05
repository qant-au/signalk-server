import type { Delta } from '../soak/deltas'

/**
 * What the boat has sent since the run started, for the History API and its playback.
 *
 * The own vessel: every numeric path and the position, one row every `RECORD_STEP_MS` of
 * scenario time, a row holding the last value each path sent in its ten seconds. A path
 * sent once a minute has a value in one row of six and nothing in the others. A day of
 * rows at most; the oldest goes as a new one comes.
 *
 * The AIS targets: each target's position, speed and course as it was heard, a row per
 * target per ten seconds it was heard in, in one shared ring of at most
 * `TARGET_ROWS_MAX` rows; rows more than a day older than the newest are dropped too.
 *
 * Everything is in typed arrays, so the memory is fixed by the counts: see `bytes`.
 */
export const RECORD_STEP_MS = 10_000
/** a day of rows at ten seconds */
export const RECORD_ROWS = 8640
export const TARGET_ROWS_MAX = 1_000_000
const TARGET_ROWS_START = 4096
/** a target row: its slot and target as 32-bit integers, its position in doubles, its speed and course in floats */
export const TARGET_ROW_BYTES = 4 + 4 + 8 + 8 + 4 + 4

/** the most a record takes: a day of each own path, its slots and position, and every target row */
export function recordBoundBytes(ownPaths: number): number {
  return (
    RECORD_ROWS * (4 + 8 + 8 + 8 * ownPaths) +
    TARGET_ROWS_MAX * TARGET_ROW_BYTES
  )
}
export const OWN_CONTEXT = 'vessels.self'
export const POSITION = 'navigation.position'
export const TARGET_PATHS = [
  POSITION,
  'navigation.speedOverGround',
  'navigation.courseOverGroundTrue'
] as const
const SOG = 1
const COG = 2

/** a value as the record gives it back: a number, the position as [lon, lat], or none */
export type RecordValue = number | [number, number] | null

/** one own row, or one target's row: its slot and how to read each path in it */
export interface RecordRow {
  ms: number
  value(path: string): RecordValue
}

export class RunRecord {
  private readonly targetRowsMax: number

  constructor(
    /** the most target rows the ring holds; smaller in the tests */
    targetRowsMax = TARGET_ROWS_MAX
  ) {
    this.targetRowsMax = targetRowsMax
    const n = Math.min(TARGET_ROWS_START, targetRowsMax)
    this.tSlot = new Int32Array(n)
    this.tWho = new Int32Array(n)
    this.tLat = new Float64Array(n)
    this.tLon = new Float64Array(n)
    this.tSog = new Float32Array(n)
    this.tCog = new Float32Array(n)
  }

  // the own vessel: row r holds slot ownSlot[r]; the ring starts at ownStart
  private readonly ownSlot = new Int32Array(RECORD_ROWS)
  private ownStart = 0
  private ownCount = 0
  /** a column per numeric path; the position is two, its latitude and its longitude */
  private readonly columns = new Map<string, Float64Array>()
  private readonly lat = new Float64Array(RECORD_ROWS).fill(NaN)
  private readonly lon = new Float64Array(RECORD_ROWS).fill(NaN)
  private hasPosition = false

  // the targets, one ring for all of them
  private tSlot: Int32Array
  private tWho: Int32Array
  private tLat: Float64Array
  private tLon: Float64Array
  private tSog: Float32Array
  private tCog: Float32Array
  private tStart = 0
  private tCount = 0
  private readonly targetIds = new Map<string, number>()
  private readonly targetNames: string[] = []
  /** the newest row of each target, by its number, while it is still in the ring */
  private readonly tLatest = new Map<number, number>()

  /** the scenario time of the newest slot, or undefined while the record is empty */
  get endMs(): number | undefined {
    const own = this.ownCount ? this.slotAt(this.ownCount - 1) : -Infinity
    const target = this.tCount
      ? this.tSlot[this.tIndex(this.tCount - 1)]
      : -Infinity
    const end = Math.max(own, target)
    return Number.isFinite(end) ? end * RECORD_STEP_MS : undefined
  }

  get startMs(): number | undefined {
    const own = this.ownCount ? this.slotAt(0) : Infinity
    const target = this.tCount ? this.tSlot[this.tIndex(0)] : Infinity
    const start = Math.min(own, target)
    return Number.isFinite(start) ? start * RECORD_STEP_MS : undefined
  }

  /** the own rows and the target rows held */
  get rows(): number {
    return this.ownCount + this.tCount
  }

  /** the memory the record's arrays take */
  get bytes(): number {
    const own =
      this.ownSlot.byteLength +
      this.lat.byteLength +
      this.lon.byteLength +
      this.columns.size * RECORD_ROWS * 8
    const targets =
      this.tSlot.byteLength +
      this.tWho.byteLength +
      this.tLat.byteLength +
      this.tLon.byteLength +
      this.tSog.byteLength +
      this.tCog.byteLength
    return own + targets
  }

  /** takes in a delta sent at a scenario time */
  add(delta: Delta, scenarioMs: number): void {
    const slot = Math.floor(scenarioMs / RECORD_STEP_MS)
    if (delta.context === OWN_CONTEXT) this.addOwn(delta, slot)
    else this.addTarget(delta, slot)
  }

  private addOwn(delta: Delta, slot: number): void {
    let row = -1
    for (const u of delta.updates) {
      for (const { path, value } of u.values) {
        const position = path === POSITION && isPosition(value)
        if (typeof value !== 'number' && !position) continue
        if (row < 0) row = this.ownRow(slot)
        if (position) {
          this.lat[row] = value.latitude
          this.lon[row] = value.longitude
          this.hasPosition = true
        } else if (Number.isFinite(value)) {
          this.column(path)[row] = value as number
        }
      }
    }
  }

  /** the ring index of the row for a slot, a new row when the slot is new */
  private ownRow(slot: number): number {
    if (this.ownCount && slot <= this.slotAt(this.ownCount - 1)) {
      return this.ownIndex(this.ownCount - 1)
    }
    // a day at most, however far apart the rows are
    while (this.ownCount && this.slotAt(0) <= slot - RECORD_ROWS) {
      this.ownStart = (this.ownStart + 1) % RECORD_ROWS
      this.ownCount--
    }
    let index: number
    if (this.ownCount < RECORD_ROWS) {
      index = this.ownIndex(this.ownCount)
      this.ownCount++
    } else {
      index = this.ownStart
      this.ownStart = (this.ownStart + 1) % RECORD_ROWS
    }
    this.ownSlot[index] = slot
    this.lat[index] = NaN
    this.lon[index] = NaN
    for (const c of this.columns.values()) c[index] = NaN
    return index
  }

  private column(path: string): Float64Array {
    let c = this.columns.get(path)
    if (!c) {
      c = new Float64Array(RECORD_ROWS).fill(NaN)
      this.columns.set(path, c)
    }
    return c
  }

  private addTarget(delta: Delta, slot: number): void {
    let position: { latitude: number; longitude: number } | undefined
    let sog = NaN
    let cog = NaN
    for (const u of delta.updates) {
      for (const { path, value } of u.values) {
        if (path === POSITION && isPosition(value)) position = value
        else if (typeof value !== 'number') continue
        else if (path === TARGET_PATHS[SOG]) sog = value
        else if (path === TARGET_PATHS[COG]) cog = value
      }
    }
    if (!position && Number.isNaN(sog) && Number.isNaN(cog)) return
    let who = this.targetIds.get(delta.context)
    if (who === undefined) {
      who = this.targetNames.length
      this.targetIds.set(delta.context, who)
      this.targetNames.push(delta.context)
    }
    this.dropOlderThanADay(slot)
    const latest = this.tLatest.get(who)
    let index: number
    if (latest !== undefined && this.tSlot[latest] === slot) {
      index = latest
    } else {
      index = this.newTargetRow()
      this.tSlot[index] = slot
      this.tWho[index] = who
      this.tLat[index] = NaN
      this.tLon[index] = NaN
      this.tSog[index] = NaN
      this.tCog[index] = NaN
      this.tLatest.set(who, index)
    }
    if (position) {
      this.tLat[index] = position.latitude
      this.tLon[index] = position.longitude
    }
    if (!Number.isNaN(sog)) this.tSog[index] = sog
    if (!Number.isNaN(cog)) this.tCog[index] = cog
  }

  private dropOlderThanADay(slot: number): void {
    while (this.tCount && this.tSlot[this.tStart] <= slot - RECORD_ROWS) {
      this.dropOldestTarget()
    }
  }

  private dropOldestTarget(): void {
    const index = this.tStart
    const who = this.tWho[index]
    if (this.tLatest.get(who) === index) this.tLatest.delete(who)
    this.tStart = (this.tStart + 1) % this.tSlot.length
    this.tCount--
  }

  private newTargetRow(): number {
    if (this.tCount === this.tSlot.length) {
      if (this.tSlot.length < this.targetRowsMax) this.growTargets()
      else this.dropOldestTarget()
    }
    const index = this.tIndex(this.tCount)
    this.tCount++
    return index
  }

  /** doubles the target ring, unrolled so it starts at 0 */
  private growTargets(): void {
    const size = Math.min(this.targetRowsMax, this.tSlot.length * 2)
    const order = Array.from({ length: this.tCount }, (_, i) => this.tIndex(i))
    const remap = <T extends Int32Array | Float64Array | Float32Array>(
      from: T,
      make: (n: number) => T
    ): T => {
      const to = make(size)
      order.forEach((index, i) => {
        to[i] = from[index]
      })
      return to
    }
    const moved = new Map<number, number>()
    order.forEach((index, i) => moved.set(index, i))
    this.tSlot = remap(this.tSlot, (n) => new Int32Array(n))
    this.tWho = remap(this.tWho, (n) => new Int32Array(n))
    this.tLat = remap(this.tLat, (n) => new Float64Array(n))
    this.tLon = remap(this.tLon, (n) => new Float64Array(n))
    this.tSog = remap(this.tSog, (n) => new Float32Array(n))
    this.tCog = remap(this.tCog, (n) => new Float32Array(n))
    for (const [who, index] of this.tLatest) {
      this.tLatest.set(who, moved.get(index)!)
    }
    this.tStart = 0
  }

  /** drops the rows after a scenario time, for a run restarted earlier than it had got to */
  truncateAfter(scenarioMs: number): void {
    const slot = Math.floor(scenarioMs / RECORD_STEP_MS)
    while (this.ownCount && this.slotAt(this.ownCount - 1) > slot) {
      this.ownCount--
    }
    while (this.tCount && this.tSlot[this.tIndex(this.tCount - 1)] > slot) {
      const index = this.tIndex(this.tCount - 1)
      if (this.tLatest.get(this.tWho[index]) === index) {
        this.tLatest.delete(this.tWho[index])
      }
      this.tCount--
    }
  }

  private ownIndex(i: number): number {
    return (this.ownStart + i) % RECORD_ROWS
  }

  private slotAt(i: number): number {
    return this.ownSlot[this.ownIndex(i)]
  }

  private tIndex(i: number): number {
    return (this.tStart + i) % this.tSlot.length
  }

  /** the own vessel's paths with a value in the range, the position among them */
  ownPaths(fromMs: number, toMs: number): string[] {
    const rows = this.ownIndexes(fromMs, toMs)
    const has = (c: Float64Array) => rows.some((r) => !Number.isNaN(c[r]))
    const paths = [...this.columns].filter(([, c]) => has(c)).map(([p]) => p)
    if (this.hasPosition && has(this.lat)) paths.push(POSITION)
    return paths.sort()
  }

  /** the targets heard in the range, by context */
  targets(fromMs: number, toMs: number): string[] {
    const heard = new Set<string>()
    for (const r of this.targetIndexes(fromMs, toMs)) {
      heard.add(this.targetNames[this.tWho[r]])
    }
    return [...heard].sort()
  }

  /** the paths a target has values for in the range */
  targetPaths(context: string, fromMs: number, toMs: number): string[] {
    const rows = this.targetRows(context, fromMs, toMs)
    return TARGET_PATHS.filter((p) => rows.some((r) => r.value(p) !== null))
  }

  /** the own vessel has a row in the range */
  hasOwn(fromMs: number, toMs: number): boolean {
    return this.ownIndexes(fromMs, toMs).length > 0
  }

  /** the own rows in a range, oldest first: from inclusive, to exclusive */
  ownRows(fromMs: number, toMs: number): RecordRow[] {
    return this.ownIndexes(fromMs, toMs).map((r) => ({
      ms: this.ownSlot[r] * RECORD_STEP_MS,
      value: (path: string) => {
        if (path === POSITION) {
          return Number.isNaN(this.lat[r]) ? null : [this.lon[r], this.lat[r]]
        }
        const v = this.columns.get(path)?.[r]
        return v === undefined || Number.isNaN(v) ? null : v
      }
    }))
  }

  /** a target's rows in a range, oldest first */
  targetRows(context: string, fromMs: number, toMs: number): RecordRow[] {
    const who = this.targetIds.get(context)
    if (who === undefined) return []
    return this.targetIndexes(fromMs, toMs)
      .filter((r) => this.tWho[r] === who)
      .map((r) => this.targetRow(r))
  }

  /** every row in a range, own and targets, oldest first, with its context */
  allRows(fromMs: number, toMs: number): { context: string; row: RecordRow }[] {
    const own = this.ownRows(fromMs, toMs).map((row) => ({
      context: OWN_CONTEXT,
      row
    }))
    const targets = this.targetIndexes(fromMs, toMs).map((r) => ({
      context: this.targetNames[this.tWho[r]],
      row: this.targetRow(r)
    }))
    // both are in time order; a stable sort keeps the own row first within a slot
    return [...own, ...targets].sort((a, b) => a.row.ms - b.row.ms)
  }

  /** the paths each row of the own vessel can hold */
  get ownPathNames(): string[] {
    return [...this.columns.keys(), ...(this.hasPosition ? [POSITION] : [])]
  }

  private targetRow(r: number): RecordRow {
    return {
      ms: this.tSlot[r] * RECORD_STEP_MS,
      value: (path: string) => {
        const pick =
          path === POSITION
            ? Number.isNaN(this.tLat[r])
              ? null
              : ([this.tLon[r], this.tLat[r]] as [number, number])
            : path === TARGET_PATHS[SOG]
              ? this.tSog[r]
              : path === TARGET_PATHS[COG]
                ? this.tCog[r]
                : NaN
        return typeof pick === 'number' && Number.isNaN(pick) ? null : pick
      }
    }
  }

  private ownIndexes(fromMs: number, toMs: number): number[] {
    const out: number[] = []
    for (let i = 0; i < this.ownCount; i++) {
      const ms = this.slotAt(i) * RECORD_STEP_MS
      if (ms >= fromMs && ms < toMs) out.push(this.ownIndex(i))
    }
    return out
  }

  private targetIndexes(fromMs: number, toMs: number): number[] {
    const out: number[] = []
    for (let i = 0; i < this.tCount; i++) {
      const index = this.tIndex(i)
      const ms = this.tSlot[index] * RECORD_STEP_MS
      if (ms >= fromMs && ms < toMs) out.push(index)
    }
    return out
  }

  /** the record as one buffer: a JSON header and the rows, oldest first */
  save(meta: { sample: string }): Buffer {
    const own = Array.from({ length: this.ownCount }, (_, i) =>
      this.ownIndex(i)
    )
    const targets = Array.from({ length: this.tCount }, (_, i) =>
      this.tIndex(i)
    )
    const paths = [...this.columns.keys()]
    const header = Buffer.from(
      JSON.stringify({
        version: SAVE_VERSION,
        sample: meta.sample,
        step: RECORD_STEP_MS,
        paths,
        hasPosition: this.hasPosition,
        ownRows: own.length,
        targetRows: targets.length,
        targets: this.targetNames
      })
    )
    const pick = <T extends ArrayLike<number>>(
      from: T,
      rows: number[],
      make: (n: number) => Int32Array | Float64Array | Float32Array
    ) => {
      const to = make(rows.length)
      rows.forEach((r, i) => {
        to[i] = from[r]
      })
      return Buffer.from(to.buffer, to.byteOffset, to.byteLength)
    }
    const f64 = (n: number) => new Float64Array(n)
    const parts = [
      pick(this.ownSlot, own, (n) => new Int32Array(n)),
      pick(this.lat, own, f64),
      pick(this.lon, own, f64),
      ...paths.map((p) => pick(this.columns.get(p)!, own, f64)),
      pick(this.tSlot, targets, (n) => new Int32Array(n)),
      pick(this.tWho, targets, (n) => new Int32Array(n)),
      pick(this.tLat, targets, f64),
      pick(this.tLon, targets, f64),
      pick(this.tSog, targets, (n) => new Float32Array(n)),
      pick(this.tCog, targets, (n) => new Float32Array(n))
    ]
    const length = Buffer.alloc(4)
    length.writeUInt32LE(header.length)
    return Buffer.concat([length, header, ...parts])
  }

  /** a record from a saved buffer, or undefined when it is not one for this sample */
  static restore(buffer: Buffer, sample: string): RunRecord | undefined {
    const headerLength = buffer.readUInt32LE(0)
    const header = JSON.parse(
      buffer.subarray(4, 4 + headerLength).toString('utf8')
    ) as SavedHeader
    if (
      header.version !== SAVE_VERSION ||
      header.sample !== sample ||
      header.step !== RECORD_STEP_MS ||
      header.ownRows > RECORD_ROWS ||
      header.targetRows > TARGET_ROWS_MAX
    ) {
      return undefined
    }
    let at = 4 + headerLength
    const read = <T extends Int32Array | Float64Array | Float32Array>(
      n: number,
      make: (b: ArrayBuffer) => T,
      bytesEach: number
    ): T => {
      const copy = new Uint8Array(n * bytesEach)
      copy.set(buffer.subarray(at, at + n * bytesEach))
      at += n * bytesEach
      return make(copy.buffer)
    }
    const r = new RunRecord()
    const n = header.ownRows
    const slots = read(n, (b) => new Int32Array(b), 4)
    r.ownSlot.set(slots)
    r.lat.set(read(n, (b) => new Float64Array(b), 8))
    r.lon.set(read(n, (b) => new Float64Array(b), 8))
    for (const p of header.paths) {
      r.column(p).set(read(n, (b) => new Float64Array(b), 8))
    }
    r.ownCount = n
    r.hasPosition = header.hasPosition
    const t = header.targetRows
    let size = TARGET_ROWS_START
    while (size < t) size *= 2
    size = Math.min(size, TARGET_ROWS_MAX)
    const into = <T extends Int32Array | Float64Array | Float32Array>(
      values: T,
      make: (n: number) => T
    ) => {
      const to = make(size)
      to.set(values)
      return to
    }
    r.tSlot = into(
      read(t, (b) => new Int32Array(b), 4),
      (k) => new Int32Array(k)
    )
    r.tWho = into(
      read(t, (b) => new Int32Array(b), 4),
      (k) => new Int32Array(k)
    )
    r.tLat = into(
      read(t, (b) => new Float64Array(b), 8),
      (k) => new Float64Array(k)
    )
    r.tLon = into(
      read(t, (b) => new Float64Array(b), 8),
      (k) => new Float64Array(k)
    )
    r.tSog = into(
      read(t, (b) => new Float32Array(b), 4),
      (k) => new Float32Array(k)
    )
    r.tCog = into(
      read(t, (b) => new Float32Array(b), 4),
      (k) => new Float32Array(k)
    )
    r.tCount = t
    header.targets.forEach((context, who) => {
      r.targetIds.set(context, who)
      r.targetNames.push(context)
    })
    for (let i = 0; i < t; i++) r.tLatest.set(r.tWho[i], i)
    return r
  }
}

/** the record's length, for the status line: "record 2 h 14 min" */
export function recordWords(record: RunRecord): string {
  const start = record.startMs
  const end = record.endMs
  if (start === undefined || end === undefined) return 'record empty'
  const minutes = Math.round((end - start) / 60000)
  const h = Math.floor(minutes / 60)
  return `record ${h ? `${h} h ` : ''}${minutes % 60} min`
}

const SAVE_VERSION = 1

interface SavedHeader {
  version: number
  sample: string
  step: number
  paths: string[]
  hasPosition: boolean
  ownRows: number
  targetRows: number
  targets: string[]
}

function isPosition(v: unknown): v is { latitude: number; longitude: number } {
  const p = v as { latitude?: unknown; longitude?: unknown } | null
  return (
    typeof p?.latitude === 'number' &&
    typeof p.longitude === 'number' &&
    Number.isFinite(p.latitude) &&
    Number.isFinite(p.longitude)
  )
}
