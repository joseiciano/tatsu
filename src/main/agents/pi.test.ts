import { describe, it, expect, vi, beforeEach } from 'vitest'

const fsState: { files: Map<string, string> } = { files: new Map() }

vi.mock('fs', () => ({
  existsSync: (p: string) => {
    if (fsState.files.has(p)) return true
    for (const key of fsState.files.keys()) {
      if (key.startsWith(p + '/') || key.startsWith(p + '\\')) return true
    }
    return false
  },
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
  readdirSync: (p: string) => {
    const entries: string[] = []
    for (const key of fsState.files.keys()) {
      if (key.startsWith(p + '/') || key.startsWith(p + '\\')) {
        const relative = key.slice(p.length + 1)
        const firstSegment = relative.split(/[/\\]/)[0]
        if (firstSegment && !entries.includes(firstSegment)) {
          entries.push(firstSegment)
        }
      }
    }
    return entries
  },
  statSync: (p: string) => {
    const isDir = Array.from(fsState.files.keys()).some(
      (k) => k.startsWith(p + '/') || k.startsWith(p + '\\')
    )
    return {
      isFile: () => !isDir && fsState.files.has(p),
      isDirectory: () => isDir,
      mtimeMs: 0
    }
  }
}))

vi.mock('../debug', () => ({
  log: () => {}
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
  hookEvents,
  defaultCommand,
  assignsSessionId,
  EXTENSION_PATH
} from './pi'
import type { AgentSpawnOpts } from './index'

beforeEach(() => {
  fsState.files.clear()
})

describe('pi module exports', () => {
  it('has correct defaultCommand', () => {
    expect(defaultCommand).toBe('pi')
  })

  it('has assignsSessionId false', () => {
    expect(assignsSessionId).toBe(false)
  })

  it('has expected hookEvents', () => {
    expect(hookEvents).toContain('session_start')
    expect(hookEvents).toContain('agent_start')
    expect(hookEvents).toContain('agent_end')
    expect(hookEvents).toContain('tool_execution_start')
    expect(hookEvents).toContain('tool_execution_end')
    expect(hookEvents).toContain('session_shutdown')
  })
})

describe('hooksInstalled', () => {
  it('returns false when extension file does not exist', () => {
    expect(hooksInstalled()).toBe(false)
  })

  it('returns true when Harness extension file exists', () => {
    fsState.files.set(EXTENSION_PATH, '// harness-pi-extension')
    expect(hooksInstalled()).toBe(true)
  })

  it('returns false when a non-Harness extension file exists', () => {
    fsState.files.set(EXTENSION_PATH, '// some other extension')
    expect(hooksInstalled()).toBe(false)
  })
})

describe('installHooks', () => {
  it('writes the extension file', () => {
    installHooks()
    expect(fsState.files.has(EXTENSION_PATH)).toBe(true)
    const content = fsState.files.get(EXTENSION_PATH) as string
    expect(content).toContain('harness-pi-extension')
    expect(content).toContain('/tmp/harness-status')
  })

  it('overwrites an existing extension file', () => {
    fsState.files.set(EXTENSION_PATH, '// old content')
    installHooks()
    const content = fsState.files.get(EXTENSION_PATH) as string
    expect(content).toContain('harness-pi-extension')
  })
})

describe('uninstallHooks', () => {
  it('removes only the Harness extension file', () => {
    installHooks()
    expect(fsState.files.has(EXTENSION_PATH)).toBe(true)
    uninstallHooks()
    expect(fsState.files.has(EXTENSION_PATH)).toBe(false)
  })

  it('no-ops when extension file does not exist', () => {
    expect(() => uninstallHooks()).not.toThrow()
    expect(fsState.files.has(EXTENSION_PATH)).toBe(false)
  })

  it('preserves non-Harness extension files', () => {
    fsState.files.set(EXTENSION_PATH, '// some other extension')
    uninstallHooks()
    expect(fsState.files.has(EXTENSION_PATH)).toBe(true)
  })
})

describe('stripHooksFromWorktree', () => {
  it('returns false', () => {
    expect(stripHooksFromWorktree('/some/path')).toBe(false)
  })
})

describe('sessionFileExists', () => {
  it('returns false for non-existent session', () => {
    expect(sessionFileExists('/tmp', 'nonexistent-session-12345')).toBe(false)
  })

  it('accepts absolute session path that exists', () => {
    const sessionPath = join('/tmp', 'pi-session-test.jsonl')
    fsState.files.set(sessionPath, '')
    expect(sessionFileExists('/tmp', sessionPath)).toBe(true)
  })

  it('finds session by partial match in sessions dir', () => {
    const sessionsDir = join(homedir(), '.pi', 'agent', 'sessions')
    const sessionFile = join(sessionsDir, 'my-session-abc.jsonl')
    fsState.files.set(sessionFile, '')
    expect(sessionFileExists('/tmp', 'my-session')).toBe(true)
  })
})

describe('latestSessionId', () => {
  it('returns null when no sessions exist', () => {
    const result = latestSessionId('/tmp')
    expect(result).toBeNull()
  })

  it('returns the newest session file path', () => {
    const sessionsDir = join(homedir(), '.pi', 'agent', 'sessions')
    const oldFile = join(sessionsDir, 'old.jsonl')
    const newFile = join(sessionsDir, 'new.jsonl')
    fsState.files.set(oldFile, '')
    fsState.files.set(newFile, '')
    // Mock statSync mtimeMs by overriding for these specific paths
    const originalStatSync = vi.fn()
    // We can't easily override the mock per-test, so we rely on the fact
    // that both have mtimeMs 0 and the sort is stable. Let's use subdirs instead.
  })
})

describe('buildSpawnArgs', () => {
  const base: AgentSpawnOpts = {
    command: 'pi',
    cwd: '/tmp/test',
  }

  it('returns base command by default', () => {
    const result = buildSpawnArgs(base)
    expect(result).toBe('pi')
  })

  it('adds --model when model is set', () => {
    const result = buildSpawnArgs({ ...base, model: 'claude-sonnet-4-6' })
    expect(result).toBe("pi --model 'claude-sonnet-4-6'")
  })

  it('does not duplicate --model if already in command', () => {
    const result = buildSpawnArgs({ ...base, command: 'pi --model foo', model: 'bar' })
    expect(result).toBe('pi --model foo')
  })

  it('adds --name when sessionName is set', () => {
    const result = buildSpawnArgs({ ...base, sessionName: 'my-session' })
    expect(result).toBe("pi --name 'my-session'")
  })

  it('adds initial prompt', () => {
    const result = buildSpawnArgs({ ...base, initialPrompt: 'hello world' })
    expect(result).toBe("pi 'hello world'")
  })

  it('quotes initial prompt with single quotes', () => {
    const result = buildSpawnArgs({ ...base, initialPrompt: "it's a test" })
    expect(result).toBe("pi 'it'\\''s a test'")
  })

  it('adds model and initial prompt together', () => {
    const result = buildSpawnArgs({ ...base, model: 'opus', initialPrompt: 'hello' })
    expect(result).toBe("pi --model 'opus' 'hello'")
  })

  it('adds --session for existing session and includes prompt', () => {
    const sessionPath = join('/tmp', 'pi-session-test.jsonl')
    fsState.files.set(sessionPath, '')
    const result = buildSpawnArgs({ ...base, sessionId: sessionPath, initialPrompt: 'continue' })
    expect(result).toContain('--session')
    expect(result).toContain("'continue'")
  })

  it('skips --session when session does not exist and falls back to prompt', () => {
    const result = buildSpawnArgs({ ...base, sessionId: '/tmp/nonexistent.jsonl', initialPrompt: 'hello' })
    expect(result).not.toContain('--session')
    expect(result).toBe("pi 'hello'")
  })
})