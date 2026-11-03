import { describe, it, expect, vi } from 'vitest'
import { CliError } from '../errors'
import { isPidAlive, resolveEndpoint, type EndpointIO } from '.'

const TOKEN = 's3cret-token'
const HOME = '/home/u'

function io(env: EndpointIO['env'], overrides: Partial<EndpointIO> = {}): EndpointIO {
  return {
    env,
    homedir: () => HOME,
    platform: 'darwin',
    readFile: async (path) => {
      throw Object.assign(new Error(`ENOENT: ${path}`), { code: 'ENOENT' })
    },
    isPidAlive: () => true,
    ...overrides
  }
}

async function failure(promise: Promise<unknown>): Promise<CliError> {
  const err = await promise.then(
    () => undefined,
    (e: unknown) => e
  )
  expect(err).toBeInstanceOf(CliError)
  return err as CliError
}

describe('resolveEndpoint', () => {
  it('uses the flags when both are given', async () => {
    const endpoint = await resolveEndpoint({ url: 'ws://127.0.0.1:1', token: TOKEN }, io({}))
    expect(endpoint).toEqual({ url: 'ws://127.0.0.1:1', token: TOKEN, source: 'flag' })
  })

  it('prefers the flags over the env vars', async () => {
    const endpoint = await resolveEndpoint(
      { url: 'ws://127.0.0.1:1', token: TOKEN },
      io({ TATSU_URL: 'ws://127.0.0.1:2', TATSU_TOKEN: 'other' })
    )
    expect(endpoint.source).toBe('flag')
    expect(endpoint.url).toBe('ws://127.0.0.1:1')
  })

  it('falls back to TATSU_URL and TATSU_TOKEN', async () => {
    const endpoint = await resolveEndpoint({}, io({ TATSU_URL: 'ws://127.0.0.1:2', TATSU_TOKEN: TOKEN }))
    expect(endpoint).toEqual({ url: 'ws://127.0.0.1:2', token: TOKEN, source: 'env' })
  })

  it.each([
    [{ url: 'ws://127.0.0.1:1' }, {}],
    [{ token: TOKEN }, {}],
    [{ url: 'ws://127.0.0.1:1' }, { TATSU_TOKEN: TOKEN }],
    [{}, { TATSU_URL: 'ws://127.0.0.1:2' }],
    [{}, { TATSU_URL: 'ws://127.0.0.1:2', TATSU_TOKEN: '' }]
  ])('is a usage error when a URL has no token (flags %j, env %j)', async (flags, env) => {
    const err = await failure(resolveEndpoint(flags, io(env)))
    expect(err.code).toBe('usage')
  })

  it.each(['http://127.0.0.1:1', 'not a url'])('rejects %s as a usage error', async (url) => {
    const err = await failure(resolveEndpoint({ url, token: TOKEN }, io({})))
    expect(err.code).toBe('usage')
  })

  it('never echoes the token or a tokenized URL in its errors', async () => {
    const err = await failure(resolveEndpoint({ url: `bogus?token=${TOKEN}`, token: TOKEN }, io({})))
    expect(err.message).not.toContain(TOKEN)
  })

  it('strips a token query parameter from the reported URL', async () => {
    const endpoint = await resolveEndpoint({ url: `ws://127.0.0.1:1/?token=${TOKEN}`, token: TOKEN }, io({}))
    expect(endpoint.url).not.toContain(TOKEN)
    expect(endpoint.url).toBe('ws://127.0.0.1:1/')
  })

  it('is not-running when nothing is configured', async () => {
    const err = await failure(resolveEndpoint({}, io({ TATSU_TOKEN: TOKEN })))
    expect(err.code).toBe('not-running')
  })
})

describe('resolveEndpoint: endpoint files', () => {
  const ALIVE = 100
  const DEAD = 200
  const MAC_DESKTOP = `${HOME}/Library/Application Support/Harness/cli-endpoint.json`
  const MAC_DEV = `${HOME}/Library/Application Support/Harness (Dev)/cli-endpoint.json`

  function endpointFile(port: number, pid = ALIVE, overrides: Record<string, unknown> = {}): string {
    return JSON.stringify({ version: 1, url: `ws://127.0.0.1:${port}`, token: `tok-${port}`, pid, startedAt: 1, ...overrides })
  }

  function files(contents: Record<string, string>, overrides: Partial<EndpointIO> = {}, env: EndpointIO['env'] = {}) {
    const reads: string[] = []
    const fileIO = io(env, {
      readFile: async (path) => {
        reads.push(path)
        if (path in contents) return contents[path]
        throw Object.assign(new Error(`ENOENT: ${path}`), { code: 'ENOENT' })
      },
      isPidAlive: (pid) => pid !== DEAD,
      ...overrides
    })
    return { io: fileIO, reads }
  }

  it('checks every source in order after flags and env', async () => {
    const { io: fileIO, reads } = files({}, {}, { TATSU_ENDPOINT_FILE: '/pty/ep.json', HARNESS_DATA_DIR: '/data' })
    await failure(resolveEndpoint({}, fileIO))
    expect(reads).toEqual([
      '/pty/ep.json',
      '/data/cli-endpoint.json',
      `${HOME}/.harness/cli-endpoint.json`,
      MAC_DESKTOP,
      MAC_DEV
    ])
  })

  it('prefers TATSU_URL over every endpoint file', async () => {
    const { io: fileIO, reads } = files(
      { '/pty/ep.json': endpointFile(1) },
      {},
      { TATSU_URL: 'ws://127.0.0.1:2', TATSU_TOKEN: TOKEN, TATSU_ENDPOINT_FILE: '/pty/ep.json' }
    )
    expect((await resolveEndpoint({}, fileIO)).source).toBe('env')
    expect(reads).toEqual([])
  })

  it('uses $TATSU_ENDPOINT_FILE first, with the file path as the source', async () => {
    const { io: fileIO } = files(
      { '/pty/ep.json': endpointFile(1), '/data/cli-endpoint.json': endpointFile(2) },
      {},
      { TATSU_ENDPOINT_FILE: '/pty/ep.json', HARNESS_DATA_DIR: '/data' }
    )
    expect(await resolveEndpoint({}, fileIO)).toEqual({ url: 'ws://127.0.0.1:1', token: 'tok-1', source: '/pty/ep.json' })
  })

  it('uses $HARNESS_DATA_DIR before ~/.harness', async () => {
    const { io: fileIO } = files(
      { '/data/cli-endpoint.json': endpointFile(2), [`${HOME}/.harness/cli-endpoint.json`]: endpointFile(3) },
      {},
      { HARNESS_DATA_DIR: '/data' }
    )
    expect((await resolveEndpoint({}, fileIO)).source).toBe('/data/cli-endpoint.json')
  })

  it('falls back to ~/.harness, then the packaged desktop file, then the dev desktop file', async () => {
    const home = `${HOME}/.harness/cli-endpoint.json`
    expect((await resolveEndpoint({}, files({ [home]: endpointFile(3), [MAC_DESKTOP]: endpointFile(4) }).io)).source).toBe(home)
    expect((await resolveEndpoint({}, files({ [MAC_DESKTOP]: endpointFile(4), [MAC_DEV]: endpointFile(5) }).io)).source).toBe(
      MAC_DESKTOP
    )
    expect((await resolveEndpoint({}, files({ [MAC_DEV]: endpointFile(5) }).io)).source).toBe(MAC_DEV)
  })

  it('uses XDG_CONFIG_HOME for the Linux desktop files', async () => {
    const { io: fileIO, reads } = files({}, { platform: 'linux' }, { XDG_CONFIG_HOME: '/xdg' })
    await failure(resolveEndpoint({}, fileIO))
    expect(reads.slice(-2)).toEqual(['/xdg/Harness/cli-endpoint.json', '/xdg/Harness (Dev)/cli-endpoint.json'])
  })

  it('defaults the Linux desktop files to ~/.config when XDG_CONFIG_HOME is unset or empty', async () => {
    const { io: fileIO, reads } = files({}, { platform: 'linux' }, { XDG_CONFIG_HOME: '' })
    await failure(resolveEndpoint({}, fileIO))
    expect(reads.slice(-2)).toEqual([`${HOME}/.config/Harness/cli-endpoint.json`, `${HOME}/.config/Harness (Dev)/cli-endpoint.json`])
  })

  it('skips the desktop files on other platforms', async () => {
    const { io: fileIO, reads } = files({}, { platform: 'win32' })
    await failure(resolveEndpoint({}, fileIO))
    expect(reads).toEqual([`${HOME}/.harness/cli-endpoint.json`])
  })

  it('reads a path only once when sources point at the same file', async () => {
    const { io: fileIO, reads } = files({}, {}, { HARNESS_DATA_DIR: `${HOME}/.harness` })
    await failure(resolveEndpoint({}, fileIO))
    expect(reads.filter((p) => p === `${HOME}/.harness/cli-endpoint.json`)).toHaveLength(1)
  })

  it('skips a stale $TATSU_ENDPOINT_FILE and names it if nothing else hits', async () => {
    const { io: fileIO } = files({ '/pty/ep.json': endpointFile(1, DEAD) }, {}, { TATSU_ENDPOINT_FILE: '/pty/ep.json' })
    const err = await failure(resolveEndpoint({}, fileIO))
    expect(err.code).toBe('not-running')
    expect(err.message).toContain('stale endpoint file at /pty/ep.json')
    expect(err.details).toEqual({ staleFiles: ['/pty/ep.json'] })
  })

  it('skips a stale file and connects to the next live one', async () => {
    const { io: fileIO } = files(
      { '/data/cli-endpoint.json': endpointFile(2, DEAD), [`${HOME}/.harness/cli-endpoint.json`]: endpointFile(3) },
      {},
      { HARNESS_DATA_DIR: '/data' }
    )
    expect((await resolveEndpoint({}, fileIO)).url).toBe('ws://127.0.0.1:3')
  })

  it('names every stale file and explains how to start a backend', async () => {
    const { io: fileIO } = files(
      { '/data/cli-endpoint.json': endpointFile(2, DEAD), [MAC_DESKTOP]: endpointFile(4, DEAD) },
      {},
      { HARNESS_DATA_DIR: '/data' }
    )
    const err = await failure(resolveEndpoint({}, fileIO))
    expect(err.message).toContain('/data/cli-endpoint.json')
    expect(err.message).toContain(MAC_DESKTOP)
    expect(err.message).toContain('harness-server')
    expect(err.message).toContain('wsTransportEnabled')
    expect(err.message).toContain('HARNESS_WS_TRANSPORT=1')
    expect(err.message).not.toContain('tok-')
  })

  it('explains how to enable a backend when no file exists at all', async () => {
    const err = await failure(resolveEndpoint({}, files({}).io))
    expect(err.code).toBe('not-running')
    expect(err.message).toContain('wsTransportEnabled')
    expect(err.message).toContain('harness-server')
    expect(err.details).toEqual({ staleFiles: [] })
  })

  it.each([
    ['not json', 'nope'],
    ['an array', '[]'],
    ['null', 'null'],
    ['a wrong version', endpointFile(1, ALIVE, { version: 2 })],
    ['a missing token', endpointFile(1, ALIVE, { token: '' })],
    ['a non-ws URL', endpointFile(1, ALIVE, { url: 'http://127.0.0.1:1' })],
    ['an invalid URL', endpointFile(1, ALIVE, { url: 'not a url' })],
    ['a zero pid', endpointFile(1, 0)],
    ['a negative pid', endpointFile(1, -1)],
    ['a fractional pid', endpointFile(1, 1.5)],
    ['a string pid', endpointFile(1, ALIVE, { pid: '100' })]
  ])('ignores a file with %s without calling it stale', async (_label, content) => {
    const isPidAlive = vi.fn(() => true)
    const { io: fileIO } = files({ '/data/cli-endpoint.json': content }, { isPidAlive }, { HARNESS_DATA_DIR: '/data' })
    const err = await failure(resolveEndpoint({}, fileIO))
    expect(err.code).toBe('not-running')
    expect(err.details).toEqual({ staleFiles: [] })
    expect(isPidAlive).not.toHaveBeenCalled()
  })

  it('ignores an unreadable file and keeps looking', async () => {
    const { io: fileIO } = files({ [`${HOME}/.harness/cli-endpoint.json`]: endpointFile(3) }, {}, { HARNESS_DATA_DIR: '/data' })
    const readFile = fileIO.readFile
    fileIO.readFile = async (path) => {
      if (path === '/data/cli-endpoint.json') throw Object.assign(new Error('EACCES'), { code: 'EACCES' })
      return readFile(path)
    }
    expect((await resolveEndpoint({}, fileIO)).url).toBe('ws://127.0.0.1:3')
  })
})

describe('isPidAlive', () => {
  function killThrowing(code: string) {
    return vi.spyOn(process, 'kill').mockImplementation(() => {
      throw Object.assign(new Error(code), { code })
    })
  }

  it('is true for this process', () => {
    expect(isPidAlive(process.pid)).toBe(true)
  })

  it('counts EPERM as alive', () => {
    const kill = killThrowing('EPERM')
    expect(isPidAlive(12345)).toBe(true)
    kill.mockRestore()
  })

  it('is false for ESRCH', () => {
    const kill = killThrowing('ESRCH')
    expect(isPidAlive(12345)).toBe(false)
    kill.mockRestore()
  })
})
