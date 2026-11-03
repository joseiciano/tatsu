import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'fs'
import * as realFs from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest'
import { endpointUrl, removeCliEndpoint, writeCliEndpoint, type CliEndpointDeps } from '.'

const TOKEN = 'a'.repeat(64)

let dir: string
let path: string
let log: Mock<NonNullable<CliEndpointDeps['log']>>

function deps(overrides: Partial<CliEndpointDeps> = {}): CliEndpointDeps {
  return { path, log, pid: 4242, now: () => 1700000000000, ...overrides }
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'cli-endpoint-'))
  path = join(dir, 'cli-endpoint.json')
  log = vi.fn()
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('endpointUrl', () => {
  it.each(['0.0.0.0', '127.0.0.1', 'localhost', '::', ''])('uses loopback for bind host %j', (host) => {
    expect(endpointUrl(37291, host)).toBe('ws://127.0.0.1:37291')
  })

  it('keeps a specific IPv4 bind host', () => {
    expect(endpointUrl(5, '192.168.1.20')).toBe('ws://192.168.1.20:5')
  })

  it('brackets a specific IPv6 bind host', () => {
    expect(endpointUrl(5, '::1')).toBe('ws://[::1]:5')
  })
})

describe('writeCliEndpoint', () => {
  it('writes the versioned shape with a loopback URL at mode 0600', () => {
    writeCliEndpoint({ port: 37291, token: TOKEN, bindHost: '0.0.0.0' }, deps())

    expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual({
      version: 1,
      url: 'ws://127.0.0.1:37291',
      token: TOKEN,
      pid: 4242,
      startedAt: 1700000000000
    })
    expect(statSync(path).mode & 0o777).toBe(0o600)
  })

  it('tightens the mode when replacing a looser existing file and leaves no temp files', () => {
    writeFileSync(path, '{}', { mode: 0o644 })
    writeCliEndpoint({ port: 1, token: TOKEN, bindHost: '127.0.0.1' }, deps())

    expect(statSync(path).mode & 0o777).toBe(0o600)
    expect(readdirSync(dir)).toEqual(['cli-endpoint.json'])
  })

  it('replaces the file by rename so readers never see a partial write', () => {
    const renameSync = vi.fn(realFs.renameSync)
    writeCliEndpoint({ port: 1, token: TOKEN, bindHost: '127.0.0.1' }, deps({ fs: { ...realFs, renameSync } }))

    expect(renameSync).toHaveBeenCalledTimes(1)
    expect(renameSync.mock.calls[0][1]).toBe(path)
    expect(renameSync.mock.calls[0][0]).not.toBe(path)
  })

  it('logs and swallows a failure without leaving the temp file or the token in the log', () => {
    const renameSync = vi.fn(() => {
      throw new Error('EACCES')
    })

    expect(() =>
      writeCliEndpoint({ port: 1, token: TOKEN, bindHost: '127.0.0.1' }, deps({ fs: { ...realFs, renameSync } }))
    ).not.toThrow()
    expect(readdirSync(dir)).toEqual([])
    expect(log).toHaveBeenCalled()
    expect(JSON.stringify(log.mock.calls)).not.toContain(TOKEN)
  })

  it('swallows a failure when the directory does not exist', () => {
    expect(() =>
      writeCliEndpoint({ port: 1, token: TOKEN, bindHost: '127.0.0.1' }, deps({ path: join(dir, 'missing', 'x.json') }))
    ).not.toThrow()
    expect(log).toHaveBeenCalled()
  })
})

describe('removeCliEndpoint', () => {
  it('removes the file this process wrote', () => {
    writeCliEndpoint({ port: 1, token: TOKEN, bindHost: '127.0.0.1' }, deps())
    removeCliEndpoint(deps())
    expect(readdirSync(dir)).toEqual([])
  })

  it('leaves a file owned by another pid in place', () => {
    writeCliEndpoint({ port: 1, token: TOKEN, bindHost: '127.0.0.1' }, deps({ pid: 999 }))
    removeCliEndpoint(deps())
    expect(readdirSync(dir)).toEqual(['cli-endpoint.json'])
  })

  it('leaves an unparseable file in place and logs', () => {
    writeFileSync(path, 'not json')
    removeCliEndpoint(deps())
    expect(readdirSync(dir)).toEqual(['cli-endpoint.json'])
    expect(log).toHaveBeenCalled()
  })

  it('is a silent no-op when the file is missing', () => {
    expect(() => removeCliEndpoint(deps())).not.toThrow()
    expect(log).not.toHaveBeenCalled()
  })

  it('logs and swallows an unlink failure', () => {
    writeCliEndpoint({ port: 1, token: TOKEN, bindHost: '127.0.0.1' }, deps())
    const unlinkSync = vi.fn(() => {
      throw new Error('EBUSY')
    })
    expect(() => removeCliEndpoint(deps({ fs: { ...realFs, unlinkSync } }))).not.toThrow()
    expect(log).toHaveBeenCalled()
  })
})
