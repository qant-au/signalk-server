/**
 * What the server's course provider plugin works out from the speed and course over the
 * ground towards the next point: the speed made good to it and the time and arrival it
 * gives. A boat swinging to her anchor moves a little over the ground all the while, so
 * these would have her making for the next point at whatever her swing gives, arriving
 * some hours on. While she lies at anchor they go out as null, as for a boat not making
 * for it; the distance and bearing to the next point, which are true wherever she lies,
 * pass as they are.
 */
export const ARRIVAL_CLAIMS: ReadonlySet<string> = new Set([
  'navigation.course.calcValues.velocityMadeGood',
  'performance.velocityMadeGoodToWaypoint',
  'navigation.course.calcValues.timeToGo',
  'navigation.course.calcValues.estimatedTimeOfArrival',
  'navigation.course.calcValues.route.timeToGo',
  'navigation.course.calcValues.route.estimatedTimeOfArrival',
  'navigation.course.calcValues.targetSpeed'
])

/** a delta as the server hands it to an input handler, as far as this reads it */
export interface ClaimsDelta {
  context?: string
  updates?: { values?: { path: string; value: unknown }[] }[]
}

/** the delta with its arrival claims made null, or the delta itself when it has none */
export function withoutArrivalClaims<D extends ClaimsDelta>(delta: D): D {
  const updates = delta.updates
  if (!updates?.some((u) => u.values?.some((v) => ARRIVAL_CLAIMS.has(v.path))))
    return delta
  return {
    ...delta,
    updates: updates.map((u) =>
      u.values
        ? {
            ...u,
            values: u.values.map((v) =>
              ARRIVAL_CLAIMS.has(v.path) ? { path: v.path, value: null } : v
            )
          }
        : u
    )
  }
}
