import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { harnessMcpServerSpec, removeStaleStepMarkers, writeMcpConfigForTerminal } from '.'
import { log } from '../debug'

const h = vi.hoisted(() => ({ dataDir: '', failChmod: false, failMkdir: false }))

vi.mock('fs', async () => {
  const actual = await vi.importActual<typeof import('fs')>('fs')
  return {
    ...actual,
    chmodSync: (...args: Parameters<typeof actual.chmodSync>) => {
      if (h.failChmod) throw new Error('EPERM: chmod denied')
      return actual.chmodSync(...args)
    },
    mkdirSync: (...args: Parameters<typeof actual.mkdirSync>) => {
      if (h.failMkdir) throw new Error('EACCES: mkdir denied')
      return actual.mkdirSync(...args)
    }
  }
})

vi.mock('../control-server', () => ({
  getControlServerInfo: () => ({ port: 1234, token: 'tok' })
}))

vi.mock('../paths', () => ({
  userDataDir: () => h.dataDir,
  resolveBundledMcpScript: (name: string) => `/bundle/${name}`
}))

vi.mock('../debug', () => ({ log: vi.fn() }))

describe('harnessMcpServerSpec', () => {
  it('runs the bridge under the given executable with --config and no secrets in env', () => {
    expect(harnessMcpServerSpec('/c.json', '/bin/el', '/r/b.js')).toEqual({
      command: '/bin/el',
      args: ['/r/b.js', '--config', '/c.json'],
      env: { ELECTRON_RUN_AS_NODE: '1' }
    })
  })
})

describe('writeMcpConfigForTerminal', () => {
  beforeEach(() => {
    h.dataDir = mkdtempSync(join(tmpdir(), 'mcp-config-test-'))
  })

  afterEach(() => {
    h.failChmod = false
    h.failMkdir = false
    vi.mocked(log).mockClear()
    rmSync(h.dataDir, { recursive: true, force: true })
  })

  const mode = (p: string): number => statSync(p).mode & 0o777

  it('writes the config file owner-only', () => {
    const p = writeMcpConfigForTerminal('term-1', null)

    expect(p).not.toBeNull()
    expect(mode(p!)).toBe(0o600)
  })

  it('tightens a pre-existing world-readable config file to owner-only', () => {
    const dir = join(h.dataDir, 'mcp-configs')
    mkdirSync(dir, { recursive: true })
    const existing = join(dir, 'term-1.json')
    writeFileSync(existing, '{}')
    chmodSync(existing, 0o644)

    const p = writeMcpConfigForTerminal('term-1', null)

    expect(p).toBe(existing)
    expect(mode(existing)).toBe(0o600)
  })

  it('creates the mcp-configs directory owner-only', () => {
    writeMcpConfigForTerminal('term-1', null)

    expect(mode(join(h.dataDir, 'mcp-configs'))).toBe(0o700)
  })

  it('returns null and logs instead of handing out a file it could not chmod', () => {
    h.failChmod = true

    let result: string | null | undefined
    expect(() => {
      result = writeMcpConfigForTerminal('term-1', null)
    }).not.toThrow()

    expect(result).toBeNull()
    expect(log).toHaveBeenCalledWith('mcp', expect.any(String), expect.anything())
  })

  it('returns null and logs when the config directory cannot be created', () => {
    h.failMkdir = true

    let result: string | null | undefined
    expect(() => {
      result = writeMcpConfigForTerminal('term-1', null)
    }).not.toThrow()

    expect(result).toBeNull()
    expect(log).toHaveBeenCalledWith('mcp', expect.any(String), expect.anything())
  })
})

describe('removeStaleStepMarkers', () => {
  let dir: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'mcp-markers-'))
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('deletes leftover .step marker files and leaves every other entry alone', () => {
    writeFileSync(join(dir, 'term-1.step'), '')
    writeFileSync(join(dir, 'term-2.step'), 'attempt')
    writeFileSync(join(dir, 'term-1.json'), '{}')
    writeFileSync(join(dir, 'notes.step.bak'), '')
    mkdirSync(join(dir, 'folder.step'))

    expect(removeStaleStepMarkers(dir)).toBe(2)

    expect(readdirSync(dir).sort()).toEqual(['folder.step', 'notes.step.bak', 'term-1.json'])
  })

  it('does nothing when the directory does not exist', () => {
    expect(removeStaleStepMarkers(join(dir, 'missing'))).toBe(0)
  })
})
