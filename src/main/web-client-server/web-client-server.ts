// HTTP server that serves the bundled web-client renderer to remote
// browsers. Designed to share its port with the WS transport: clients
// fetch `http://host:port/?token=…` to load index.html, then the
// renderer exchanges that root token over same-origin HTTP for a
// short-lived one-time session token, and connects via WS with
// `?session=<session_token>`.
//
// Auth model:
//   - HTML entry (`/`, `/index.html`) requires `?token=<token>` on the
//     URL (or an `Authorization: Bearer <token>` header). Unauthenticated
//     requests get 401 with a plaintext hint — the token is never
//     disclosed to a caller that didn't already present it.
//   - `POST /_harness/session` exchanges a valid root token
//     (`?token=` or `Authorization: Bearer`) for a short-lived,
//     one-time-use session token the browser uses for the WS upgrade.
//   - WS upgrade on the same port accepts `?session=<session_token>`
//     (one-time browser tokens) or `Authorization: Bearer <root_token>`
//     (programmatic clients). The root token in `?token=` is NOT
//     accepted for WS — browsers must exchange it first.
//   - Static assets (CSS, JS chunks, images, favicon, manifest, fonts)
//     are intentionally ungated: they don't carry the token, browsers
//     often fetch them without query strings (favicon/manifest), and
//     once the HTML entry is gated an attacker with no token has no way
//     to bootstrap a useful asset fetch in-context.
//
// Threat model: binding to 127.0.0.1 is effectively unauthenticated in
// practice (local users can read the token from the running process).
// Binding to 0.0.0.0 exposes to the LAN — the 32-byte token is the only
// thing between an untrusted LAN peer and the main process. No TLS yet;
// only enable LAN bind on a trusted network.
//
// PWA manifest injection: the static `manifest.webmanifest` on disk has
// `start_url: "."`, which would make iOS "Add to Home Screen" shortcuts
// open `/` with no token and hit the 401 gate. To fix this without
// leaking the token in the on-disk file, we do two things when serving
// an authenticated request:
//   - rewrite the `<link rel="manifest" href="…">` tag in index.html to
//     point at `./manifest.webmanifest?token=<token>`, so Safari fetches
//     the manifest with the token attached.
//   - respond to authenticated `/manifest.webmanifest` requests with a
//     JSON body whose `start_url` is `./?token=<token>`, so the home
//     screen shortcut inherits the token.
// Unauthenticated manifest requests fall through to the static file
// (start_url stays `.`), so a token is never disclosed to a caller that
// didn't already present one.

import { createServer, type IncomingMessage, type Server as HttpServer } from 'http'
import { readFile, stat } from 'fs/promises'
import { extname, join, resolve, sep } from 'path'
import { log } from '../debug'
import { issueSessionToken } from '../ws-token'

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.ico': 'image/x-icon',
  '.map': 'application/json',
  '.webmanifest': 'application/manifest+json'
}

export interface WebClientServerOptions {
  token: string
  rootDir: string
}

/** Build an http.Server that serves the web-client bundle. Caller is
 *  responsible for .listen(); the same server is also handed to the
 *  WebSocketServerTransport so the two share a port. */
export function createWebClientServer(opts: WebClientServerOptions): HttpServer {
  const root = resolve(opts.rootDir)
  const indexPath = join(root, 'index.html')
  return createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? '/', 'http://localhost')
      let pathname = decodeURIComponent(url.pathname)
      if (pathname === '/' || pathname === '') pathname = '/index.html'

      // POST /_harness/session — exchange root token for a short-lived
      // one-time session token the browser uses for the WS upgrade.
      // Also handle OPTIONS for CORS preflight from cross-origin renderers.
      if (pathname === '/_harness/session') {
        // CORS headers for cross-origin requests from the Electron renderer
        res.setHeader('Access-Control-Allow-Origin', '*')
        res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS')
        res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type')
        res.setHeader('Access-Control-Max-Age', '86400')

        if (req.method === 'OPTIONS') {
          res.statusCode = 204
          res.end()
          return
        }

        if (req.method === 'POST') {
          const rootToken = extractBearerToken(req) ?? url.searchParams.get('token')
          const sessionToken = issueSessionToken(rootToken, opts.token)
          if (!sessionToken) {
            res.statusCode = 401
            res.setHeader('Content-Type', 'text/plain; charset=utf-8')
            res.end('unauthorized')
            return
          }
          res.statusCode = 200
          res.setHeader('Content-Type', 'application/json')
          res.setHeader('Cache-Control', 'no-store')
          res.end(JSON.stringify({ sessionToken }))
          return
        }

        res.statusCode = 405
        res.setHeader('Allow', 'POST, OPTIONS')
        res.end('method not allowed')
        return
      }

      const filePath = resolve(join(root, pathname))
      if (filePath !== root && !filePath.startsWith(root + sep)) {
        res.statusCode = 403
        res.end('forbidden')
        return
      }

      const isHtmlEntry = filePath === indexPath
      const isManifest = pathname === '/manifest.webmanifest'
      if (isHtmlEntry && !hasValidToken(req, url, opts.token)) {
        res.statusCode = 401
        res.setHeader('Content-Type', 'text/plain; charset=utf-8')
        res.end('unauthorized — append ?token=<token> to the URL')
        return
      }

      let content: Buffer | null = null
      try {
        const st = await stat(filePath)
        if (st.isFile()) content = await readFile(filePath)
      } catch {
        // fall through to 404 / SPA fallback below
      }

      if (!content) {
        if (pathname === '/index.html') {
          res.statusCode = 404
          res.end('web-client bundle not found — run `pnpm build` first')
          return
        }
        // Asset miss: return 404 rather than falling back to index.html —
        // a /static/foo.js 404 surfaces build misconfig cleanly.
        res.statusCode = 404
        res.end('not found')
        return
      }

      if (isHtmlEntry) {
        const tokenEnc = encodeURIComponent(opts.token)
        const html = content
          .toString('utf8')
          .replace(
            /<link\s+rel=["']manifest["']\s+href=["'][^"']*["']\s*\/?>/,
            `<link rel="manifest" href="./manifest.webmanifest?token=${tokenEnc}" />`
          )
        res.setHeader('Content-Type', MIME['.html'])
        res.end(html)
        return
      }

      if (isManifest && hasValidToken(req, url, opts.token)) {
        try {
          const manifest = JSON.parse(content.toString('utf8')) as Record<string, unknown>
          manifest.start_url = `./?token=${encodeURIComponent(opts.token)}`
          res.setHeader('Content-Type', 'application/manifest+json')
          res.setHeader('Cache-Control', 'no-store')
          res.end(JSON.stringify(manifest))
          return
        } catch {
          // fall through to serving the static manifest as-is
        }
      }

      const ext = extname(pathname).toLowerCase()
      const mime = MIME[ext] ?? 'application/octet-stream'
      res.setHeader('Content-Type', mime)
      res.end(content)
    } catch (err) {
      log('web-client', 'http error', err instanceof Error ? err.message : String(err))
      res.statusCode = 500
      res.end('server error')
    }
  })
}

function hasValidToken(req: IncomingMessage, url: URL, expected: string): boolean {
  const q = url.searchParams.get('token')
  if (q && q === expected) return true
  const auth = req.headers['authorization']
  if (typeof auth === 'string') {
    const m = auth.match(/^Bearer\s+(.+)$/i)
    if (m && m[1] === expected) return true
  }
  return false
}

function extractBearerToken(req: IncomingMessage): string | null {
  const auth = req.headers['authorization']
  if (typeof auth !== 'string') return null
  const m = auth.match(/^Bearer\s+(.+)$/i)
  return m ? m[1] : null
}
