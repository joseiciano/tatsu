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
  appendFileSync: (p: string, data: string) => {
    fsState.files.set(p, (fsState.files.get(p) ?? '') + data)
  },
  unlinkSync: (p: string) => {
    fsState.files.delete(p)
  },
  mkdirSync: () => {},
  readdirSync: () => [],
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
  makeCodexHookCommand
} from './codex'

const HOOKS_PATH = join(homedir(), '.codex', 'hooks.json')
const SCRIPT_PATH = join(homedir(), '.codex', 'harness-hook.sh')

beforeEach(() => {
  fsState.files.clear()
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
