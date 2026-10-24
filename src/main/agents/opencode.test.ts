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
  unlinkSync: (p: string) => {
    fsState.files.delete(p)
  },
  readdirSync: () => [],
  statSync: () => ({ mtimeMs: 0 })
}))

vi.mock('../debug', () => ({
  log: vi.fn()
}))

vi.mock('child_process', () => ({
  execSync: (cmd: string) => {
    if (cmd.includes('opencode export')) {
      // Simulate session exists for 'existing-session-id', missing for others
      if (cmd.includes('existing-session-id')) return ''
      throw new Error('exit 1')
    }
    if (cmd.includes('opencode session list')) {
      return JSON.stringify([{ id: 'sess-123', directory: '/tmp/test', created: '2024-01-01', updated: '2024-01-02', title: 'Test', projectId: 'proj-1' }])
    }
    return ''
  }
}))

import { homedir } from 'os'
import { join } from 'path'
import { log } from '../debug'
import type { AgentSpawnOpts, HarnessMcpServerSpec } from './index'
import {
  buildOpencodeConfig,
  spawnEnv,
  buildSpawnArgs,
  hooksInstalled,
  installHooks,
  uninstallHooks,
  sessionFileExists,
  latestSessionId,
  stripHooksFromWorktree,
  makePluginContent,
  PLUGIN_PATH,
  opencodeStepAgent,
  opencodeStepPermission
} from './opencode'

beforeEach(() => {
  fsState.files.clear()
  vi.mocked(log).mockClear()
})

const SPEC: HarnessMcpServerSpec = {
  command: '/bin/el',
  args: ['/r/b.js', '--config', '/c.json'],
  env: { ELECTRON_RUN_AS_NODE: '1' }
}

const HARNESS_CONTROL = {
  type: 'local',
  command: ['/bin/el', '/r/b.js', '--config', '/c.json'],
  environment: { ELECTRON_RUN_AS_NODE: '1' },
  enabled: true
}

describe('buildSpawnArgs', () => {
  const base = { command: 'opencode', cwd: '/tmp/test' }

  it('returns just the command when no extras provided', () => {
    const result = buildSpawnArgs(base)
    expect(result).toBe('opencode')
  })

  it('appends --model when model is provided and not already in command', () => {
    const result = buildSpawnArgs({ ...base, model: 'openai/gpt-4' })
    expect(result).toBe("opencode --model 'openai/gpt-4'")
  })

  it('skips --model when command already contains --model', () => {
    const result = buildSpawnArgs({ ...base, command: 'opencode --model foo', model: 'openai/gpt-4' })
    expect(result).toBe('opencode --model foo')
  })

  it('skips --model when command already contains -m ', () => {
    const result = buildSpawnArgs({ ...base, command: 'opencode -m foo', model: 'openai/gpt-4' })
    expect(result).toBe('opencode -m foo')
  })

  it('uses --session for resumable session', () => {
    const result = buildSpawnArgs({ ...base, sessionId: 'existing-session-id' })
    expect(result).toBe("opencode --session 'existing-session-id'")
  })

  it('uses --prompt for new session when session not resumable', () => {
    const result = buildSpawnArgs({ ...base, sessionId: 'new-session-id', initialPrompt: 'hello world' })
    expect(result).toBe("opencode --prompt 'hello world'")
  })

  it('combines --session and --prompt when session is resumable and prompt provided', () => {
    const result = buildSpawnArgs({ ...base, sessionId: 'existing-session-id', initialPrompt: 'continue' })
    expect(result).toBe("opencode --session 'existing-session-id' --prompt 'continue'")
  })

  it('combines --model and --prompt', () => {
    const result = buildSpawnArgs({ ...base, model: 'openai/gpt-4', initialPrompt: 'hello' })
    expect(result).toBe("opencode --model 'openai/gpt-4' --prompt 'hello'")
  })

  it('shell-quotes values with single quotes', () => {
    const result = buildSpawnArgs({ ...base, initialPrompt: "it's a test" })
    expect(result).toBe("opencode --prompt 'it'\\''s a test'")
  })

  it('ignores mcpServer: argv is unchanged and never carries harness-control (TEST-011)', () => {
    const inputs: AgentSpawnOpts[] = [
      base,
      { ...base, model: 'openai/gpt-4' },
      { ...base, command: 'opencode --model foo', model: 'openai/gpt-4' },
      { ...base, command: 'opencode -m foo', model: 'openai/gpt-4' },
      { ...base, sessionId: 'existing-session-id' },
      { ...base, sessionId: 'new-session-id', initialPrompt: 'hello world' },
      { ...base, sessionId: 'existing-session-id', initialPrompt: 'continue' },
      { ...base, model: 'openai/gpt-4', initialPrompt: 'hello' },
      { ...base, initialPrompt: "it's a test" }
    ]
    for (const input of inputs) {
      const withServer = buildSpawnArgs({ ...input, mcpConfigPath: '/c.json', mcpServer: SPEC })
      expect(withServer).toBe(buildSpawnArgs(input))
      expect(withServer).not.toContain('harness-control')
    }
  })
})

describe('buildOpencodeConfig (TEST-009)', () => {
  const opts: AgentSpawnOpts = { command: 'opencode', cwd: '/w', mcpServer: SPEC }

  it('adds harness-control next to existing mcp servers and keeps every other key', () => {
    const base = { mcp: { other: { type: 'remote', url: 'u' } }, theme: 'x' }
    expect(buildOpencodeConfig(opts, base)).toEqual({
      mcp: { other: { type: 'remote', url: 'u' }, 'harness-control': HARNESS_CONTROL },
      theme: 'x'
    })
  })

  it('does not mutate the base config', () => {
    const base = { mcp: { other: { type: 'remote', url: 'u' } }, theme: 'x' }
    buildOpencodeConfig(opts, base)
    expect(base).toEqual({ mcp: { other: { type: 'remote', url: 'u' } }, theme: 'x' })
  })

  it('adds an mcp section when the base has none', () => {
    expect(buildOpencodeConfig(opts, { theme: 'x' })).toEqual({
      theme: 'x',
      mcp: { 'harness-control': HARNESS_CONTROL }
    })
  })

  it('returns the base contents unchanged when mcpServer is null', () => {
    const base = { mcp: { other: { type: 'remote', url: 'u' } }, theme: 'x' }
    expect(buildOpencodeConfig({ ...opts, mcpServer: null }, base)).toEqual(base)
  })
})

describe('spawnEnv (TEST-010)', () => {
  const opts: AgentSpawnOpts = { command: 'opencode', cwd: '/w', mcpServer: SPEC }
  const parsed = (env: Record<string, string>) => JSON.parse(env.OPENCODE_CONFIG_CONTENT)

  it('with no user value emits a config holding only harness-control', () => {
    const env = spawnEnv(opts, {}, {})
    expect(Object.keys(env)).toEqual(['OPENCODE_CONFIG_CONTENT'])
    expect(parsed(env)).toEqual({ mcp: { 'harness-control': HARNESS_CONTROL } })
  })

  it('merges a user value from the configured env vars', () => {
    const env = spawnEnv(opts, { OPENCODE_CONFIG_CONTENT: '{"model":"m"}' }, {})
    expect(parsed(env)).toEqual({ model: 'm', mcp: { 'harness-control': HARNESS_CONTROL } })
    expect(log).not.toHaveBeenCalled()
  })

  it('merges a user value from the inherited env when the configured env vars have none', () => {
    const env = spawnEnv(opts, {}, { OPENCODE_CONFIG_CONTENT: '{"model":"m"}' })
    expect(parsed(env)).toEqual({ model: 'm', mcp: { 'harness-control': HARNESS_CONTROL } })
  })

  it('prefers the configured env var over the inherited one', () => {
    const env = spawnEnv(
      opts,
      { OPENCODE_CONFIG_CONTENT: '{"model":"configured"}' },
      { OPENCODE_CONFIG_CONTENT: '{"model":"inherited"}' }
    )
    expect(parsed(env).model).toBe('configured')
  })

  it.each([
    { name: 'invalid JSON', raw: '{not json' },
    { name: 'a JSON array', raw: '[1,2]' },
    { name: 'a JSON string', raw: '"s"' },
    { name: 'JSON null', raw: 'null' }
  ])('drops $name, keeps only our section and logs', ({ raw }) => {
    const env = spawnEnv(opts, { OPENCODE_CONFIG_CONTENT: raw }, {})
    expect(parsed(env)).toEqual({ mcp: { 'harness-control': HARNESS_CONTROL } })
    expect(log).toHaveBeenCalledWith('mcp', expect.any(String))
  })

  it('returns no env when mcpServer is null and there is no user value', () => {
    expect(spawnEnv({ ...opts, mcpServer: null }, {}, {})).toEqual({})
  })
})

const READ_ONLY_PERMISSION = {
  '*': 'deny',
  read: 'allow',
  glob: 'allow',
  grep: 'allow',
  list: 'allow',
  'harness-control_*': 'allow',
  edit: { '*': 'deny', '.harness/runs/**': 'allow' },
  bash: 'deny',
  external_directory: 'deny',
  doom_loop: 'deny'
}

describe('opencodeStepPermission (TEST-006)', () => {
  it('full allows everything', () => {
    expect(opencodeStepPermission('full', ['git status'])).toEqual({ '*': 'allow' })
  })

  it('read-only denies by default, allows reads, MCP and run-folder edits, and ignores bashAllow', () => {
    expect(opencodeStepPermission('read-only', ['git status'])).toEqual(READ_ONLY_PERMISSION)
  })

  it('edit allows every edit and each bashAllow prefix with and without args', () => {
    expect(opencodeStepPermission('edit', ['npm test', 'git diff'])).toEqual({
      ...READ_ONLY_PERMISSION,
      edit: 'allow',
      bash: { '*': 'deny', 'npm test': 'allow', 'npm test *': 'allow', 'git diff': 'allow', 'git diff *': 'allow' }
    })
  })

  it('edit with no prefixes denies all bash', () => {
    expect(opencodeStepPermission('edit', []).bash).toEqual({ '*': 'deny' })
  })

  it('edit orders bash rules catch-all first, then each prefix and its args form', () => {
    expect(Object.keys(opencodeStepPermission('edit', ['git status']).bash as object)).toEqual([
      '*',
      'git status',
      'git status *'
    ])
  })

  it.each(['read-only', 'edit', 'full'] as const)('%s puts the "*" catch-all first in every map', (level) => {
    const map = opencodeStepPermission(level, ['npm test'])
    const maps = [map, ...Object.values(map).filter((v): v is object => typeof v === 'object' && v !== null)]
    for (const m of maps) expect(Object.keys(m)[0]).toBe('*')
  })
})

describe('opencodeStepAgent (TEST-006)', () => {
  it('is a primary agent without the task tool, carrying the level map and the model', () => {
    expect(opencodeStepAgent('edit', ['npm test'], 'openai/gpt-4')).toEqual({
      mode: 'primary',
      description: 'Tatsu workflow step',
      tools: { task: false },
      permission: opencodeStepPermission('edit', ['npm test']),
      model: 'openai/gpt-4'
    })
  })

  it.each([
    { name: 'undefined', model: undefined },
    { name: 'null', model: null }
  ])('has no model key when the model is $name', ({ model }) => {
    expect(opencodeStepAgent('full', [], model)).not.toHaveProperty('model')
  })
})

describe('buildOpencodeConfig with a permission level (TEST-007)', () => {
  const opts: AgentSpawnOpts = { command: 'opencode', cwd: '/w', mcpServer: SPEC }

  it('adds the step agent next to the user agents, the MCP server and every other key', () => {
    const config = buildOpencodeConfig(
      { ...opts, permissionLevel: 'edit', bashAllow: ['git status'], model: 'openai/gpt-4' },
      { agent: { mine: { mode: 'subagent' } }, theme: 'x' }
    )
    expect(config).toEqual({
      theme: 'x',
      mcp: { 'harness-control': HARNESS_CONTROL },
      agent: {
        mine: { mode: 'subagent' },
        'harness-step': opencodeStepAgent('edit', ['git status'], 'openai/gpt-4')
      }
    })
  })

  it('overwrites a user-defined harness-step agent', () => {
    const config = buildOpencodeConfig(
      { ...opts, permissionLevel: 'read-only' },
      { agent: { 'harness-step': { mode: 'subagent', permission: { '*': 'allow' } } } }
    )
    expect((config.agent as Record<string, unknown>)['harness-step']).toEqual(opencodeStepAgent('read-only', []))
  })

  it('adds no agent section without a level', () => {
    expect(buildOpencodeConfig(opts, { theme: 'x' })).not.toHaveProperty('agent')
  })

  it('adds no harness-step agent when the command already picks an agent', () => {
    const config = buildOpencodeConfig(
      { ...opts, command: 'opencode --agent build', permissionLevel: 'full' },
      { agent: { mine: { mode: 'subagent' } } }
    )
    expect(config.agent).toEqual({ mine: { mode: 'subagent' } })
  })
})

describe('spawnEnv with a permission level (TEST-007)', () => {
  const parsed = (env: Record<string, string>) => JSON.parse(env.OPENCODE_CONFIG_CONTENT)

  it('emits one OPENCODE_CONFIG_CONTENT holding both the MCP server and the step agent', () => {
    const env = spawnEnv({ command: 'opencode', cwd: '/w', mcpServer: SPEC, permissionLevel: 'read-only' }, {}, {})
    expect(Object.keys(env)).toEqual(['OPENCODE_CONFIG_CONTENT'])
    expect(parsed(env).mcp['harness-control']).toEqual(HARNESS_CONTROL)
    expect(parsed(env).agent['harness-step'].permission).toEqual(READ_ONLY_PERMISSION)
  })

  it('still emits the step agent when there is no MCP server', () => {
    const env = spawnEnv({ command: 'opencode', cwd: '/w', mcpServer: null, permissionLevel: 'full' }, {}, {})
    expect(parsed(env)).toEqual({ agent: { 'harness-step': opencodeStepAgent('full', []) } })
  })
})

describe('buildSpawnArgs with a permission level (TEST-007)', () => {
  const base = { command: 'opencode', cwd: '/tmp/test' }

  it('launches the step agent before --model and --prompt', () => {
    const result = buildSpawnArgs({ ...base, permissionLevel: 'edit', model: 'openai/gpt-4', initialPrompt: 'hello' })
    expect(result).toBe("opencode --agent harness-step --model 'openai/gpt-4' --prompt 'hello'")
  })

  it('launches the step agent before --session on resume', () => {
    const result = buildSpawnArgs({ ...base, permissionLevel: 'read-only', sessionId: 'existing-session-id' })
    expect(result).toBe("opencode --agent harness-step --session 'existing-session-id'")
  })

  it('keeps a command-line --agent and logs that the level is not applied', () => {
    const result = buildSpawnArgs({ ...base, command: 'opencode --agent build', permissionLevel: 'full', initialPrompt: 'hi' })
    expect(result).toBe("opencode --agent build --prompt 'hi'")
    expect(result).not.toContain('harness-step')
    expect(log).toHaveBeenCalledWith('agent-spawn', 'opencode command already sets --agent; permissionLevel not applied')
  })
})

describe('sessionFileExists', () => {
  it('returns true when opencode export succeeds', () => {
    expect(sessionFileExists('/tmp/test', 'existing-session-id')).toBe(true)
  })

  it('returns false when opencode export fails', () => {
    expect(sessionFileExists('/tmp/test', 'missing-session-id')).toBe(false)
  })
})

describe('latestSessionId', () => {
  it('returns the id from the first session list entry', () => {
    const id = latestSessionId('/tmp/test')
    expect(id).toBe('sess-123')
  })
})

describe('hook install / dedup', () => {
  it('hooksInstalled() returns false when plugin file does not exist', () => {
    expect(hooksInstalled()).toBe(false)
  })

  it('hooksInstalled() returns true when Harness plugin file exists', () => {
    fsState.files.set(PLUGIN_PATH, '// harness-opencode-plugin')
    expect(hooksInstalled()).toBe(true)
  })

  it('hooksInstalled() returns false when a non-Harness plugin file exists', () => {
    fsState.files.set(PLUGIN_PATH, '// some other plugin')
    expect(hooksInstalled()).toBe(false)
  })

  it('installHooks() writes the plugin file', () => {
    installHooks()
    expect(fsState.files.has(PLUGIN_PATH)).toBe(true)
    const content = fsState.files.get(PLUGIN_PATH) as string
    expect(content).toContain('harness-opencode-plugin')
    expect(content).toContain('/tmp/harness-status')
  })

  it('installHooks() overwrites an existing plugin file', () => {
    fsState.files.set(PLUGIN_PATH, '// old content')
    installHooks()
    const content = fsState.files.get(PLUGIN_PATH) as string
    expect(content).toContain('harness-opencode-plugin')
  })

  it('uninstallHooks() removes only the Harness plugin file', () => {
    installHooks()
    expect(fsState.files.has(PLUGIN_PATH)).toBe(true)
    uninstallHooks()
    expect(fsState.files.has(PLUGIN_PATH)).toBe(false)
  })

  it('uninstallHooks() no-ops when plugin file does not exist', () => {
    expect(() => uninstallHooks()).not.toThrow()
    expect(fsState.files.has(PLUGIN_PATH)).toBe(false)
  })

  it('uninstallHooks() preserves non-Harness plugin files', () => {
    fsState.files.set(PLUGIN_PATH, '// some other plugin')
    uninstallHooks()
    expect(fsState.files.has(PLUGIN_PATH)).toBe(true)
  })
})

describe('stripHooksFromWorktree', () => {
  it('returns false (no legacy per-worktree opencode path)', () => {
    expect(stripHooksFromWorktree('/tmp/test')).toBe(false)
  })
})

describe('makePluginContent', () => {
  it('starts with the Harness signature line and exports the HarnessStatus factory', () => {
    const content = makePluginContent()
    expect(content.split('\n')[0]).toBe('// harness-opencode-plugin')
    expect(content).toContain('export const HarnessStatus = async')
  })

  it('has exactly one export and no CommonJS', () => {
    const content = makePluginContent()
    expect(content.match(/\bexport\b/g) ?? []).toHaveLength(1)
    expect(content.match(/^export /gm) ?? []).toHaveLength(1)
    expect(content).not.toMatch(/\brequire\s*\(/)
    expect(content).not.toContain('module.exports')
  })

  it('uses the opencode 1.18 hook and bus-event shapes', () => {
    const content = makePluginContent()
    expect(content).toContain("'tool.execute.before'")
    expect(content).toContain("'tool.execute.after'")
    expect(content).toContain('client.session.messages')
    expect(content).toContain('properties')
    expect(content).toContain('sessionID')
    expect(content).not.toContain('ev.payload')
  })
})
