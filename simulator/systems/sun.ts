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

/** local solar hour, 0 to 24, for daily patterns such as meals */
export function solarHour(timeMs: number, lon: number): number {
  const utcHours = (((timeMs % DAY_MS) + DAY_MS) % DAY_MS) / 3600000
  return (((utcHours + lon / 15) % 24) + 24) % 24
}
