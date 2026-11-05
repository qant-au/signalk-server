/**
 * Latitude and longitude to UTM easting and northing (Krüger series, as in the USGS
 * formulas), for depth grids published in a UTM projection such as NOAA BlueTopo. NAD83
 * and WGS84 differ by about a metre here, well under a grid cell, so one ellipsoid serves.
 */
const A = 6378137
const F = 1 / 298.257223563
const K0 = 0.9996
const E2 = F * (2 - F)
const EP2 = E2 / (1 - E2)
const FALSE_EASTING = 500000
const FALSE_NORTHING_SOUTH = 10000000

function utmZoneCentralMeridian(zone: number): number {
  return zone * 6 - 183
}

export function latLonToUtm(
  lat: number,
  lon: number,
  zone: number,
  south = false
): { easting: number; northing: number } {
  const rad = Math.PI / 180
  const phi = lat * rad
  const lambda = (lon - utmZoneCentralMeridian(zone)) * rad
  const sin = Math.sin(phi)
  const cos = Math.cos(phi)
  const tan = Math.tan(phi)
  const n = A / Math.sqrt(1 - E2 * sin * sin)
  const t = tan * tan
  const c = EP2 * cos * cos
  const a = cos * lambda
  const m =
    A *
    ((1 - E2 / 4 - (3 * E2 * E2) / 64 - (5 * E2 * E2 * E2) / 256) * phi -
      ((3 * E2) / 8 + (3 * E2 * E2) / 32 + (45 * E2 * E2 * E2) / 1024) *
        Math.sin(2 * phi) +
      ((15 * E2 * E2) / 256 + (45 * E2 * E2 * E2) / 1024) * Math.sin(4 * phi) -
      ((35 * E2 * E2 * E2) / 3072) * Math.sin(6 * phi))
  const easting =
    FALSE_EASTING +
    K0 *
      n *
      (a +
        ((1 - t + c) * a ** 3) / 6 +
        ((5 - 18 * t + t * t + 72 * c - 58 * EP2) * a ** 5) / 120)
  let northing =
    K0 *
    (m +
      n *
        tan *
        ((a * a) / 2 +
          ((5 - t + 9 * c + 4 * c * c) * a ** 4) / 24 +
          ((61 - 58 * t + t * t + 600 * c - 330 * EP2) * a ** 6) / 720))
  if (south) northing += FALSE_NORTHING_SOUTH
  return { easting, northing }
}
