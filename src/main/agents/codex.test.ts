import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { execFileSync } from 'child_process'

const fsState: {
  files: Map<string, string>
  dirs: Map<string, { name: string; isDirectory: () => boolean }[]>
  writes: string[]
  readdirs: string[]
} = { files: new Map(), dirs: new Map(), writes: [], readdirs: [] }

vi.mock('fs', () => ({
  existsSync: (p: string) => fsState.files.has(p),
  readFileSync: (p: string) => {
    if (!fsState.files.has(p)) throw new Error(`ENOENT: ${p}`)
    return fsState.files.get(p) as string
  },
  writeFileSync: (p: string, data: string) => {
    fsState.writes.push(p)
    fsState.files.set(p, data)
  },
  appendFileSync: (p: string, data: string) => {
    fsState.files.set(p, (fsState.files.get(p) ?? '') + data)
  },
  unlinkSync: (p: string) => {
    fsState.files.delete(p)
  },
  mkdirSync: () => {},
  readdirSync: (p: string) => {
    fsState.readdirs.push(p)
    return fsState.dirs.get(p) ?? []
  },
  realpathSync: (p: string) => p,
  statSync: () => ({ mtimeMs: 0 })
}))

vi.mock('../debug', () => ({
  log: vi.fn()
}))

vi.mock('../hooks', () => ({
  makeHookScript: () => '#!/bin/bash\nprintf "$1" >> /tmp/harness-status/x.ndjson\n'
}))

import { homedir } from 'os'
import { join } from 'path'
import { log } from '../debug'
import {
  hooksInstalled,
  installHooks,
  hookEvents,
  uninstallHooks,
  makeCodexHookCommand,
  buildSpawnArgs,
  codexPermissionFlags,
  tomlValue,
  codexHomeDir,
  sessionFileExists,
  latestSessionId
} from './codex'
import type { HarnessMcpServerSpec } from './index'

const HOOKS_PATH = join(homedir(), '.codex', 'hooks.json')
const SCRIPT_PATH = join(homedir(), '.codex', 'harness-hook.sh')

beforeEach(() => {
  fsState.files.clear()
  fsState.dirs.clear()
  fsState.writes.length = 0
  fsState.readdirs.length = 0
  vi.stubEnv('CODEX_HOME', '')
})

afterEach(() => {
  vi.unstubAllEnvs()
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

describe('installHooks positions (TEST-001)', () => {
  type Entry = { matcher?: string; hooks: Record<string, unknown>[] }
  const U: Entry = { hooks: [{ type: 'command', command: 'echo user', timeout: 10 }] }
  const desired = (event: string): Entry => ({
    hooks: [{ type: 'command', command: makeCodexHookCommand(event), timeout: 5 }]
  })
  const fullInstall = (): Record<string, Entry[]> =>
    Object.fromEntries(hookEvents.map((e) => [e, [desired(e)]]))
  const seed = (hooks: Record<string, Entry[]>) => {
    fsState.files.set(HOOKS_PATH, JSON.stringify({ hooks }))
  }
  const readHooks = (): Record<string, Entry[]> =>
    JSON.parse(fsState.files.get(HOOKS_PATH) as string).hooks

  it('(a) a user hook pushed after Tatsu stays behind it and the next install does not rewrite hooks.json', () => {
    installHooks()
    const data = JSON.parse(fsState.files.get(HOOKS_PATH) as string)
    data.hooks.Stop.push(U)
    fsState.files.set(HOOKS_PATH, JSON.stringify(data, null, 2))
    fsState.writes.length = 0

    installHooks()

    const stop = readHooks().Stop
    expect(stop[0]).toEqual(desired('Stop'))
    expect(stop[1]).toEqual(U)
    expect(fsState.writes).not.toContain(HOOKS_PATH)
  })

  it('(b) a third-party hook ahead of Tatsu leaves the file byte-identical and unwritten', () => {
    const hooks = fullInstall()
    hooks.Stop = [U, desired('Stop')]
    seed(hooks)
    const before = fsState.files.get(HOOKS_PATH)

    installHooks()

    expect(fsState.files.get(HOOKS_PATH)).toBe(before)
    expect(fsState.writes).not.toContain(HOOKS_PATH)
  })

  it('(c) a stale Tatsu entry is replaced in place, keeping the user hook at its index', () => {
    seed({
      Stop: [
        { hooks: [{ type: 'command', command: makeCodexHookCommand('Stop'), timeout: 10 }] },
        U
      ]
    })

    installHooks()

    expect(readHooks().Stop).toEqual([desired('Stop'), U])
  })

  it('(d) a legacy inline bash -c entry is replaced in place', () => {
    seed({
      Stop: [
        {
          hooks: [
            {
              type: 'command',
              command: "bash -c 'd=/tmp/harness-status; printf Stop >> \"$d/$h.ndjson\"'"
            }
          ]
        },
        U
      ]
    })

    installHooks()

    expect(readHooks().Stop).toEqual([desired('Stop'), U])
  })

  it('(e) duplicates collapse to the first Tatsu entry, user hook keeps its relative order', () => {
    seed({ ...fullInstall(), Stop: [desired('Stop'), U, desired('Stop')] })

    installHooks()

    expect(readHooks().Stop).toEqual([desired('Stop'), U])
  })

  it('(f) an entry differing only by async: false counts as identical and is not rewritten', () => {
    const hooks = fullInstall()
    hooks.Stop = [
      { hooks: [{ type: 'command', command: makeCodexHookCommand('Stop'), timeout: 5, async: false }] }
    ]
    seed(hooks)
    const before = fsState.files.get(HOOKS_PATH)

    installHooks()

    expect(fsState.files.get(HOOKS_PATH)).toBe(before)
    expect(fsState.writes).not.toContain(HOOKS_PATH)
  })

  it.each([
    {
      name: 'statusMessage on Stop',
      event: 'Stop',
      entry: (): Entry => ({
        hooks: [
          { type: 'command', command: makeCodexHookCommand('Stop'), timeout: 5, statusMessage: 'x' }
        ]
      })
    },
    {
      name: "matcher '*' on PreToolUse",
      event: 'PreToolUse',
      entry: (): Entry => ({ matcher: '*', ...desired('PreToolUse') })
    }
  ])('(g) $name is replaced in place', ({ event, entry }) => {
    seed({ ...fullInstall(), [event]: [entry(), U] })

    installHooks()

    expect(readHooks()[event]).toEqual([desired(event), U])
  })

  it('(h) an unparseable hooks.json is not overwritten, and the script is still written', () => {
    fsState.files.set(HOOKS_PATH, '{not json')

    expect(() => installHooks()).not.toThrow()

    expect(fsState.files.get(HOOKS_PATH)).toBe('{not json')
    expect(fsState.writes).not.toContain(HOOKS_PATH)
    expect(fsState.files.get(SCRIPT_PATH)).toContain('#!/bin/bash')
  })

  it('(j) an up-to-date install writes neither hooks.json nor the script', () => {
    installHooks()
    fsState.writes.length = 0

    installHooks()

    expect(fsState.writes).not.toContain(HOOKS_PATH)
    expect(fsState.writes).not.toContain(SCRIPT_PATH)
  })
})

describe('codex hooks feature flag (TEST-002)', () => {
  const CONFIG_PATH = join(homedir(), '.codex', 'config.toml')

  it('(a) inserts hooks = true directly under an existing [features] table', () => {
    fsState.files.set(
      CONFIG_PATH,
      'model = "o3"\n\n[features]\nweb_search = true\n\n[mcp_servers.foo]\ncommand = "foo"\n'
    )
    installHooks()
    expect(fsState.files.get(CONFIG_PATH)).toBe(
      'model = "o3"\n\n[features]\nhooks = true\nweb_search = true\n\n[mcp_servers.foo]\ncommand = "foo"\n'
    )
  })

  it('(b) appends a [features] table when none exists', () => {
    fsState.files.set(CONFIG_PATH, 'model = "o3"')
    installHooks()
    expect(fsState.files.get(CONFIG_PATH)).toBe('model = "o3"\n\n[features]\nhooks = true\n')
  })

  it.each([
    { name: '(c) legacy codex_hooks = false', content: '[features]\ncodex_hooks = false\n' },
    { name: '(d) hooks = false', content: '[features]\nhooks = false\n' },
    { name: '(e) dotted features.hooks at top level', content: 'model = "o3"\nfeatures.hooks = true\n' },
    { name: '(g) unparseable TOML', content: '[features' }
  ])('$name: leaves config.toml alone', ({ content }) => {
    fsState.files.set(CONFIG_PATH, content)

    expect(() => installHooks()).not.toThrow()

    expect(fsState.files.get(CONFIG_PATH)).toBe(content)
    expect(fsState.writes).not.toContain(CONFIG_PATH)
  })

  it('(f) a hooks.state table and a codex_hooks comment do not count as the flag', () => {
    const content =
      '# codex_hooks\n[hooks.state."/h/.codex/hooks.json:stop:0:0"]\ntrusted_hash = "sha256:x"\n'
    fsState.files.set(CONFIG_PATH, content)

    installHooks()

    expect(fsState.files.get(CONFIG_PATH)).toBe(content + '\n[features]\nhooks = true\n')
  })

  it('(h) a missing config.toml is created with the flag', () => {
    installHooks()
    expect(fsState.files.get(CONFIG_PATH)).toBe('\n[features]\nhooks = true\n')
  })
})

describe('CODEX_HOME (TEST-014)', () => {
  const H = '/codex-home'
  const HOME_CODEX = join(homedir(), '.codex')

  it('(a) codexHomeDir() falls back to ~/.codex when CODEX_HOME is empty and follows it when set', () => {
    expect(codexHomeDir()).toBe(HOME_CODEX)
    vi.stubEnv('CODEX_HOME', H)
    expect(codexHomeDir()).toBe(H)
  })

  it('(b) installHooks() writes hooks.json and the script under CODEX_HOME and nothing under ~/.codex', () => {
    vi.stubEnv('CODEX_HOME', H)

    installHooks()

    expect(fsState.files.get(join(H, 'harness-hook.sh'))).toContain('#!/bin/bash')
    const data = JSON.parse(fsState.files.get(join(H, 'hooks.json')) as string)
    for (const event of hookEvents) {
      expect(data.hooks[event][0].hooks[0].command).toBe(`bash '${H}/harness-hook.sh' ${event}`)
    }
    expect(fsState.writes.filter((p) => p.startsWith(HOME_CODEX))).toEqual([])
  })

  it('(c) the feature flag goes to CODEX_HOME/config.toml', () => {
    vi.stubEnv('CODEX_HOME', H)

    installHooks()

    expect(fsState.files.get(join(H, 'config.toml'))).toBe('\n[features]\nhooks = true\n')
    expect(fsState.files.has(join(HOME_CODEX, 'config.toml'))).toBe(false)
  })

  it('(d) sessionFileExists and latestSessionId read CODEX_HOME/sessions', () => {
    vi.stubEnv('CODEX_HOME', H)
    const id = '0199a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b'
    const sessions = join(H, 'sessions')
    fsState.dirs.set(sessions, [{ name: '2026', isDirectory: () => true }])
    fsState.dirs.set(join(sessions, '2026'), [
      { name: `rollout-2026-10-24T10-00-00-${id}.jsonl`, isDirectory: () => false }
    ])

    expect(sessionFileExists('/wt', id)).toBe(true)
    expect(latestSessionId('/wt')).toBe(id)
    expect(fsState.readdirs).toContain(sessions)
    expect(fsState.readdirs).not.toContain(join(HOME_CODEX, 'sessions'))
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

  describe('TEST-005: permission level', () => {
    const APPROVE = ` -c 'mcp_servers.harness-control.default_tools_approval_mode="approve"'`
    const EDIT_FLAGS = ' --sandbox workspace-write --ask-for-approval never'
    const GUARD_LOG = 'already sets sandbox/approval'

    beforeEach(() => {
      vi.mocked(log).mockClear()
    })

    const guardLogged = () =>
      vi.mocked(log).mock.calls.some((c) => c.join(' ').includes(GUARD_LOG))

    it('fresh spawn: MCP overrides, then the approve override, then sandbox/approval, then --model and the prompt', () => {
      const out = buildSpawnArgs({
        command: 'codex',
        cwd: '/wt',
        model: 'm',
        initialPrompt: 'p',
        mcpServer: SPEC,
        permissionLevel: 'edit'
      })
      expect(out).toBe(`codex${OVERRIDES}${APPROVE}${EDIT_FLAGS} --model 'm' 'p'`)
      expect(guardLogged()).toBe(false)
    })

    it('the approve override reaches Codex as a single -c value', () => {
      const out = buildSpawnArgs({ command: 'codex', cwd: '/wt', mcpServer: SPEC, permissionLevel: 'read-only' })
      expect(shellArgv(out).slice(-6)).toEqual([
        '-c',
        'mcp_servers.harness-control.default_tools_approval_mode="approve"',
        '--sandbox',
        'read-only',
        '--ask-for-approval',
        'never'
      ])
    })

    it('resume: the permission flags sit before resume <id>', () => {
      seedSession(SESSION_ID)
      const out = buildSpawnArgs({
        command: 'codex',
        cwd: '/wt',
        sessionId: SESSION_ID,
        mcpServer: SPEC,
        permissionLevel: 'edit'
      })
      expect(out).toBe(`codex${OVERRIDES}${APPROVE}${EDIT_FLAGS} resume ${SESSION_ID}`)
    })

    it('without an MCP server there is no default_tools_approval_mode override', () => {
      const out = buildSpawnArgs({
        command: 'codex',
        cwd: '/wt',
        model: 'm',
        initialPrompt: 'p',
        mcpServer: null,
        permissionLevel: 'full'
      })
      expect(out).toBe("codex --sandbox danger-full-access --ask-for-approval never --model 'm' 'p'")
    })

    it.each([
      { name: '--full-auto', command: 'codex --full-auto' },
      { name: '-s read-only', command: 'codex -s read-only' },
      { name: '-a never', command: 'codex -a never' },
      { name: '--yolo', command: 'codex --yolo' },
      { name: '--sandbox read-only', command: 'codex --sandbox read-only' },
      { name: '--sandbox=read-only', command: 'codex --sandbox=read-only' }
    ])('a command with $name gets no permission flags and logs why', ({ command }) => {
      const out = buildSpawnArgs({
        command,
        cwd: '/wt',
        model: 'm',
        initialPrompt: 'p',
        mcpServer: null,
        permissionLevel: 'full'
      })
      expect(out).toBe(`${command} --model 'm' 'p'`)
      expect(guardLogged()).toBe(true)
    })

    it.each(['read-only', 'edit', 'full'] as const)(
      '%s with an MCP server and a command that already sets --sandbox: --sandbox appears once',
      (level) => {
        const out = buildSpawnArgs({
          command: 'codex --sandbox read-only',
          cwd: '/wt',
          mcpServer: SPEC,
          permissionLevel: level
        })
        expect(shellArgv(out).filter((a) => a === '--sandbox')).toHaveLength(1)
        expect(shellArgv(out)).not.toContain('--ask-for-approval')
      }
    )
  })
})

describe('codexPermissionFlags (TEST-004)', () => {
  it.each([
    { level: 'read-only' as const, expected: ' --sandbox read-only --ask-for-approval never' },
    { level: 'edit' as const, expected: ' --sandbox workspace-write --ask-for-approval never' },
    { level: 'full' as const, expected: ' --sandbox danger-full-access --ask-for-approval never' },
    { level: undefined, expected: '' }
  ])('$level', ({ level, expected }) => {
    expect(codexPermissionFlags(level)).toBe(expected)
  })
})
