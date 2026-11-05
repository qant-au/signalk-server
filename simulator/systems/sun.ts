const DAY_MS = 86400000
const RADIANS = Math.PI / 180
/** obliquity of the ecliptic, degrees */
const OBLIQUITY = 23.44

/**
 * Elevation of the sun above the horizon, radians, at a time and place. A low-precision
 * formula (within about a degree), which is plenty for solar output and air temperature.
 */
export function sunElevation(timeMs: number, lat: number, lon: number): number {
  const days = timeMs / DAY_MS - 10957.5 // since J2000.0
  const meanAnomaly = (357.529 + 0.98560028 * days) * RADIANS
  const meanLongitude = 280.459 + 0.98564736 * days
  const eclipticLongitude =
    (meanLongitude +
      1.915 * Math.sin(meanAnomaly) +
      0.02 * Math.sin(2 * meanAnomaly)) *
    RADIANS
  const declination = Math.asin(
    Math.sin(OBLIQUITY * RADIANS) * Math.sin(eclipticLongitude)
  )
  const utcHours = (((timeMs % DAY_MS) + DAY_MS) % DAY_MS) / 3600000
  const hourAngle = ((utcHours - 12) * 15 + lon) * RADIANS
  return Math.asin(
    Math.sin(lat * RADIANS) * Math.sin(declination) +
      Math.cos(lat * RADIANS) * Math.cos(declination) * Math.cos(hourAngle)
  )
}

/** the sun's upper limb on the horizon, refraction included: sunrise and sunset, degrees */
const HORIZON_DEG = -0.833
const SEARCH_STEP_MS = 10 * 60 * 1000
const SEARCH_TO_MS = 1000

/**
 * Sunrise and sunset in the day from `dayStartMs`, as the sun's upper limb crosses the
 * horizon; either is missing on a day the sun does not rise or set
 */
export function sunTimes(
  dayStartMs: number,
  lat: number,
  lon: number
): { sunriseMs?: number; sunsetMs?: number } {
  const above = (ms: number) =>
    sunElevation(ms, lat, lon) > HORIZON_DEG * RADIANS
  const out: { sunriseMs?: number; sunsetMs?: number } = {}
  let before = above(dayStartMs)
  for (
    let t = dayStartMs + SEARCH_STEP_MS;
    t <= dayStartMs + DAY_MS;
    t += SEARCH_STEP_MS
  ) {
    const now = above(t)
    if (now !== before) {
      let lo = t - SEARCH_STEP_MS
      let hi = t
      while (hi - lo > SEARCH_TO_MS) {
        const mid = (lo + hi) / 2
        if (above(mid) === before) lo = mid
        else hi = mid
      }
      const at = Math.round(hi / 1000) * 1000
      if (now && out.sunriseMs === undefined) out.sunriseMs = at
      if (!now && out.sunsetMs === undefined) out.sunsetMs = at
    }
    before = now
  }
  return out
}

/**
 * The local midnight a time's day starts at, at the longitude: in the nominal time zone,
 * a whole number of hours from UTC
 */
export function localDayStart(ms: number, lon: number): number {
  const offset = Math.round(lon / 15) * 3600000
  return Math.floor((ms + offset) / DAY_MS) * DAY_MS - offset
}

/** local solar hour, 0 to 24, for daily patterns such as meals */
export function solarHour(timeMs: number, lon: number): number {
  const utcHours = (((timeMs % DAY_MS) + DAY_MS) % DAY_MS) / 3600000
  return (((utcHours + lon / 15) % 24) + 24) % 24
}
