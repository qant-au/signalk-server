import { createHash } from 'crypto'
import {
  AisStation,
  TargetDescription,
  Receiver,
  distanceNm,
  estimateStation,
  isReportReceived,
  lostAfterSeconds,
  receptionRangeNm,
  reportingIntervalSeconds
} from '../ais/reception'
import { AisReport } from '../ais/targets'

/**
 * AIS traffic around the own boat. Each target's source track is interpolated in scenario
 * time, transmits at the real rate for its class and speed, and is heard only when the
 * reception model says a report gets through at that distance. A target not heard for long
 * enough is lost, and the simulator stops sending it, as a real receiver would.
 */
export interface TrafficOptions {
  receiver: Receiver
  /** longest gap between source reports to interpolate across, seconds */
  maxGapS: number
  /** how often a heard target's static data (name, dimensions) is sent, seconds */
  staticIntervalS: number
}

export interface TargetState {
  id: string
  /** Signal K context, `vessels.urn:...` */
  context: string
  mmsi?: string
  name?: string
  station: AisStation
  description: TargetDescription
  lat: number
  lon: number
  sogKn: number
  cogDeg?: number
  headingDeg?: number
}

export interface HeardTarget extends TargetState {
  /** true when static data is due with this report */
  withStatic: boolean
}

const MMSI_PATTERN = /^\d{9}$/
const DEGREES_PER_TURN = 360

class Track {
  readonly context: string
  readonly mmsi?: string
  readonly station: AisStation
  nextTransmitMs = 0
  lastHeardMs = -Infinity
  lastIntervalS = 0
  lastStaticMs = -Infinity

  constructor(
    readonly id: string,
    readonly reports: AisReport[],
    readonly name: string | undefined
  ) {
    this.station = estimateStation(reports[0].target)
    if (MMSI_PATTERN.test(id)) {
      this.mmsi = id
      this.context = `vessels.urn:mrn:imo:mmsi:${id}`
    } else {
      // Anonymised sources get a stable synthetic identity, never a made-up MMSI that
      // could collide with a real vessel.
      const h = createHash('sha256')
        .update(`simulator-target:${id}`)
        .digest('hex')
      this.context = `vessels.urn:mrn:signalk:uuid:${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`
    }
  }

  get firstMs(): number {
    return this.reports[0].timeMs
  }

  get lastMs(): number {
    return this.reports[this.reports.length - 1].timeMs
  }

  /** the target's state at a moment, or undefined when the source has no track there */
  at(timeMs: number, maxGapMs: number): TargetState | undefined {
    const r = this.reports
    if (timeMs < r[0].timeMs || timeMs > r[r.length - 1].timeMs)
      return undefined
    let lo = 0
    let hi = r.length - 1
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1
      if (r[mid].timeMs <= timeMs) lo = mid
      else hi = mid
    }
    const a = r[lo]
    const b = r[hi]
    if (b.timeMs - a.timeMs > maxGapMs) return undefined
    const f =
      b.timeMs > a.timeMs ? (timeMs - a.timeMs) / (b.timeMs - a.timeMs) : 0
    const near = f < 0.5 ? a : b
    return {
      id: this.id,
      context: this.context,
      mmsi: this.mmsi,
      name: this.name,
      station: this.station,
      description: a.target,
      lat: a.lat + (b.lat - a.lat) * f,
      lon: a.lon + (b.lon - a.lon) * f,
      sogKn: a.sogKn + (b.sogKn - a.sogKn) * f,
      cogDeg: near.cogDeg,
      headingDeg:
        near.headingDeg !== undefined && near.headingDeg < DEGREES_PER_TURN
          ? near.headingDeg
          : undefined
    }
  }
}

export class Traffic {
  private readonly tracks: Track[]
  private readonly receiver: Receiver

  constructor(
    reports: Iterable<AisReport>,
    private readonly options: TrafficOptions
  ) {
    const byId = new Map<string, AisReport[]>()
    for (const r of reports) {
      if (
        !Number.isFinite(r.lat) ||
        !Number.isFinite(r.lon) ||
        !Number.isFinite(r.timeMs)
      )
        continue
      let list = byId.get(r.id)
      if (!list) byId.set(r.id, (list = []))
      list.push(r)
    }
    this.tracks = [...byId.entries()].map(([id, list]) => {
      list.sort((x, y) => x.timeMs - y.timeMs)
      return new Track(id, list, list.find((r) => r.name)?.name)
    })
    this.receiver = options.receiver
  }

  get size(): number {
    return this.tracks.length
  }

  /**
   * Every report heard in (fromMs, toMs]: for each target, the transmissions due in that
   * window are judged in turn and the latest one heard is returned, so a fast clock sends
   * one update per target per tick however many transmissions it covered.
   */
  advance(
    fromMs: number,
    toMs: number,
    ownLat: number,
    ownLon: number
  ): { heard: HeardTarget[]; lost: string[] } {
    const heard: HeardTarget[] = []
    const lost: string[] = []
    const maxGapMs = this.options.maxGapS * 1000
    for (const track of this.tracks) {
      if (toMs < track.firstMs || fromMs > track.lastMs + maxGapMs) continue
      if (track.nextTransmitMs <= fromMs) {
        track.nextTransmitMs = Math.max(fromMs, track.firstMs)
      }
      let latest: TargetState | undefined
      while (track.nextTransmitMs <= toMs) {
        const t = track.nextTransmitMs
        const state = track.at(t, maxGapMs)
        const interval = reportingIntervalSeconds(
          track.station.aisClass,
          state?.sogKn ?? 0
        )
        track.nextTransmitMs = t + interval * 1000
        if (!state) continue
        const range = receptionRangeNm(track.station, this.receiver)
        const distance = distanceNm(ownLat, ownLon, state.lat, state.lon)
        if (isReportReceived(track.id, t, distance, range)) {
          track.lastHeardMs = t
          track.lastIntervalS = interval
          latest = state
        }
      }
      if (latest) {
        const withStatic =
          toMs - track.lastStaticMs >= this.options.staticIntervalS * 1000
        if (withStatic) track.lastStaticMs = toMs
        heard.push({ ...latest, withStatic })
      } else if (
        track.lastHeardMs > -Infinity &&
        toMs - track.lastHeardMs > lostAfterSeconds(track.lastIntervalS) * 1000
      ) {
        lost.push(track.context)
        track.lastHeardMs = -Infinity
      }
    }
    return { heard, lost }
  }
}
