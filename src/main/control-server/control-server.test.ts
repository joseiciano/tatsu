import { Readable } from 'stream'
import type { IncomingMessage } from 'http'
import { describe, it, expect } from 'vitest'
import { createControlRateLimiter, parseAgentKind, parseCreateBrowserTabUrl, readJson, validateBrowserNavigationUrl } from '.'

describe('parseAgentKind', () => {
  it('returns undefined for missing/empty values', () => {
    expect(parseAgentKind(undefined)).toEqual({ kind: undefined })
    expect(parseAgentKind(null)).toEqual({ kind: undefined })
    expect(parseAgentKind('')).toEqual({ kind: undefined })
  })

  it('accepts claude', () => {
    expect(parseAgentKind('claude')).toEqual({ kind: 'claude' })
    expect(parseAgentKind('CLAUDE')).toEqual({ kind: 'claude' })
    expect(parseAgentKind('  claude  ')).toEqual({ kind: 'claude' })
  })

  it('accepts codex', () => {
    expect(parseAgentKind('codex')).toEqual({ kind: 'codex' })
    expect(parseAgentKind('CODEX')).toEqual({ kind: 'codex' })
  })

  it('accepts opencode', () => {
    expect(parseAgentKind('opencode')).toEqual({ kind: 'opencode' })
    expect(parseAgentKind('OPENCODE')).toEqual({ kind: 'opencode' })
  })

  it('rejects unknown agents', () => {
    expect(parseAgentKind('foo')).toEqual({
      error: 'agentKind must be "claude", "codex", or "opencode"'
    })
  })
})

function requestWithBody(body: string): Parameters<typeof readJson>[0] {
  return Readable.from([Buffer.from(body)]) as Parameters<typeof readJson>[0]
}

describe('readJson', () => {
  it('rejects bodies over the configured byte limit', async () => {
    await expect(readJson(requestWithBody('{\"x\":1}'), 6)).rejects.toMatchObject({
      statusCode: 413
    })
  })

  it('accepts bodies at the configured byte limit', async () => {
    await expect(readJson(requestWithBody('{\"x\":1}'), 7)).resolves.toEqual({ x: 1 })
  })
})

function requestFrom(remoteAddress: string, terminalId?: string): IncomingMessage {
  return {
    headers: terminalId ? { 'x-harness-terminal-id': terminalId } : {},
    socket: { remoteAddress }
  } as unknown as IncomingMessage
}

describe('createControlRateLimiter', () => {
  it('sweeps stale per-address buckets', () => {
    const limiter = createControlRateLimiter({
      capacity: 2,
      refillPerSecond: 1,
      bucketTtlMs: 100,
      sweepIntervalMs: 50
    })

    expect(limiter.allow(requestFrom('127.0.0.2'), 0)).toBe(true)
    expect(limiter.allow(requestFrom('127.0.0.3'), 0)).toBe(true)
    expect(limiter.size()).toBe(2)

    expect(limiter.allow(requestFrom('127.0.0.4'), 151)).toBe(true)
    expect(limiter.size()).toBe(1)
  })

  it('uses terminal ID header before remote address', () => {
    const limiter = createControlRateLimiter({ capacity: 1, refillPerSecond: 0 })

    expect(limiter.allow(requestFrom('127.0.0.1', 'term-a'), 0)).toBe(true)
    expect(limiter.allow(requestFrom('127.0.0.1', 'term-a'), 0)).toBe(false)
    expect(limiter.allow(requestFrom('127.0.0.1', 'term-b'), 0)).toBe(true)
  })
})

describe('validateBrowserNavigationUrl', () => {
  it('accepts http and https URLs', () => {
    expect(validateBrowserNavigationUrl('http://example.com')).toEqual({ url: 'http://example.com/' })
    expect(validateBrowserNavigationUrl('https://example.com/path?q=1')).toEqual({
      url: 'https://example.com/path?q=1'
    })
  })

  it('rejects non-web schemes', () => {
    expect(validateBrowserNavigationUrl('javascript:alert(1)')).toEqual({
      error: 'url must use http or https'
    })
    expect(validateBrowserNavigationUrl('file:///etc/passwd')).toEqual({
      error: 'url must use http or https'
    })
  })

  it('rejects malformed URLs', () => {
    expect(validateBrowserNavigationUrl('not a url')).toEqual({ error: 'url must be absolute' })
  })
})


describe('parseCreateBrowserTabUrl', () => {
  it('accepts http and https URLs for new tabs', () => {
    expect(parseCreateBrowserTabUrl({ url: 'https://example.com' })).toEqual({
      url: 'https://example.com/'
    })
  })

  it('rejects missing or non-web URLs for new tabs', () => {
    expect(parseCreateBrowserTabUrl({})).toEqual({ error: 'url required' })
    expect(parseCreateBrowserTabUrl({ url: 'javascript:alert(1)' })).toEqual({
      error: 'url must use http or https'
    })
    expect(parseCreateBrowserTabUrl({ url: 'file:///etc/passwd' })).toEqual({
      error: 'url must use http or https'
    })
    expect(parseCreateBrowserTabUrl({ url: '/relative' })).toEqual({
      error: 'url must be absolute'
    })
  })
})
