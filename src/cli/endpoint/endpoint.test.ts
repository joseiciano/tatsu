import { describe, it, expect } from 'vitest'
import { CliError } from '../errors'
import { resolveEndpoint } from '.'

const TOKEN = 's3cret-token'

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
    const endpoint = await resolveEndpoint({ url: 'ws://127.0.0.1:1', token: TOKEN }, { env: {} })
    expect(endpoint).toEqual({ url: 'ws://127.0.0.1:1', token: TOKEN, source: 'flag' })
  })

  it('prefers the flags over the env vars', async () => {
    const endpoint = await resolveEndpoint(
      { url: 'ws://127.0.0.1:1', token: TOKEN },
      { env: { TATSU_URL: 'ws://127.0.0.1:2', TATSU_TOKEN: 'other' } }
    )
    expect(endpoint.source).toBe('flag')
    expect(endpoint.url).toBe('ws://127.0.0.1:1')
  })

  it('falls back to TATSU_URL and TATSU_TOKEN', async () => {
    const endpoint = await resolveEndpoint({}, { env: { TATSU_URL: 'ws://127.0.0.1:2', TATSU_TOKEN: TOKEN } })
    expect(endpoint).toEqual({ url: 'ws://127.0.0.1:2', token: TOKEN, source: 'env' })
  })

  it.each([
    [{ url: 'ws://127.0.0.1:1' }, {}],
    [{ token: TOKEN }, {}],
    [{ url: 'ws://127.0.0.1:1' }, { TATSU_TOKEN: TOKEN }],
    [{}, { TATSU_URL: 'ws://127.0.0.1:2' }],
    [{}, { TATSU_URL: 'ws://127.0.0.1:2', TATSU_TOKEN: '' }]
  ])('is a usage error when a URL has no token (flags %j, env %j)', async (flags, env) => {
    const err = await failure(resolveEndpoint(flags, { env }))
    expect(err.code).toBe('usage')
  })

  it.each(['http://127.0.0.1:1', 'not a url'])('rejects %s as a usage error', async (url) => {
    const err = await failure(resolveEndpoint({ url, token: TOKEN }, { env: {} }))
    expect(err.code).toBe('usage')
  })

  it('never echoes the token or a tokenized URL in its errors', async () => {
    const err = await failure(resolveEndpoint({ url: `bogus?token=${TOKEN}`, token: TOKEN }, { env: {} }))
    expect(err.message).not.toContain(TOKEN)
  })

  it('strips a token query parameter from the reported URL', async () => {
    const endpoint = await resolveEndpoint({ url: `ws://127.0.0.1:1/?token=${TOKEN}`, token: TOKEN }, { env: {} })
    expect(endpoint.url).not.toContain(TOKEN)
    expect(endpoint.url).toBe('ws://127.0.0.1:1/')
  })

  it('is not-running when nothing is configured', async () => {
    const err = await failure(resolveEndpoint({}, { env: { TATSU_TOKEN: TOKEN } }))
    expect(err.code).toBe('not-running')
  })
})
