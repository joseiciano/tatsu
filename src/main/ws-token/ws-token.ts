// The WS/web-client auth token lives in the encrypted secrets store so
// it survives main-process restarts. That lets users pin a web-client
// URL to their phone's homescreen or bookmark it and have the link
// keep working across reboots. When safeStorage is unavailable (rare
// — only headless CI and Linux without a keyring), setSecret silently
// no-ops and we fall back to a fresh token on every boot, matching
// the pre-persistence behavior.

import { randomBytes, timingSafeEqual } from 'crypto'
import { getSecret, setSecret } from '../secrets'

const SECRET_KEY = 'wsAuthToken'

export function getOrCreateWsToken(): string {
  const existing = getSecret(SECRET_KEY)
  if (existing) return existing
  return rotateWsToken()
}

export function rotateWsToken(): string {
  const token = randomBytes(32).toString('hex')
  setSecret(SECRET_KEY, token)
  return token
}


export function safeEqualToken(provided: unknown, expected: string): boolean {
  if (typeof provided !== 'string') return false
  const providedBuffer = Buffer.from(provided)
  const expectedBuffer = Buffer.from(expected)
  if (providedBuffer.length !== expectedBuffer.length) return false
  return timingSafeEqual(providedBuffer, expectedBuffer)
}

// ── Short-lived one-time browser session tokens ─────────────────────
// The web-client loads HTML with ?token=<root>, exchanges it over
// same-origin HTTP for a one-time session token, then connects WS
// with ?session=<session>.  Session tokens are single-use, expire
// after SESSION_TTL_MS, and live only in memory.

const SESSION_TTL_MS = 30_000

/** Maps session token → expiry timestamp (ms since epoch). */
const sessionTokens = new Map<string, number>()

/** Mint a short-lived one-time session token.
 *  Returns null if `provided` doesn't match `expected` (timing-safe). */
export function issueSessionToken(
  provided: unknown,
  expected: string
): string | null {
  if (!safeEqualToken(provided, expected)) return null
  const token = randomBytes(16).toString('hex')
  sessionTokens.set(token, Date.now() + SESSION_TTL_MS)
  return token
}

/** Consume a one-time session token.  Returns true if valid and
 *  not yet expired; the token is removed on first call (single-use). */
export function consumeSessionToken(provided: unknown): boolean {
  if (typeof provided !== 'string') return false
  const expiresAt = sessionTokens.get(provided)
  if (expiresAt === undefined) return false
  sessionTokens.delete(provided) // one-time use
  return Date.now() <= expiresAt
}
