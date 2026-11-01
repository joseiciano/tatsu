import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../debug', () => ({ log: vi.fn() }))
vi.mock('../../hooks', () => ({ cleanupTerminalLog: vi.fn() }))
vi.mock('../../persistence', () => ({
  saveTerminalHistory: vi.fn(),
  loadTerminalHistory: vi.fn(() => null),
  clearTerminalHistory: vi.fn()
}))

import { PtyManager } from '../../pty-manager'
import { createShellStepDriver, type StepDriverEvent } from '.'

let hasPty = true
try {
  await import('node-pty')
} catch {
  hasPty = false
}

let home: string
let ptyManager: PtyManager

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'shell-pty-'))
  ptyManager = new PtyManager()
})

afterEach(() => {
  ptyManager.killAll('SIGKILL')
  rmSync(home, { recursive: true, force: true })
})

describe.skipIf(!hasPty)('shell step cancel on a real PTY', () => {
  it.each([
    ['interactive zsh with job control', '/bin/zsh', '-fic'],
    ['sh', '/bin/sh', '-c']
  ])('stops the foreground command under %s', async (_label, shell, flag) => {
    const driver = createShellStepDriver({
      addTab: (worktreePath, tab, spawn) => {
        ptyManager.create(tab.id, worktreePath, shell, [flag, spawn.command ?? ''], {
          ...spawn.env,
          HOME: home,
          ZDOTDIR: home
        })
      },
      hasTerminal: (id) => ptyManager.hasTerminal(id),
      getHistory: (id) => ptyManager.getHistory(id),
      onExit: (listener) => ptyManager.onExit(listener),
      kill: (id, signal) => ptyManager.kill(id, signal),
      newTabId: () => 'pty-cancel'
    })
    const exited = new Promise<number>((resolve) => {
      ptyManager.onExit(() => resolve(Date.now()))
    })
    const events: StepDriverEvent[] = []
    driver.onEvent((event) => events.push(event))
    const { executionId } = driver.start({
      runId: 'run-1',
      stepId: 'test',
      attemptId: 'att-1',
      n: 1,
      worktreePath: home,
      inputs: {},
      step: { kind: 'shell', id: 'test', run: 'echo STARTED; sleep 5; echo AFTER', needs: [] },
      scope: { inputs: {}, steps: {}, run: { id: 'run-1', worktree: home, contextPath: join(home, 'ctx.md') } }
    })
    const deadline = Date.now() + 3000
    while (!ptyManager.getHistory(executionId).includes('STARTED') && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 50))
    }
    const cancelledAt = Date.now()
    driver.cancel(executionId)
    const exitedAt = await exited
    await new Promise((resolve) => setTimeout(resolve, 300))
    expect(exitedAt - cancelledAt).toBeLessThan(2000)
    expect(ptyManager.getHistory(executionId)).toContain('STARTED')
    expect(ptyManager.getHistory(executionId)).not.toContain('AFTER')
    expect(events).toEqual([])
    driver.dispose()
  }, 10000)
})
