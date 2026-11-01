import { describe, it, expect, vi, beforeEach } from 'vitest'

type ExitHandler = (e: { exitCode: number }) => void

const spawned = vi.hoisted(() => [] as { args: string[]; fireExit: (code: number) => void }[])

vi.mock('node-pty', () => ({
  spawn: vi.fn((_file: string, args: string[]) => {
    let onExit: ExitHandler = () => {}
    spawned.push({ args, fireExit: (exitCode) => onExit({ exitCode }) })
    return {
      pid: 1234,
      onData: () => ({ dispose: () => {} }),
      onExit: (handler: ExitHandler) => {
        onExit = handler
        return { dispose: () => {} }
      },
      write: () => {},
      resize: () => {},
      kill: () => {}
    }
  })
}))

vi.mock('../debug', () => ({ log: vi.fn() }))
vi.mock('../hooks', () => ({ cleanupTerminalLog: vi.fn() }))
vi.mock('../persistence', () => ({
  saveTerminalHistory: vi.fn(),
  loadTerminalHistory: vi.fn(() => null),
  clearTerminalHistory: vi.fn()
}))

import { log } from '../debug'
import { PtyManager } from '.'

function lastSpawn(): (typeof spawned)[number] {
  return spawned[spawned.length - 1]
}

describe('PtyManager.onExit', () => {
  beforeEach(() => {
    spawned.length = 0
    vi.mocked(log).mockClear()
  })

  it('tells each listener the terminal id and exit code while the PTY is still registered', () => {
    const pty = new PtyManager()
    const seen: { id: string; code: number; alive: boolean }[] = []
    pty.onExit((id, code) => seen.push({ id, code, alive: pty.hasTerminal(id) }))
    pty.onExit((id, code) => seen.push({ id, code, alive: pty.hasTerminal(id) }))

    pty.create('t1', '/wt', '/bin/zsh', ['-il'])
    lastSpawn().fireExit(3)

    expect(seen).toEqual([
      { id: 't1', code: 3, alive: true },
      { id: 't1', code: 3, alive: true }
    ])
    expect(pty.hasTerminal('t1')).toBe(false)
  })

  it('stops calling a listener after it unsubscribes', () => {
    const pty = new PtyManager()
    const listener = vi.fn()
    const off = pty.onExit(listener)
    off()

    pty.create('t1', '/wt', '/bin/zsh', ['-il'])
    lastSpawn().fireExit(0)

    expect(listener).not.toHaveBeenCalled()
  })

  it('still cleans up the PTY and calls later listeners when one listener throws', () => {
    const pty = new PtyManager()
    const later = vi.fn()
    pty.onExit(() => {
      throw new Error('boom')
    })
    pty.onExit(later)

    pty.create('t1', '/wt', '/bin/zsh', ['-il'])
    lastSpawn().fireExit(1)

    expect(later).toHaveBeenCalledWith('t1', 1)
    expect(pty.hasTerminal('t1')).toBe(false)
  })
})

describe('PtyManager.create logging', () => {
  it('does not log the spawn args, which can carry a prompt and permission flags', () => {
    const pty = new PtyManager()
    pty.create('t1', '/wt', '', ['-ilc', "claude --permission-mode acceptEdits 'SECRET_PROMPT'"])

    const lines = vi.mocked(log).mock.calls.map((c) => JSON.stringify(c))
    expect(lines.some((l) => l.includes('create id=t1'))).toBe(true)
    expect(lines.some((l) => l.includes('SECRET_PROMPT') || l.includes('acceptEdits'))).toBe(false)
  })
})
