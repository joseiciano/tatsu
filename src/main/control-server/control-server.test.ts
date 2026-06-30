import { Readable } from 'stream'
import type { IncomingMessage } from 'http'
import { describe, it, expect } from 'vitest'
import { createControlRateLimiter, parseAgentKind, parseCreateBrowserTabUrl, readJson, validateBrowserNavigationUrl, validateControlBranchName } from '.'

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

  it('rejects malformed JSON with statusCode 400', async () => {
    await expect(readJson(requestWithBody('{bad json}'))).rejects.toMatchObject({
      statusCode: 400
    })
  })

  it('rejects completely invalid JSON with statusCode 400', async () => {
    await expect(readJson(requestWithBody('not json at all'))).rejects.toMatchObject({
      statusCode: 400
    })
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

  it('same remote address with different terminal IDs get separate buckets', () => {
    const limiter = createControlRateLimiter({ capacity: 1, refillPerSecond: 0 })

    // Same address + terminal-a consumes its bucket
    expect(limiter.allow(requestFrom('127.0.0.1', 'term-a'), 0)).toBe(true)
    // Same address + terminal-b gets its own bucket (not rate-limited)
    expect(limiter.allow(requestFrom('127.0.0.1', 'term-b'), 0)).toBe(true)
    // Same address + terminal-a is now rate-limited
    expect(limiter.allow(requestFrom('127.0.0.1', 'term-a'), 0)).toBe(false)
    // Same address + no terminal ID gets its own bucket
    expect(limiter.allow(requestFrom('127.0.0.1'), 0)).toBe(true)
  })

  it('same terminal ID shares bucket regardless of terminal ID presence', () => {
    const limiter = createControlRateLimiter({ capacity: 1, refillPerSecond: 0 })

    // Same address + same terminal = same bucket
    expect(limiter.allow(requestFrom('127.0.0.1', 'term-a'), 0)).toBe(true)
    expect(limiter.allow(requestFrom('127.0.0.1', 'term-a'), 0)).toBe(false)
  })

  it('different IPs get separate buckets', () => {
    const limiter = createControlRateLimiter({ capacity: 1, refillPerSecond: 0 })

    expect(limiter.allow(requestFrom('127.0.0.1', 'term-a'), 0)).toBe(true)
    // Different IP — separate bucket regardless of terminal ID
    expect(limiter.allow(requestFrom('127.0.0.2', 'term-a'), 0)).toBe(true)
  })

  it('custom keyFn: same IP with different terminal IDs share one bucket', () => {
    const ipOnlyKeyFn = (req: IncomingMessage) => req.socket.remoteAddress || 'unknown'
    const limiter = createControlRateLimiter({ capacity: 1, refillPerSecond: 0, keyFn: ipOnlyKeyFn })

    // Same IP + terminal-a consumes the single bucket
    expect(limiter.allow(requestFrom('127.0.0.1', 'term-a'), 0)).toBe(true)
    // Same IP + different terminal-b shares the same bucket → rate-limited
    expect(limiter.allow(requestFrom('127.0.0.1', 'term-b'), 0)).toBe(false)
  })

  it('custom keyFn: different IPs still get separate buckets', () => {
    const ipOnlyKeyFn = (req: IncomingMessage) => req.socket.remoteAddress || 'unknown'
    const limiter = createControlRateLimiter({ capacity: 1, refillPerSecond: 0, keyFn: ipOnlyKeyFn })

    expect(limiter.allow(requestFrom('127.0.0.1', 'term-a'), 0)).toBe(true)
    expect(limiter.allow(requestFrom('127.0.0.2', 'term-a'), 0)).toBe(true)
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

describe('validateControlBranchName', () => {
  it('accepts typical branch names', () => {
    expect(validateControlBranchName('feature/foo')).toEqual({ valid: true })
    expect(validateControlBranchName('release_2024.10-rc1')).toEqual({ valid: true })
    expect(validateControlBranchName('fix-bug-123')).toEqual({ valid: true })
    expect(validateControlBranchName('main')).toEqual({ valid: true })
  })

  it('rejects empty names', () => {
    expect(validateControlBranchName('')).toEqual({ valid: false, error: 'branchName must not be empty' })
    expect(validateControlBranchName('  ')).toEqual({ valid: false, error: 'branchName must not be empty' })
  })

  it('rejects names starting with -', () => {
    expect(validateControlBranchName('-x')).toEqual({ valid: false, error: 'branchName must not start with -' })
    expect(validateControlBranchName('--verbose')).toEqual({ valid: false, error: 'branchName must not start with -' })
  })

  it('rejects control characters', () => {
    expect(validateControlBranchName('foo\nbar')).toEqual({ valid: false, error: 'branchName must not contain control characters' })
    expect(validateControlBranchName('foo\x00bar')).toEqual({ valid: false, error: 'branchName must not contain control characters' })
  })

  it('rejects .. (directory traversal)', () => {
    expect(validateControlBranchName('foo..bar')).toEqual({ valid: false, error: 'branchName must not contain ..' })
    expect(validateControlBranchName('../etc')).toEqual({ valid: false, error: 'branchName must not contain ..' })
  })

  it('rejects @{ (reflog metacharacter)', () => {
    expect(validateControlBranchName('foo@{bar')).toEqual({ valid: false, error: 'branchName must not contain @{' })
  })

  it('rejects git ref metacharacters ~^:?*[]\\', () => {
    expect(validateControlBranchName('foo~bar')).toEqual({ valid: false, error: 'branchName contains invalid git ref characters' })
    expect(validateControlBranchName('foo^bar')).toEqual({ valid: false, error: 'branchName contains invalid git ref characters' })
    expect(validateControlBranchName('foo:bar')).toEqual({ valid: false, error: 'branchName contains invalid git ref characters' })
    expect(validateControlBranchName('foo?bar')).toEqual({ valid: false, error: 'branchName contains invalid git ref characters' })
    expect(validateControlBranchName('foo*bar')).toEqual({ valid: false, error: 'branchName contains invalid git ref characters' })
    expect(validateControlBranchName('foo[bar')).toEqual({ valid: false, error: 'branchName contains invalid git ref characters' })
    expect(validateControlBranchName('foo\\bar')).toEqual({ valid: false, error: 'branchName contains invalid git ref characters' })
  })

  it('rejects overly long names', () => {
    expect(validateControlBranchName('a'.repeat(256))).toEqual({ valid: false, error: 'branchName must not exceed 255 characters' })
  })
})
