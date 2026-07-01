import { describe, it, expect, vi, beforeEach } from 'vitest'

// Mock node-pty before importing PtyManager
const mockOnData = vi.fn()
const mockOnExit = vi.fn()
const mockPty = {
  pid: 12345,
  onData: mockOnData,
  onExit: mockOnExit,
  write: vi.fn(),
  resize: vi.fn(),
  kill: vi.fn()
}
vi.mock('node-pty', () => ({
  spawn: vi.fn(() => mockPty)
}))

// Mock debug logger to suppress output
vi.mock('../debug', () => ({
  log: vi.fn()
}))

// Mock hooks cleanup
vi.mock('../hooks', () => ({
  cleanupTerminalLog: vi.fn()
}))

// Mock persistence
vi.mock('../persistence', () => ({
  saveTerminalHistory: vi.fn(),
  loadTerminalHistory: vi.fn(() => null),
  clearTerminalHistory: vi.fn()
}))

import { PtyManager } from './pty-manager'
import * as pty from 'node-pty'

describe('PtyManager.create return value', () => {
  let mgr: PtyManager

  beforeEach(() => {
    vi.clearAllMocks()
    mgr = new PtyManager()
  })

  it('returns true when PTY already exists (attach path)', () => {
    // First create succeeds
    vi.mocked(pty.spawn).mockReturnValue(mockPty as never)
    const first = mgr.create('t1', '/tmp', '/bin/zsh', [], undefined, true)
    expect(first).toBe(true)

    // Second create for same id returns true (attach, no respawn)
    const second = mgr.create('t1', '/tmp', '/bin/zsh', [], undefined, true)
    expect(second).toBe(true)
  })

  it('returns false when spawn plan errors (non-running container)', () => {
    mgr.setContainerResolver(() => ({
      worktreePath: '/wt',
      name: 'container',
      shell: '/bin/sh',
      workdir: '/workspace',
      status: 'stopped',
      error: undefined
    }))
    const result = mgr.create('t2', '/wt', '', [], undefined, true)
    expect(result).toBe(false)
    expect(pty.spawn).not.toHaveBeenCalled()
  })

  it('returns false when pty.spawn throws', () => {
    vi.mocked(pty.spawn).mockImplementation(() => {
      throw new Error('spawn failed')
    })
    const result = mgr.create('t3', '/tmp', '/nonexistent', [], undefined, true)
    expect(result).toBe(false)
  })

  it('returns true on successful spawn', () => {
    vi.mocked(pty.spawn).mockReturnValue(mockPty as never)
    const result = mgr.create('t4', '/tmp', '/bin/zsh', [], undefined, true)
    expect(result).toBe(true)
    expect(pty.spawn).toHaveBeenCalled()
  })
})
