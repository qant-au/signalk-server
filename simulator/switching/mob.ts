/**
 * A person overboard: where they went in, and where they lie from the boat as she goes on.
 * The server's Notifications API raises and resolves the alarm (`notifications.mob.<id>`);
 * the run keeps the position and works out her bearing and distance from it.
 */

const METRES_PER_DEG_LAT = (6371000 * Math.PI) / 180
const RADIANS = Math.PI / 180
/** off the bow or the quarter within this, it is ahead or astern; between them, abeam */
const AHEAD_DEG = 45
const ASTERN_DEG = 135

export interface MobPosition {
  lat: number
  lon: number
}

/** where the person lies from her: metres, the bearing true, and the side it is on */
export interface MobFix {
  distanceM: number
  bearingDeg: number
  side: 'ahead' | 'to starboard' | 'astern' | 'to port'
}

/** the person's bearing and distance from the boat, her heading giving the side */
export function mobFix(
  boat: { lat: number; lon: number; headingDeg: number },
  mob: MobPosition
): MobFix {
  const east =
    (mob.lon - boat.lon) * METRES_PER_DEG_LAT * Math.cos(boat.lat * RADIANS)
  const north = (mob.lat - boat.lat) * METRES_PER_DEG_LAT
  const bearingDeg = norm360(Math.atan2(east, north) / RADIANS)
  const off = Math.abs(((bearingDeg - boat.headingDeg + 540) % 360) - 180)
  const starboard = norm360(bearingDeg - boat.headingDeg) < 180
  return {
    distanceM: Math.hypot(east, north),
    bearingDeg,
    side:
      off <= AHEAD_DEG
        ? 'ahead'
        : off >= ASTERN_DEG
          ? 'astern'
          : starboard
            ? 'to starboard'
            : 'to port'
  }
}

/** "person overboard, 120 m astern, bearing 263°", as the status line says it */
export function mobWords(fix: MobFix): string {
  const bearing = String(Math.round(fix.bearingDeg) % 360).padStart(3, '0')
  return `person overboard, ${Math.round(fix.distanceM)} m ${fix.side}, bearing ${bearing}°`
}

function norm360(deg: number): number {
  return ((deg % 360) + 360) % 360
}
