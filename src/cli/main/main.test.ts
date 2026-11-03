import { describe, it, expect } from 'vitest'
import type { connect as connectWs, TatsuClient } from '../client'
import type { ResolvedEndpoint } from '../endpoint'
import { CliError } from '../errors'
import { initialState } from '../../shared/state'
import type { Command, CommandContext } from '../commands'
import { CLI_VERSION, main, type CliIO } from '.'

const NO_FILES: CliIO['files'] = {
  readFile: async (path) => {
    throw Object.assign(new Error(`ENOENT: ${path}`), { code: 'ENOENT' })
  },
  homedir: () => '/nonexistent-home',
  platform: 'linux',
  isPidAlive: () => false
}

async function run(argv: string[], registry: readonly Command[] = []) {
  let stdout = ''
  let stderr = ''
  const code = await main(
    argv,
    { stdout: (t) => (stdout += t), stderr: (t) => (stderr += t), env: {}, files: NO_FILES },
    registry
  )
  return { code, stdout, stderr }
}

function recorder(name: string, body: (ctx: CommandContext) => Promise<void> | void = () => {}) {
  const seen: CommandContext[] = []
  const command: Command = {
    name,
    summary: `${name} summary`,
    usage: `${name} [--force]`,
    options: { force: { type: 'boolean', description: 'Do it anyway' } },
    run: (ctx) => {
      seen.push(ctx)
      return body(ctx)
    }
  }
  return { command, seen }
}

describe('main: root help and version', () => {
  it('prints usage and exits 0 for --help with an empty registry', async () => {
    const r = await run(['--help'])
    expect(r.code).toBe(0)
    expect(r.stdout).toContain('Usage: tatsu')
    expect(r.stdout).toContain('--json')
    expect(r.stderr).toBe('')
  })

  it('lists registered commands in --help', async () => {
    const r = await run(['--help'], [recorder('status').command])
    expect(r.stdout).toMatch(/status\s+status summary/)
  })

  it('prints the version for --version', async () => {
    const r = await run(['--version'])
    expect(r.code).toBe(0)
    expect(r.stdout).toBe(`${CLI_VERSION}\n`)
  })
})

describe('main: usage errors exit 2', () => {
  it('rejects an unknown command with a --help hint', async () => {
    const r = await run(['bogus'])
    expect(r.code).toBe(2)
    expect(r.stdout).toBe('')
    expect(r.stderr).toMatch(/^tatsu: .*bogus.*--help/)
  })

  it('rejects an unknown global option', async () => {
    const r = await run(['--nope'])
    expect(r.code).toBe(2)
    expect(r.stderr).toMatch(/^tatsu: .*--nope/)
  })

  it('rejects an option the command does not declare', async () => {
    const { command, seen } = recorder('status')
    const r = await run(['status', '--nope'], [command])
    expect(r.code).toBe(2)
    expect(seen).toHaveLength(0)
  })

  it('rejects a non-numeric --timeout', async () => {
    const r = await run(['--timeout', 'soon', '--help'])
    expect(r.code).toBe(2)
  })

  it.each([['bogus', '--json'], ['--nope', '--json'], ['--json', 'bogus']])(
    'prints a single JSON usage error on stderr and nothing on stdout for %s %s',
    async (...argv) => {
      const r = await run(argv)
      expect(r.code).toBe(2)
      expect(r.stdout).toBe('')
      expect(r.stderr.trimEnd().split('\n')).toHaveLength(1)
      expect(JSON.parse(r.stderr)).toMatchObject({ error: { code: 'usage' } })
    }
  )
})

describe('main: dispatch', () => {
  it('resolves a space-named subcommand and passes the remaining positionals and flags', async () => {
    const plan = recorder('sync plan')
    const sync = recorder('sync')
    const r = await run(['sync', 'plan', 'target', '--force', '--timeout', '500'], [sync.command, plan.command])
    expect(r.code).toBe(0)
    expect(sync.seen).toHaveLength(0)
    expect(plan.seen[0].positionals).toEqual(['target'])
    expect(plan.seen[0].values.force).toBe(true)
    expect(plan.seen[0].globals.timeoutMs).toBe(500)
  })

  it('prints command help without running it', async () => {
    const { command, seen } = recorder('status')
    const r = await run(['status', '--help'], [command])
    expect(r.code).toBe(0)
    expect(seen).toHaveLength(0)
    expect(r.stdout).toContain('Usage: tatsu status [--force]')
    expect(r.stdout).toContain('Do it anyway')
  })

  it('writes a command result as exactly one JSON document', async () => {
    const { command } = recorder('status', (ctx) => ctx.output.result({ ok: true }, () => 'human'))
    const r = await run(['status', '--json'], [command])
    expect(r.code).toBe(0)
    expect(JSON.parse(r.stdout)).toEqual({ ok: true })
    expect(r.stderr).toBe('')
  })

  it('maps a thrown CliError to its exit code and keeps stdout empty even after a result', async () => {
    const { command } = recorder('status', (ctx) => {
      ctx.output.result({ partial: true }, () => '')
      throw new CliError('unauthorized', 'bad token')
    })
    const r = await run(['status', '--json'], [command])
    expect(r.code).toBe(4)
    expect(r.stdout).toBe('')
    expect(JSON.parse(r.stderr)).toEqual({ error: { code: 'unauthorized', message: 'bad token', details: null } })
  })

  it('maps an unexpected exception to exit 1', async () => {
    const { command } = recorder('status', () => {
      throw new Error('kaboom')
    })
    const r = await run(['status'], [command])
    expect(r.code).toBe(1)
    expect(r.stderr).toBe('tatsu: kaboom\n')
  })

  it('exits 3 with not-running when a command needs the client and no endpoint is configured', async () => {
    const { command } = recorder('status', async (ctx) => {
      await ctx.client()
    })
    const r = await run(['status', '--json'], [command])
    expect(r.code).toBe(3)
    expect(JSON.parse(r.stderr)).toMatchObject({ error: { code: 'not-running' } })
  })
})

describe('main: client lifecycle', () => {
  function fakeConnect() {
    const calls: { endpoint: ResolvedEndpoint; timeoutMs?: number }[] = []
    let closed = 0
    const client: TatsuClient = {
      endpoint: { url: 'ws://127.0.0.1:1', source: 'flag' },
      snapshot: async () => initialState,
      request: async <T,>() => undefined as T,
      close: () => {
        closed++
      }
    }
    const connect: typeof connectWs = async (endpoint, opts) => {
      calls.push({ endpoint, timeoutMs: opts?.timeoutMs })
      return client
    }
    return { connect, calls, closed: () => closed }
  }

  async function runWith(argv: string[], command: Command, connect: typeof connectWs, env = {}) {
    let stdout = ''
    let stderr = ''
    const code = await main(argv, { stdout: (t) => (stdout += t), stderr: (t) => (stderr += t), env, files: NO_FILES, connect }, [command])
    return { code, stdout, stderr }
  }

  it('connects once with the flag endpoint and --timeout, then closes the client', async () => {
    const fake = fakeConnect()
    const { command } = recorder('status', async (ctx) => {
      await ctx.client()
      await ctx.client()
    })
    const r = await runWith(['status', '--url', 'ws://127.0.0.1:9', '--token', 't', '--timeout', '250'], command, fake.connect)
    expect(r.code).toBe(0)
    expect(fake.calls).toEqual([{ endpoint: { url: 'ws://127.0.0.1:9', token: 't', source: 'flag' }, timeoutMs: 250 }])
    expect(fake.closed()).toBe(1)
  })

  it("uses the command's defaultTimeoutMs when --timeout is absent, and --timeout overrides it", async () => {
    const endpointArgs = ['--url', 'ws://127.0.0.1:9', '--token', 't']
    const { command } = recorder('slow', async (ctx) => {
      await ctx.client()
    })
    const slow: Command = { ...command, defaultTimeoutMs: 600_000 }

    const byDefault = fakeConnect()
    await runWith(['slow', ...endpointArgs], slow, byDefault.connect)
    expect(byDefault.calls[0].timeoutMs).toBe(600_000)

    const overridden = fakeConnect()
    await runWith(['slow', ...endpointArgs, '--timeout', '250'], slow, overridden.connect)
    expect(overridden.calls[0].timeoutMs).toBe(250)

    const plain = fakeConnect()
    await runWith(['slow', ...endpointArgs], command, plain.connect)
    expect(plain.calls[0].timeoutMs).toBeUndefined()
  })

  it('reads TATSU_URL and TATSU_TOKEN from the env', async () => {
    const fake = fakeConnect()
    const { command } = recorder('status', async (ctx) => {
      await ctx.client()
    })
    await runWith(['status'], command, fake.connect, { TATSU_URL: 'ws://127.0.0.1:8', TATSU_TOKEN: 'e' })
    expect(fake.calls[0].endpoint.source).toBe('env')
  })

  it('closes the client when the command throws', async () => {
    const fake = fakeConnect()
    const { command } = recorder('status', async (ctx) => {
      await ctx.client()
      throw new CliError('request-failed', 'nope')
    })
    const r = await runWith(['status', '--url', 'ws://127.0.0.1:9', '--token', 't'], command, fake.connect)
    expect(r.code).toBe(1)
    expect(fake.closed()).toBe(1)
  })

  it('exits 2 for --url without --token and never connects', async () => {
    const fake = fakeConnect()
    const { command } = recorder('status', async (ctx) => {
      await ctx.client()
    })
    const r = await runWith(['status', '--url', 'ws://127.0.0.1:9'], command, fake.connect)
    expect(r.code).toBe(2)
    expect(fake.calls).toHaveLength(0)
  })
})
