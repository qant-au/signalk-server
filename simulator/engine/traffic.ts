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
  reportingIntervalSeconds,
  staticIntervalSeconds
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
}

/** a target's static and voyage data: what AIS message 5 (Class A) or 24 (Class B) carries */
export interface TargetStatic {
  name?: string
  imo?: string
  callSign?: string
  destination?: string
  etaMs?: number
}

export interface TargetState {
  id: string
  /** Signal K context, `vessels.urn:...` */
  context: string
  mmsi?: string
  name?: string
  station: AisStation
  description: TargetDescription
  voyage: TargetStatic
  lat: number
  lon: number
  sogKn: number
  cogDeg?: number
  headingDeg?: number
  rotDegMin?: number
  navStatus?: number
  /** changing course, which makes a Class A station report faster */
  turning: boolean
}

export interface HeardTarget extends TargetState {
  /** true when static data is due with this report */
  withStatic: boolean
}

const MMSI_PATTERN = /^\d{9}$/
const DEGREES_PER_TURN = 360
/** a course changing faster than this, degrees a minute, counts as changing course */
const TURNING_DEG_MIN = 5
const MOVING_KN = 0.5

/** the first value any report gives, for data that does not change along a voyage */
function first<T>(
  reports: AisReport[],
  pick: (r: AisReport) => T | undefined
): T | undefined {
  for (const r of reports) {
    const v = pick(r)
    if (v !== undefined) return v
  }
  return undefined
}

function wrap180(deg: number): number {
  return ((((deg + 180) % 360) + 360) % 360) - 180
}

class Track {
  readonly context: string
  readonly mmsi?: string
  readonly station: AisStation
  readonly description: TargetDescription
  readonly voyage: TargetStatic
  nextTransmitMs = 0
  lastHeardMs = -Infinity
  lastIntervalS = 0
  lastStaticMs = -Infinity

  constructor(
    readonly id: string,
    readonly reports: AisReport[],
    readonly name: string | undefined
  ) {
    this.description = {
      transceiver: first(reports, (r) => r.target.transceiver),
      typeCode: first(reports, (r) => r.target.typeCode),
      typeText: first(reports, (r) => r.target.typeText),
      lengthM: first(reports, (r) => r.target.lengthM),
      beamM: first(reports, (r) => r.target.beamM),
      draughtM: first(reports, (r) => r.target.draughtM)
    }
    this.voyage = {
      name,
      imo: first(reports, (r) => r.imo),
      callSign: first(reports, (r) => r.callSign),
      destination: first(reports, (r) => r.destination),
      etaMs: first(reports, (r) => r.etaMs)
    }
    this.station = estimateStation(this.description)
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
    const sogKn = a.sogKn + (b.sogKn - a.sogKn) * f
    // turning by its own rate of turn, or by its course between the reports either side
    const minutes = (b.timeMs - a.timeMs) / 60000
    const courseRate =
      a.cogDeg !== undefined && b.cogDeg !== undefined && minutes > 0
        ? Math.abs(wrap180(b.cogDeg - a.cogDeg)) / minutes
        : 0
    const turning =
      sogKn > MOVING_KN &&
      (near.rotDegMin !== undefined
        ? Math.abs(near.rotDegMin) > TURNING_DEG_MIN
        : courseRate > TURNING_DEG_MIN)
    return {
      id: this.id,
      context: this.context,
      mmsi: this.mmsi,
      name: this.name,
      station: this.station,
      description: this.description,
      voyage: this.voyage,
      lat: a.lat + (b.lat - a.lat) * f,
      lon: a.lon + (b.lon - a.lon) * f,
      sogKn,
      rotDegMin: near.rotDegMin,
      navStatus: near.navStatus,
      turning,
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
          state?.sogKn ?? 0,
          state?.navStatus,
          state?.turning
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
          toMs - track.lastStaticMs >=
          staticIntervalSeconds(track.station.aisClass) * 1000
        if (withStatic) track.lastStaticMs = toMs
        heard.push({ ...latest, withStatic })
      } else if (
        track.lastHeardMs > -Infinity &&
        toMs - track.lastHeardMs > lostAfterSeconds(track.lastIntervalS) * 1000
      ) {
        lost.push(track.context)
        track.lastHeardMs = -Infinity
        // heard again, it is a new target to the receiver, as it was the first time
        track.lastStaticMs = -Infinity
      }
    }
    return { heard, lost }
  }
}
