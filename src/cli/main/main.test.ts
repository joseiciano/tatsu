import { describe, it, expect } from 'vitest'
import { CliError } from '../errors'
import type { Command, CommandContext } from '../commands'
import { CLI_VERSION, main } from '.'

async function run(argv: string[], registry: readonly Command[] = []) {
  let stdout = ''
  let stderr = ''
  const code = await main(
    argv,
    { stdout: (t) => (stdout += t), stderr: (t) => (stderr += t), env: {} },
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

  it('fails with command-failed when a command asks for the client before it exists', async () => {
    const { command } = recorder('status', async (ctx) => {
      await ctx.client()
    })
    const r = await run(['status', '--json'], [command])
    expect(r.code).toBe(1)
    expect(JSON.parse(r.stderr)).toMatchObject({ error: { code: 'command-failed' } })
  })
})
