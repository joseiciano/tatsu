// Exchange a root token for a short-lived one-time session token
// via the server's POST /_harness/session endpoint.
//
// The WS transport accepts two auth modes:
//   1. ?session=<one-time session token> — obtained by exchanging the
//      root token over HTTP first (this function). Keeps the root token
//      off the WS upgrade request.
//   2. Authorization: Bearer <root token> — for programmatic / Node.js
//      clients that can set headers on the WS handshake.
//
// The root token in ?token= is NOT accepted for WS (see server
// verify()). Browsers and Electron renderers must exchange first.

/** Derive the HTTP(S) origin from a ws(s) URL. Strips path/search so
 *  the caller can append its own path (e.g. /_harness/session). */
export function httpOriginFromWsUrl(wsUrl: string): string {
  const u = new URL(wsUrl)
  u.protocol = u.protocol === 'wss:' ? 'https:' : 'http:'
  u.pathname = '/'
  u.search = ''
  return u.origin
}

/** Exchange `rootToken` for a one-time session token via
 *  POST /_harness/session on the remote server. `wsUrl` is the
 *  WebSocket URL of the remote (ws:// or wss://). */
export async function exchangeForSessionToken(
  wsUrl: string,
  rootToken: string
): Promise<string> {
  const origin = httpOriginFromWsUrl(wsUrl)
  const res = await fetch(`${origin}/_harness/session`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${rootToken}` }
  })
  if (!res.ok) {
    throw new Error(`session exchange failed (${res.status})`)
  }
  const body = (await res.json()) as { sessionToken?: string }
  if (!body.sessionToken) {
    throw new Error('session exchange returned no token')
  }
  return body.sessionToken
}
