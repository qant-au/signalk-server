/**
 * Makes the plugin the server's default history provider, through the server's own
 * History API: `POST /signalk/v2/api/history/_providers/_default/:id`, which saves it in
 * the server's settings. The server offers a plugin no other way to change its default,
 * and only this route changes it while the server runs, so the server never warns that a
 * provider its settings name is missing. A plugin reaches the route over the loopback;
 * where it cannot (a server with security on answers 403, one serving only TLS refuses
 * plain HTTP), it says so and the default stays as it was.
 */
export interface DefaultProviderResult {
  /** the default before, when the server could be asked */
  was?: string
  changed: boolean
  /** why it could not be made the default */
  problem?: string
}

const HISTORY = '/signalk/v2/api/history/_providers/_default'

export async function makeDefaultHistoryProvider(
  baseUrl: string,
  pluginId: string,
  fetchImpl: typeof fetch = fetch
): Promise<DefaultProviderResult> {
  try {
    const now = await fetchImpl(baseUrl + HISTORY)
    const current = now.ok
      ? ((await now.json()) as { id?: string; configured?: string })
      : {}
    if (current.id === pluginId && current.configured === pluginId) {
      return { was: pluginId, changed: false }
    }
    const res = await fetchImpl(`${baseUrl}${HISTORY}/${pluginId}`, {
      method: 'POST'
    })
    if (!res.ok) {
      const body = (await res.json().catch(() => ({}))) as { message?: string }
      return {
        was: current.configured ?? current.id,
        changed: false,
        problem: `the server answered ${res.status}${body.message ? `: ${body.message}` : ''}`
      }
    }
    return { was: current.configured ?? current.id, changed: true }
  } catch (error) {
    return { changed: false, problem: (error as Error).message }
  }
}
