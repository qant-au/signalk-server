import { createHash } from 'crypto'
import { Route } from './route'

/**
 * A route as a Signal K Resources API route, so a chart plotter (Freeboard on the rig)
 * draws the planned passage beside the boat sailing it.
 */
export interface RouteResource {
  name: string
  description: string
  feature: {
    type: 'Feature'
    geometry: { type: 'LineString'; coordinates: [number, number][] }
    properties: Record<string, never>
  }
}

/**
 * A stable id in UUID form, derived from the route's name, so publishing the same route
 * again replaces it rather than adding a copy.
 */
export function routeResourceId(route: Route): string {
  const h = createHash('sha256')
    .update(`simulator-route:${route.name}`)
    .digest('hex')
  return [
    h.slice(0, 8),
    h.slice(8, 12),
    '4' + h.slice(13, 16),
    ((parseInt(h[16], 16) & 0x3) | 0x8).toString(16) + h.slice(17, 20),
    h.slice(20, 32)
  ].join('-')
}

export function routeResource(route: Route): RouteResource {
  return {
    name: route.name,
    description: `Simulator route: ${route.vessel.description}, departing ${route.departure}`,
    feature: {
      type: 'Feature',
      geometry: {
        type: 'LineString',
        coordinates: route.waypoints.map((w) => [w.lon, w.lat])
      },
      properties: {}
    }
  }
}

export async function publishRoute(
  serverUrl: string,
  route: Route
): Promise<string> {
  const id = routeResourceId(route)
  const response = await fetch(
    `${serverUrl}/signalk/v2/api/resources/routes/${id}`,
    {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(routeResource(route))
    }
  )
  if (!response.ok) {
    throw new Error(`publishing the route returned HTTP ${response.status}`)
  }
  return id
}
