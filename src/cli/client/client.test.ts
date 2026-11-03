import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { Store } from '../../main/store'
import { WebSocketServerTransport } from '../../main/transport-websocket'
import { initialState } from '../../shared/state'
import { CliError } from '../errors'
import { connect, type TatsuClient } from '.'

const TOKEN = 'integration-secret-token'

function listen(server: Server): Promise<number> {
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve((server.address() as AddressInfo).port)))
}

async function failure(promise: Promise<unknown>): Promise<CliError> {
  const err = await promise.then(
    () => undefined,
    (e: unknown) => e
  )
  expect(err).toBeInstanceOf(CliError)
  const cliError = err as CliError
  expect(cliError.message).not.toContain(TOKEN)
  return cliError
}

describe('connect against the real WebSocketServerTransport', () => {
  let http: Server
  let transport: WebSocketServerTransport
  let url: string
  const clients: TatsuClient[] = []

  beforeAll(async () => {
    const store = new Store({
      ...initialState,
      worktrees: { ...initialState.worktrees, repoRoots: ['/repo/a'] }
    })
    http = createServer()
    transport = new WebSocketServerTransport(store, { server: http, token: TOKEN })
    transport.onRequest('test:echo', async (_ctx, ...args) => ({ args }))
    transport.onRequest('test:fail', async () => {
      throw new Error('boom from handler')
    })
    transport.onRequest('test:hang', () => new Promise(() => {}))
    transport.start()
    url = `ws://127.0.0.1:${await listen(http)}`
  })

  afterAll(async () => {
    for (const client of clients) client.close()
    transport.stop()
    await new Promise((resolve) => http.close(resolve))
  })

  async function open(timeoutMs?: number): Promise<TatsuClient> {
    const client = await connect({ url, token: TOKEN, source: 'flag' }, { timeoutMs })
    clients.push(client)
    return client
  }

  it('exposes the endpoint without the token', async () => {
    const client = await open()
    expect(client.endpoint).toEqual({ url, source: 'flag' })
  })

  it('returns the merged snapshot state', async () => {
    const client = await open()
    const state = await client.snapshot()
    expect(state.worktrees.repoRoots).toEqual(['/repo/a'])
    expect(state.settings).toBeDefined()
  })

  it('returns a request value and keeps concurrent replies apart', async () => {
    const client = await open()
    const [one, two] = await Promise.all([client.request('test:echo', 1), client.request('test:echo', 'two', 2)])
    expect(one).toEqual({ args: [1] })
    expect(two).toEqual({ args: ['two', 2] })
  })

  it('maps an {ok:false} reply to request-failed with the server error text', async () => {
    const client = await open()
    const err = await failure(client.request('test:fail'))
    expect(err.code).toBe('request-failed')
    expect(err.message).toContain('boom from handler')
  })

  it('times out a request whose handler never resolves', async () => {
    const client = await open(400)
    const err = await failure(client.request('test:hang'))
    expect(err.code).toBe('timeout')
  })

  it('drops the socket at once on close, even while a request hangs, and rejects later calls', async () => {
    const client = await open()
    const clientId = await client.request<string>('transport:getClientId')
    const serverSawDisconnect = new Promise<void>((resolve) =>
      transport.onClientDisconnect((id) => {
        if (id === clientId) resolve()
      })
    )
    const pending = client.request('test:hang')
    const t0 = Date.now()
    client.close()
    expect((await failure(pending)).code).toBe('unreachable')
    expect((await failure(client.request('test:echo'))).code).toBe('unreachable')
    await serverSawDisconnect
    expect(Date.now() - t0).toBeLessThan(500)
  })

  it('maps a rejected token to unauthorized and keeps the token out of the message', async () => {
    const err = await failure(connect({ url, token: `${TOKEN}-wrong`, source: 'env' }))
    expect(err.code).toBe('unauthorized')
    expect(err.message).toContain('TATSU_URL/TATSU_TOKEN')
  })

  it('maps a closed port to unreachable', async () => {
    const probe = createServer()
    const port = await listen(probe)
    await new Promise((resolve) => probe.close(resolve))
    const err = await failure(connect({ url: `ws://127.0.0.1:${port}`, token: TOKEN, source: 'flag' }))
    expect(err.code).toBe('unreachable')
  })

  it('rejects pending requests with unreachable when the server goes away', async () => {
    const client = await open()
    const pending = client.request('test:hang')
    transport.stop()
    const err = await failure(pending)
    expect(err.code).toBe('unreachable')
  })
})
