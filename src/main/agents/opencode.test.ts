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
  log: () => {}
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
import {
  buildSpawnArgs,
  hooksInstalled,
  installHooks,
  uninstallHooks,
  sessionFileExists,
  latestSessionId,
  stripHooksFromWorktree,
  PLUGIN_PATH
} from './opencode'

beforeEach(() => {
  fsState.files.clear()
})

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
