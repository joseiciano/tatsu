import { describe, it, expect, vi, beforeEach } from 'vitest'
import { execFileSync } from 'child_process'

const fsState: {
  files: Map<string, string>
  dirs: Map<string, { name: string; isDirectory: () => boolean }[]>
} = { files: new Map(), dirs: new Map() }

vi.mock('fs', () => ({
  existsSync: (p: string) => fsState.files.has(p),
  readFileSync: (p: string) => {
    if (!fsState.files.has(p)) throw new Error(`ENOENT: ${p}`)
    return fsState.files.get(p) as string
  },
  writeFileSync: (p: string, data: string) => {
    fsState.files.set(p, data)
  },
  appendFileSync: (p: string, data: string) => {
    fsState.files.set(p, (fsState.files.get(p) ?? '') + data)
  },
  unlinkSync: (p: string) => {
    fsState.files.delete(p)
  },
  mkdirSync: () => {},
  readdirSync: (p: string) => fsState.dirs.get(p) ?? [],
  statSync: () => ({ mtimeMs: 0 })
}))

vi.mock('../debug', () => ({
  log: () => {}
}))

vi.mock('../hooks', () => ({
  makeHookScript: () => '#!/bin/bash\nprintf "$1" >> /tmp/harness-status/x.ndjson\n'
}))

import { homedir } from 'os'
import { join } from 'path'
import {
  hooksInstalled,
  installHooks,
  hookEvents,
  uninstallHooks,
  makeCodexHookCommand,
  buildSpawnArgs,
  tomlValue
} from './codex'
import type { HarnessMcpServerSpec } from './index'

const HOOKS_PATH = join(homedir(), '.codex', 'hooks.json')
const SCRIPT_PATH = join(homedir(), '.codex', 'harness-hook.sh')

beforeEach(() => {
  fsState.files.clear()
  fsState.dirs.clear()
})

describe('codex hook install / dedup', () => {
  it('hooksInstalled() recognizes normalized entries with no _marker field', () => {
    const data = {
      hooks: {
        SessionStart: [
          {
            hooks: [
              {
                type: 'command',
                command:
                  "bash -c 'd=/tmp/harness-status; printf hi >> \"$d/$h.ndjson\"'",
                timeout: 5
              }
            ]
          }
        ]
      }
    }
    fsState.files.set(HOOKS_PATH, JSON.stringify(data))
    expect(hooksInstalled()).toBe(true)
  })

  it('hooksInstalled() returns false when only user-authored hooks exist', () => {
    fsState.files.set(
      HOOKS_PATH,
      JSON.stringify({
        hooks: {
          SessionStart: [
            { hooks: [{ type: 'command', command: 'echo user hook', timeout: 5 }] }
          ]
        }
      })
    )
    expect(hooksInstalled()).toBe(false)
  })

  it('installHooks() called twice yields exactly one harness entry per event', () => {
    installHooks()
    installHooks()
    const data = JSON.parse(fsState.files.get(HOOKS_PATH) as string)
    for (const event of hookEvents) {
      const entries = data.hooks[event]
      expect(entries).toHaveLength(1)
      expect(entries[0].hooks[0].command).toBe(makeCodexHookCommand(event))
    }
  })

  it('installHooks() collapses pre-existing duplicates left by buggy passes', () => {
    const dupEntry = {
      hooks: [
        {
          type: 'command',
          command:
            "bash -c 'd=/tmp/harness-status; printf hi >> \"$d/$h.ndjson\"'",
          timeout: 5
        }
      ]
    }
    const data: { hooks: Record<string, unknown[]> } = { hooks: {} }
    for (const event of hookEvents) {
      data.hooks[event] = [dupEntry, dupEntry, dupEntry]
    }
    fsState.files.set(HOOKS_PATH, JSON.stringify(data))

    installHooks()

    const after = JSON.parse(fsState.files.get(HOOKS_PATH) as string)
    for (const event of hookEvents) {
      expect(after.hooks[event]).toHaveLength(1)
    }
  })

  it('installHooks() preserves user-authored hooks', () => {
    const userHook = {
      hooks: [{ type: 'command', command: 'echo user hook', timeout: 10 }]
    }
    fsState.files.set(
      HOOKS_PATH,
      JSON.stringify({
        hooks: { SessionStart: [userHook], PreToolUse: [userHook] }
      })
    )

    installHooks()

    const after = JSON.parse(fsState.files.get(HOOKS_PATH) as string)
    expect(after.hooks.SessionStart).toContainEqual(userHook)
    expect(after.hooks.PreToolUse).toContainEqual(userHook)
    for (const event of hookEvents) {
      const harnessEntries = (after.hooks[event] as Array<{ hooks: { command: string }[] }>).filter(
        (e) => e.hooks.some((h) => h.command.includes('harness-hook.sh'))
      )
      expect(harnessEntries).toHaveLength(1)
    }
  })

  it('uninstallHooks() removes harness entries but preserves user-authored hooks', () => {
    installHooks()
    const after = JSON.parse(fsState.files.get(HOOKS_PATH) as string)
    after.hooks.SessionStart.push({
      hooks: [{ type: 'command', command: 'echo user hook' }]
    })
    fsState.files.set(HOOKS_PATH, JSON.stringify(after))

    uninstallHooks()

    const final = JSON.parse(fsState.files.get(HOOKS_PATH) as string)
    expect(final.hooks?.SessionStart).toEqual([
      { hooks: [{ type: 'command', command: 'echo user hook' }] }
    ])
    expect(final.hooks?.PreToolUse).toBeUndefined()
  })
})

describe('codex hook script', () => {
  it('installHooks() writes the script and points every entry at it', () => {
    installHooks()
    expect(fsState.files.get(SCRIPT_PATH)).toContain('#!/bin/bash')
    const data = JSON.parse(fsState.files.get(HOOKS_PATH) as string)
    for (const event of hookEvents) {
      expect(data.hooks[event][0].hooks[0].command).toBe(
        `bash '${SCRIPT_PATH}' ${event}`
      )
    }
  })

  it('installHooks() replaces legacy inline bash -c entries', () => {
    fsState.files.set(
      HOOKS_PATH,
      JSON.stringify({
        hooks: {
          Stop: [
            {
              hooks: [
                {
                  type: 'command',
                  command: "bash -c 'd=/tmp/harness-status; printf Stop >> \"$d/$h.ndjson\"'"
                }
              ]
            }
          ]
        }
      })
    )
    installHooks()
    const data = JSON.parse(fsState.files.get(HOOKS_PATH) as string)
    expect(data.hooks.Stop).toHaveLength(1)
    expect(data.hooks.Stop[0].hooks[0].command).toBe(makeCodexHookCommand('Stop'))
  })

  it('hook commands are stable across installs so Codex trust survives', () => {
    installHooks()
    const first = fsState.files.get(HOOKS_PATH)
    installHooks()
    expect(fsState.files.get(HOOKS_PATH)).toBe(first)
  })

  it('uninstallHooks() removes the script', () => {
    installHooks()
    uninstallHooks()
    expect(fsState.files.has(SCRIPT_PATH)).toBe(false)
    expect(hooksInstalled()).toBe(false)
  })
})

describe('codex_hooks feature flag', () => {
  const CONFIG_PATH = join(homedir(), '.codex', 'config.toml')

  it('inserts the flag under an existing [features] table, not at EOF', () => {
    fsState.files.set(
      CONFIG_PATH,
      'model = "o3"\n\n[features]\nweb_search = true\n\n[mcp_servers.foo]\ncommand = "foo"\n'
    )
    installHooks()
    expect(fsState.files.get(CONFIG_PATH)).toBe(
      'model = "o3"\n\n[features]\ncodex_hooks = true\nweb_search = true\n\n[mcp_servers.foo]\ncommand = "foo"\n'
    )
  })

  it('appends a [features] table when none exists', () => {
    fsState.files.set(CONFIG_PATH, 'model = "o3"')
    installHooks()
    expect(fsState.files.get(CONFIG_PATH)).toBe(
      'model = "o3"\n\n[features]\ncodex_hooks = true\n'
    )
  })

  it('leaves the file alone when the flag is already set', () => {
    const content = '[features]\ncodex_hooks = false\n'
    fsState.files.set(CONFIG_PATH, content)
    installHooks()
    expect(fsState.files.get(CONFIG_PATH)).toBe(content)
  })
})

describe('tomlValue (TEST-005)', () => {
  it.each([
    { name: 'escapes quotes and backslashes', input: 'a"b\\c', expected: '"a\\"b\\\\c"' },
    { name: 'escapes U+007F, which TOML forbids raw', input: 'a\u007fb', expected: '"a\\u007fb"' },
    { name: 'escapes newlines', input: 'a\nb', expected: '"a\\nb"' },
    { name: 'array of strings', input: ['x', 'y'], expected: '["x","y"]' },
    { name: 'array items are escaped', input: ['a"b', 'c\u007f'], expected: '["a\\"b","c\\u007f"]' },
    { name: 'empty array', input: [], expected: '[]' },
    {
      name: 'table with a bare and a quoted key',
      input: { ELECTRON_RUN_AS_NODE: '1', 'a.b': 'c' },
      expected: '{ELECTRON_RUN_AS_NODE="1","a.b"="c"}'
    },
    { name: 'table keys with - stay bare', input: { 'a-b_9': 'v' }, expected: '{a-b_9="v"}' },
    { name: 'empty table', input: {}, expected: '{}' }
  ])('$name', ({ input, expected }) => {
    expect(tomlValue(input as string | string[] | Record<string, string>)).toBe(expected)
  })
})

describe('codex buildSpawnArgs MCP overrides', () => {
  const SPEC: HarnessMcpServerSpec = {
    command: '/bin/el',
    args: ['/r/b.js', '--config', '/c.json'],
    env: { ELECTRON_RUN_AS_NODE: '1' }
  }
  const OVERRIDES =
    ` -c 'mcp_servers.harness-control.command="/bin/el"'` +
    ` -c 'mcp_servers.harness-control.args=["/r/b.js","--config","/c.json"]'` +
    ` -c 'mcp_servers.harness-control.env={ELECTRON_RUN_AS_NODE="1"}'`
  const SESSIONS_DIR = join(homedir(), '.codex', 'sessions')
  const SESSION_ID = '0199a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b'

  const seedTokenFile = () => {
    fsState.files.set(
      '/c.json',
      JSON.stringify({ env: { HARNESS_PORT: '4567', HARNESS_TOKEN: 'tok-sentinel', HARNESS_TERMINAL_ID: 't1' } })
    )
  }

  const seedSession = (id: string) => {
    fsState.dirs.set(SESSIONS_DIR, [{ name: '2026', isDirectory: () => true }])
    fsState.dirs.set(join(SESSIONS_DIR, '2026'), [
      { name: `rollout-2026-10-24T10-00-00-${id}.jsonl`, isDirectory: () => false }
    ])
  }

  const shellArgv = (line: string): string[] => {
    const out = execFileSync('sh', ['-c', `set -- ${line}; printf '%s\\0' "$@"`], { encoding: 'utf-8' })
    return out.split('\0').slice(0, -1)
  }

  beforeEach(seedTokenFile)

  describe('TEST-006: fresh spawn', () => {
    it.each([
      { name: 'no model, no prompt', model: null, prompt: undefined, tail: '' },
      { name: 'model only', model: 'gpt-5', prompt: undefined, tail: " --model 'gpt-5'" },
      { name: 'prompt only', model: null, prompt: 'fix it', tail: " 'fix it'" },
      { name: 'model and prompt', model: 'gpt-5', prompt: "don't stop", tail: " --model 'gpt-5' 'don'\\''t stop'" }
    ])('$name: overrides come right after the command, before --model and the prompt', ({ model, prompt, tail }) => {
      const out = buildSpawnArgs({ command: 'codex', cwd: '/wt', model, initialPrompt: prompt, mcpServer: SPEC })
      expect(out).toBe(`codex${OVERRIDES}${tail}`)
    })

    it("shell-escapes a ' in a server path", () => {
      const out = buildSpawnArgs({
        command: 'codex',
        cwd: '/wt',
        mcpServer: { ...SPEC, command: "/Apps/Bob's/el" }
      })
      expect(out).toContain(` -c 'mcp_servers.harness-control.command="/Apps/Bob'\\''s/el"'`)
      expect(shellArgv(out)).toContain(`mcp_servers.harness-control.command="/Apps/Bob's/el"`)
    })

    it('splits into the exact argv Codex receives, carrying only the config path and no token', () => {
      const out = buildSpawnArgs({
        command: 'codex',
        cwd: '/wt',
        model: 'gpt-5',
        initialPrompt: 'go',
        mcpServer: SPEC
      })
      const argv = shellArgv(out)

      expect(argv).toEqual([
        'codex',
        '-c',
        'mcp_servers.harness-control.command="/bin/el"',
        '-c',
        'mcp_servers.harness-control.args=["/r/b.js","--config","/c.json"]',
        '-c',
        'mcp_servers.harness-control.env={ELECTRON_RUN_AS_NODE="1"}',
        '--model',
        'gpt-5',
        'go'
      ])
      expect(argv.filter((a) => a.includes('/c.json'))).toEqual([
        'mcp_servers.harness-control.args=["/r/b.js","--config","/c.json"]'
      ])
      for (const a of argv) {
        expect(a).not.toContain('HARNESS_TOKEN')
        expect(a).not.toContain('HARNESS_PORT')
        expect(a).not.toContain('tok-sentinel')
      }
    })
  })

  describe('TEST-007: resume', () => {
    it('puts the overrides before resume <id>', () => {
      seedSession(SESSION_ID)
      const out = buildSpawnArgs({ command: 'codex', cwd: '/wt', sessionId: SESSION_ID, mcpServer: SPEC })
      expect(out).toBe(`codex${OVERRIDES} resume ${SESSION_ID}`)
    })

    it('puts the overrides before --model and resume <id>', () => {
      seedSession(SESSION_ID)
      const out = buildSpawnArgs({
        command: 'codex',
        cwd: '/wt',
        sessionId: SESSION_ID,
        model: 'gpt-5',
        initialPrompt: 'ignored on resume',
        mcpServer: SPEC
      })
      expect(out).toBe(`codex${OVERRIDES} --model 'gpt-5' resume ${SESSION_ID}`)
    })

    it('keeps the overrides when the session file is gone and it falls back to a fresh start', () => {
      seedSession('some-other-session')
      const out = buildSpawnArgs({
        command: 'codex',
        cwd: '/wt',
        sessionId: SESSION_ID,
        initialPrompt: 'go',
        mcpServer: SPEC
      })
      expect(out).toBe(`codex${OVERRIDES} 'go'`)
    })
  })

  describe('TEST-008: no MCP server', () => {
    it.each([
      { name: 'bare command', opts: {}, expected: 'codex' },
      { name: 'model', opts: { model: 'm' }, expected: "codex --model 'm'" },
      { name: 'prompt', opts: { initialPrompt: 'prompt' }, expected: "codex 'prompt'" },
      { name: 'model and prompt', opts: { model: 'm', initialPrompt: 'prompt' }, expected: "codex --model 'm' 'prompt'" },
      { name: 'resume', opts: { sessionId: SESSION_ID }, expected: `codex resume ${SESSION_ID}` },
      { name: 'model and resume', opts: { model: 'm', sessionId: SESSION_ID }, expected: `codex --model 'm' resume ${SESSION_ID}` },
      {
        name: 'command already has a model flag',
        opts: { command: 'codex -m o3', model: 'm' },
        expected: 'codex -m o3'
      }
    ])('$name: output is unchanged', ({ opts, expected }) => {
      seedSession(SESSION_ID)
      const out = buildSpawnArgs({ command: 'codex', cwd: '/wt', mcpServer: null, ...opts })
      expect(out).toBe(expected)
      expect(out).not.toContain('harness-control')
    })

    it('adds no overrides when the user command already configures harness-control', () => {
      const command = `codex -c 'mcp_servers.harness-control.command="mine"'`
      const out = buildSpawnArgs({ command, cwd: '/wt', model: 'm', mcpServer: SPEC })
      expect(out).toBe(`${command} --model 'm'`)
    })
  })
})
