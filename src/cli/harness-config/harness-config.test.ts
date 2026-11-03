import { describe, it, expect } from 'vitest'
import type { HarnessConfigRequestErrorCode } from '../../shared/state/harness-config'
import type { TatsuClient } from '../client'
import { CliError } from '../errors'
import { enumerateScopes, hcRequest, scopeFiltersFrom, scopeLabel } from '.'

function fakeClient(reply: unknown): { client: TatsuClient; requests: { name: string; args: unknown[] }[] } {
  const requests: { name: string; args: unknown[] }[] = []
  const client: TatsuClient = {
    endpoint: { url: 'ws://127.0.0.1:1', source: 'flag' },
    snapshot: async () => {
      throw new Error('unused')
    },
    request: async <T,>(name: string, ...args: unknown[]) => {
      requests.push({ name, args })
      return reply as T
    },
    close: () => {}
  }
  return { client, requests }
}

async function rejection(promise: Promise<unknown>): Promise<CliError> {
  const err = await promise.then(
    () => undefined,
    (e: unknown) => e
  )
  if (!(err instanceof CliError)) throw new Error(`expected a CliError, got ${String(err)}`)
  return err
}

function failing(code: HarnessConfigRequestErrorCode, extra: Record<string, unknown> = {}): unknown {
  return { ok: false, error: { code, message: `boom ${code}`, ...extra } }
}

const SCOPE = { agentKind: 'claude', resourceType: 'skills' } as const

describe('hcRequest', () => {
  it('sends the payload as the single argument and returns the unwrapped value', async () => {
    const { client, requests } = fakeClient({ ok: true, value: { resources: [], scannedAt: 1 } })
    await expect(hcRequest(client, 'harnessConfig:scan', { scope: SCOPE })).resolves.toEqual({ resources: [], scannedAt: 1 })
    expect(requests).toEqual([{ name: 'harnessConfig:scan', args: [{ scope: SCOPE }] }])
  })

  it.each(['invalid-request', 'unsupported-scope', 'invalid-name'] as const)('maps %s to usage', async (code) => {
    const err = await rejection(hcRequest(fakeClient(failing(code)).client, 'harnessConfig:scan', {}))
    expect(err.code).toBe('usage')
    expect(err.message).toBe(`boom ${code}`)
    expect(err.details).toEqual({ code })
  })

  it.each(['unknown-plan', 'stale-plan', 'unconfirmed-plan'] as const)('maps %s to command-failed with the re-plan hint', async (code) => {
    const err = await rejection(hcRequest(fakeClient(failing(code)).client, 'harnessConfig:syncToDisk', {}))
    expect(err.code).toBe('command-failed')
    expect(err.message).toContain(`boom ${code}`)
    expect(err.message).toContain("re-run 'tatsu sync plan'")
    expect(err.details).toEqual({ code })
  })

  it('maps unknown-resource to usage only when --detach was passed', async () => {
    const withDetach = await rejection(hcRequest(fakeClient(failing('unknown-resource')).client, 'c', {}, { detach: true }))
    expect(withDetach.code).toBe('usage')
    const without = await rejection(hcRequest(fakeClient(failing('unknown-resource')).client, 'c', {}))
    expect(without.code).toBe('command-failed')
  })

  it.each(['write-failed', 'internal-error', 'collision'] as const)('maps %s to command-failed', async (code) => {
    const err = await rejection(hcRequest(fakeClient(failing(code)).client, 'c', {}))
    expect(err.code).toBe('command-failed')
    expect(err.message).toBe(`boom ${code}`)
  })

  it('maps a code it does not know to command-failed', async () => {
    const err = await rejection(hcRequest(fakeClient({ ok: false, error: { code: 'brand-new', message: 'x' } }).client, 'c', {}))
    expect(err.code).toBe('command-failed')
    expect(err.details).toEqual({ code: 'brand-new' })
  })

  it('passes the applied operations through in details', async () => {
    const applied = [{ type: 'create', relativePath: 'a/SKILL.md' }]
    const err = await rejection(hcRequest(fakeClient(failing('write-failed', { applied })).client, 'c', {}))
    expect(err.details).toEqual({ code: 'write-failed', applied })
  })

  it.each([null, 'nope', { ok: true }, { ok: false }, { ok: false, error: { code: 1, message: 'x' } }])(
    'rejects a malformed envelope %j as request-failed',
    async (reply) => {
      const err = await rejection(hcRequest(fakeClient(reply).client, 'harnessConfig:scan', {}))
      expect(err.code).toBe('request-failed')
      expect(err.message).toContain('harnessConfig:scan')
    }
  )
})

describe('enumerateScopes', () => {
  const key = (s: { agentKind: string; resourceType: string }) => `${s.agentKind}:${s.resourceType}`

  it('lists every supported scope in registry order without filters', () => {
    expect(enumerateScopes({}).map(key)).toEqual([
      'claude:agents',
      'claude:skills',
      'claude:commands',
      'codex:agents',
      'codex:skills',
      'opencode:agents',
      'opencode:skills',
      'opencode:commands'
    ])
  })

  it('returns plain {agentKind, resourceType} objects for the wire', () => {
    expect(enumerateScopes({ agent: 'claude', type: 'skills' })).toEqual([{ agentKind: 'claude', resourceType: 'skills' }])
  })

  it('narrows to one agent', () => {
    expect(enumerateScopes({ agent: 'codex' }).map(key)).toEqual(['codex:agents', 'codex:skills'])
  })

  it('narrows to one type and skips harnesses that do not support it', () => {
    expect(enumerateScopes({ type: 'commands' }).map(key)).toEqual(['claude:commands', 'opencode:commands'])
  })

  it('rejects an explicitly named unsupported scope', () => {
    expect(() => enumerateScopes({ agent: 'codex', type: 'commands' })).toThrow(
      expect.objectContaining({ code: 'usage', message: expect.stringContaining('Codex does not support commands') })
    )
  })

  it('rejects a filter that leaves no scopes', () => {
    expect(() => enumerateScopes({ agent: 'pi' })).toThrow(
      expect.objectContaining({ code: 'usage', message: expect.stringContaining('Pi has no supported config scopes') })
    )
  })

  it('rejects an unknown agent', () => {
    expect(() => enumerateScopes({ agent: 'nope' })).toThrow(
      expect.objectContaining({ code: 'usage', message: expect.stringContaining("--agent must be one of claude, codex, opencode, pi (got 'nope')") })
    )
  })

  it('rejects an unknown type', () => {
    expect(() => enumerateScopes({ type: 'hooks' })).toThrow(
      expect.objectContaining({ code: 'usage', message: expect.stringContaining("--type must be one of agents, skills, commands (got 'hooks')") })
    )
  })
})

describe('scopeFiltersFrom', () => {
  it('reads string --agent and --type values', () => {
    expect(scopeFiltersFrom({ agent: 'claude', type: 'skills', json: true })).toEqual({ agent: 'claude', type: 'skills' })
    expect(scopeFiltersFrom({})).toEqual({})
  })
})

describe('scopeLabel', () => {
  it('names the harness by its display name and the resource type', () => {
    expect(scopeLabel({ agentKind: 'opencode', resourceType: 'commands' })).toBe('Opencode · commands')
  })
})
