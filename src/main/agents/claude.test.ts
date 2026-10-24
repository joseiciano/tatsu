import { describe, it, expect, vi, beforeEach } from 'vitest'

const fsState: { files: Map<string, string> } = { files: new Map() }

vi.mock('fs', () => ({
  existsSync: (p: string) => fsState.files.has(p),
  readFileSync: (p: string) => {
    if (!fsState.files.has(p)) throw new Error(`ENOENT: ${p}`)
    return fsState.files.get(p) as string
  },
  writeFileSync: (p: string, data: string) => {
    fsState.files.set(p, data)
  },
  mkdirSync: () => {},
  readdirSync: () => [],
  statSync: () => ({ mtimeMs: 0 })
}))

vi.mock('../debug', () => ({
  log: vi.fn()
}))

vi.mock('../hooks', () => ({
  // Match the real shape — every Harness hook command embeds the
  // status-dir path. That substring is what dedup recognizes.
  makeHookCommand: (event: string) =>
    `bash -c 'd=/tmp/harness-status; printf "${event}" >> "$d/$h.ndjson"'`
}))

import { homedir } from 'os'
import { join } from 'path'
import { log } from '../debug'
import {
  buildSpawnArgs,
  CLAUDE_COMPLETE_STEP_TOOL,
  CLAUDE_READ_TOOLS,
  claudeAllowedTools,
  claudePermissionFlags,
  hooksInstalled,
  installHooks,
  hookEvents,
  uninstallHooks
} from './claude'

const SETTINGS_PATH = join(homedir(), '.claude', 'settings.json')

beforeEach(() => {
  fsState.files.clear()
  vi.mocked(log).mockClear()
})

const READ_ONLY_LIST = 'Read,Grep,Glob,Edit(.harness/runs/**),mcp__harness-control__complete_step'
const EDIT_LIST =
  'Read,Grep,Glob,Edit,Write,NotebookEdit,Bash(npm test:*),Bash(git diff:*),mcp__harness-control__complete_step'

describe('claudeAllowedTools (TEST-002)', () => {
  it('read-only allows the read tools, run-folder edits and complete_step, ignoring bashAllow', () => {
    expect(claudeAllowedTools('read-only', ['npm test'])).toEqual([
      ...CLAUDE_READ_TOOLS,
      'Edit(.harness/runs/**)',
      CLAUDE_COMPLETE_STEP_TOOL
    ])
  })

  it('edit allows every file-editing tool and one Bash rule per prefix, in input order', () => {
    expect(claudeAllowedTools('edit', ['npm test', 'git diff'])).toEqual([
      'Read',
      'Grep',
      'Glob',
      'Edit',
      'Write',
      'NotebookEdit',
      'Bash(npm test:*)',
      'Bash(git diff:*)',
      'mcp__harness-control__complete_step'
    ])
  })

  it('edit with no prefixes has no Bash rule', () => {
    expect(claudeAllowedTools('edit', []).some((t) => t.startsWith('Bash'))).toBe(false)
  })
})

describe('claudePermissionFlags (TEST-002)', () => {
  it.each([
    { name: 'no level adds nothing', level: undefined, allow: ['npm test'], expected: '' },
    { name: 'full bypasses permissions', level: 'full' as const, allow: ['npm test'], expected: ' --permission-mode bypassPermissions' },
    {
      name: 'read-only passes one quoted allowlist then dontAsk',
      level: 'read-only' as const,
      allow: [],
      expected: ` --allowedTools '${READ_ONLY_LIST}' --permission-mode dontAsk`
    },
    {
      name: 'edit passes one quoted allowlist with Bash prefixes then dontAsk',
      level: 'edit' as const,
      allow: ['npm test', 'git diff'],
      expected: ` --allowedTools '${EDIT_LIST}' --permission-mode dontAsk`
    }
  ])('$name', ({ level, allow, expected }) => {
    expect(claudePermissionFlags(level, allow)).toBe(expected)
  })

  it.each(['read-only', 'edit'] as const)('%s always allows complete_step and ends with dontAsk', (level) => {
    const flags = claudePermissionFlags(level)
    expect(flags).toContain('mcp__harness-control__complete_step')
    expect(flags.endsWith('--permission-mode dontAsk')).toBe(true)
  })
})

describe('buildSpawnArgs with a permission level (TEST-003)', () => {
  const base = { command: 'claude', cwd: '/tmp/test' }

  it('puts --permission-mode right after the quoted allowlist, before the prompt', () => {
    const result = buildSpawnArgs({ ...base, initialPrompt: 'do it', permissionLevel: 'read-only' })
    expect(result).toBe(`claude --allowedTools '${READ_ONLY_LIST}' --permission-mode dontAsk -- 'do it'`)
  })

  it.each([
    { level: 'read-only' as const, flags: ` --allowedTools '${READ_ONLY_LIST}' --permission-mode dontAsk` },
    { level: 'edit' as const, flags: ` --allowedTools '${EDIT_LIST}' --permission-mode dontAsk` },
    { level: 'full' as const, flags: ' --permission-mode bypassPermissions' }
  ])('$level: flags follow the command and every other flag keeps its order', ({ level, flags }) => {
    const opts = {
      ...base,
      tuiFullscreen: true,
      model: 'opus',
      mcpConfigPath: '/c.json',
      sessionName: 'repo/main',
      systemPrompt: 'SYS',
      initialPrompt: 'go',
      bashAllow: ['npm test', 'git diff']
    }
    const withoutLevel = buildSpawnArgs(opts)
    expect(buildSpawnArgs({ ...opts, permissionLevel: level })).toBe(
      withoutLevel.replace('claude', `claude${flags}`)
    )
  })

  it.each([
    'claude --permission-mode plan',
    'claude --dangerously-skip-permissions',
    'claude --allowedTools Read',
    'claude --allowed-tools Read'
  ])('adds no permission flags when the command already has them: %s', (command) => {
    const opts = { ...base, command, initialPrompt: 'go' }
    expect(buildSpawnArgs({ ...opts, permissionLevel: 'edit', bashAllow: ['npm test'] })).toBe(buildSpawnArgs(opts))
    expect(log).toHaveBeenCalledWith(
      'agent-spawn',
      'claude command already sets permissions; permissionLevel not applied'
    )
  })

  it('without a level ignores bashAllow and adds no permission flags', () => {
    const result = buildSpawnArgs({ ...base, initialPrompt: 'go', bashAllow: ['npm test'] })
    expect(result).toBe("claude -- 'go'")
  })
})

describe('buildSpawnArgs', () => {
  const base = { command: 'claude', cwd: '/tmp/test' }

  it('includes --append-system-prompt when systemPrompt is provided', () => {
    const result = buildSpawnArgs({ ...base, systemPrompt: 'You are in Harness.' })
    expect(result).toContain('--append-system-prompt')
    expect(result).toContain('You are in Harness.')
  })

  it('omits --append-system-prompt when systemPrompt is undefined', () => {
    const result = buildSpawnArgs({ ...base })
    expect(result).not.toContain('--append-system-prompt')
  })

  it('omits --append-system-prompt when systemPrompt is empty', () => {
    const result = buildSpawnArgs({ ...base, systemPrompt: '' })
    expect(result).not.toContain('--append-system-prompt')
  })

  it('shell-quotes the system prompt safely', () => {
    const prompt = "it's a \"test\" with\nnewlines"
    const result = buildSpawnArgs({ ...base, systemPrompt: prompt })
    expect(result).toContain('--append-system-prompt')
    expect(result).toContain("'\\''")
  })

  it('separates the initial prompt from the variadic --mcp-config with -- (REQ-018)', () => {
    const result = buildSpawnArgs({ ...base, mcpConfigPath: '/c.json', initialPrompt: 'say hi' })
    expect(result).toMatch(/ --mcp-config '\/c\.json' -- 'say hi'$/)
  })

  it('places the initial prompt after -- following --session-id for a new session (REQ-018)', () => {
    const result = buildSpawnArgs({
      ...base,
      mcpConfigPath: '/c.json',
      initialPrompt: 'say hi',
      sessionId: 'abc'
    })
    expect(result).toMatch(/ --session-id abc -- 'say hi'$/)
  })
})

describe('hook install / dedup', () => {
  it('hooksInstalled() recognizes normalized entries with no _marker field', () => {
    // Simulate what Claude Code leaves behind after normalizing settings.json:
    // the _marker and _version sidecar fields are stripped, only the
    // {type, command, timeout} triple remains.
    const settings = {
      hooks: {
        UserPromptSubmit: [
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
    fsState.files.set(SETTINGS_PATH, JSON.stringify(settings))
    expect(hooksInstalled()).toBe(true)
  })

  it('hooksInstalled() returns false when only user-authored hooks exist', () => {
    const settings = {
      hooks: {
        UserPromptSubmit: [
          {
            hooks: [{ type: 'command', command: 'echo user hook', timeout: 5 }]
          }
        ]
      }
    }
    fsState.files.set(SETTINGS_PATH, JSON.stringify(settings))
    expect(hooksInstalled()).toBe(false)
  })

  it('installHooks() called twice yields exactly one harness entry per event', () => {
    installHooks()
    installHooks()
    const settings = JSON.parse(fsState.files.get(SETTINGS_PATH) as string)
    for (const event of hookEvents) {
      const entries = settings.hooks[event]
      expect(entries).toHaveLength(1)
      expect(entries[0].hooks[0].command).toContain('/tmp/harness-status')
    }
  })

  it('installHooks() collapses pre-existing duplicates left by buggy passes', () => {
    // Three duplicate harness entries per event, all in normalized form
    // (no _marker / _version). This is the exact shape the user reports
    // after several buggy install passes.
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
    const settings: { hooks: Record<string, unknown[]> } = { hooks: {} }
    for (const event of hookEvents) {
      settings.hooks[event] = [dupEntry, dupEntry, dupEntry]
    }
    fsState.files.set(SETTINGS_PATH, JSON.stringify(settings))

    installHooks()

    const after = JSON.parse(fsState.files.get(SETTINGS_PATH) as string)
    for (const event of hookEvents) {
      expect(after.hooks[event]).toHaveLength(1)
    }
  })

  it('installHooks() preserves user-authored hooks (commands not pointing at /tmp/harness-status)', () => {
    const userHook = {
      hooks: [{ type: 'command', command: 'echo user hook', timeout: 10 }]
    }
    fsState.files.set(
      SETTINGS_PATH,
      JSON.stringify({
        hooks: {
          UserPromptSubmit: [userHook],
          PreToolUse: [userHook]
        },
        unrelatedKey: 'preserve-me'
      })
    )

    installHooks()

    const after = JSON.parse(fsState.files.get(SETTINGS_PATH) as string)
    expect(after.unrelatedKey).toBe('preserve-me')
    // User hook still there + one harness entry appended
    expect(after.hooks.UserPromptSubmit).toContainEqual(userHook)
    expect(after.hooks.PreToolUse).toContainEqual(userHook)
    for (const event of hookEvents) {
      const harnessEntries = (after.hooks[event] as Array<{ hooks: { command: string }[] }>).filter(
        (e) => e.hooks.some((h) => h.command.includes('/tmp/harness-status'))
      )
      expect(harnessEntries).toHaveLength(1)
    }
  })

  it('uninstallHooks() removes harness entries but preserves user-authored hooks', () => {
    installHooks()
    // Add a user-authored hook alongside
    const after = JSON.parse(fsState.files.get(SETTINGS_PATH) as string)
    after.hooks.UserPromptSubmit.push({
      hooks: [{ type: 'command', command: 'echo user hook' }]
    })
    fsState.files.set(SETTINGS_PATH, JSON.stringify(after))

    uninstallHooks()

    const final = JSON.parse(fsState.files.get(SETTINGS_PATH) as string)
    expect(final.hooks?.UserPromptSubmit).toEqual([
      { hooks: [{ type: 'command', command: 'echo user hook' }] }
    ])
    // Other events had no user hooks, so they should be gone entirely.
    expect(final.hooks?.PreToolUse).toBeUndefined()
  })
})
