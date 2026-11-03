import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const spawn = vi.fn()

vi.mock('node-pty', () => ({ spawn: (...args: unknown[]) => spawn(...args) }))
vi.mock('../debug', () => ({ log: () => {} }))
vi.mock('../hooks', () => ({ cleanupTerminalLog: () => {} }))
vi.mock('../persistence', () => ({
  saveTerminalHistory: () => {},
  loadTerminalHistory: () => null,
  clearTerminalHistory: () => {}
}))

import { PtyManager } from '.'

const ENDPOINT_FILE = '/data/cli-endpoint.json'

function spawnedEnv(): Record<string, string> {
  return spawn.mock.calls[0][2].env
}

beforeEach(() => {
  spawn.mockReset()
  spawn.mockReturnValue({ onData: () => {}, onExit: () => {}, kill: () => {}, pid: 1 })
})

afterEach(() => {
  vi.unstubAllEnvs()
})

describe('PtyManager env', () => {
  it('sets TATSU_ENDPOINT_FILE next to HARNESS_TERMINAL_ID when an endpoint file is configured', () => {
    const manager = new PtyManager()
    manager.setCliEndpointFile(ENDPOINT_FILE)
    manager.create('term-1', '/tmp', '/bin/zsh', [])

    expect(spawnedEnv()).toMatchObject({ HARNESS_TERMINAL_ID: 'term-1', TATSU_ENDPOINT_FILE: ENDPOINT_FILE })
  })

  it('omits TATSU_ENDPOINT_FILE when none is configured, even if the host env has one', () => {
    vi.stubEnv('TATSU_ENDPOINT_FILE', '/parent/cli-endpoint.json')
    const manager = new PtyManager()
    manager.create('term-1', '/tmp', '/bin/zsh', [])

    expect(spawnedEnv()).not.toHaveProperty('TATSU_ENDPOINT_FILE')
  })

  it('overrides an inherited TATSU_ENDPOINT_FILE and never injects HARNESS_DATA_DIR', () => {
    vi.stubEnv('TATSU_ENDPOINT_FILE', '/parent/cli-endpoint.json')
    vi.stubEnv('HARNESS_DATA_DIR', '')
    delete process.env.HARNESS_DATA_DIR
    const manager = new PtyManager()
    manager.setCliEndpointFile(ENDPOINT_FILE)
    manager.create('term-1', '/tmp', '/bin/zsh', [], { TATSU_ENDPOINT_FILE: '/extra.json' })

    expect(spawnedEnv().TATSU_ENDPOINT_FILE).toBe(ENDPOINT_FILE)
    expect(spawnedEnv()).not.toHaveProperty('HARNESS_DATA_DIR')
  })
})
