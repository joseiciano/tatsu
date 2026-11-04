import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest'
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { spawn } from 'child_process'
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'

vi.mock('../src/main/debug', () => ({
  log: vi.fn(),
  formatErr: (err) => (err instanceof Error ? err.message : String(err))
}))

vi.mock('../src/main/github-auth', () => ({
  getCachedToken: vi.fn(() => 'stub-token'),
  invalidateTokenCache: vi.fn(),
  resolveGitHubToken: vi.fn(async () => ({ token: 'stub-token', source: 'pat' }))
}))

const here = dirname(fileURLToPath(import.meta.url))
const STUB = join(here, 'github-stub.mjs')
const TIMEOUT = 60_000

function startStub(seed) {
  const dir = mkdtempSync(join(tmpdir(), 'github-stub-'))
  const seedPath = join(dir, 'seed.json')
  const logPath = join(dir, 'requests.jsonl')
  writeFileSync(seedPath, JSON.stringify(seed))
  const child = spawn(process.execPath, [STUB, '--seed', seedPath, '--log', logPath], {
    stdio: ['ignore', 'pipe', 'inherit']
  })
  const url = new Promise((resolve, reject) => {
    let out = ''
    child.stdout.on('data', (chunk) => {
      out += chunk.toString('utf-8')
      const line = out.split('\n').find((l) => l.startsWith('http://'))
      if (line) resolve(line.trim())
    })
    child.on('exit', (code) => reject(new Error(`stub exited early with ${code}`)))
  })
  const exited = new Promise((resolve) => child.on('exit', (code, signal) => resolve({ code, signal })))
  return { dir, logPath, child, url, exited }
}

function readLog(logPath) {
  return readFileSync(logPath, 'utf-8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line))
}

describe('github-stub with the GitHub client', () => {
  let stub
  let github

  beforeAll(async () => {
    stub = startStub({})
    vi.stubEnv('HARNESS_GITHUB_API_URL', await stub.url)
    vi.resetModules()
    github = await import('../src/main/github')
  }, TIMEOUT)

  afterAll(async () => {
    vi.unstubAllEnvs()
    stub.child.kill('SIGTERM')
    expect(await stub.exited).toEqual({ code: 0, signal: null })
    rmSync(stub.dir, { recursive: true, force: true })
  }, TIMEOUT)

  it('prints a loopback URL on an ephemeral port', async () => {
    expect(await stub.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/)
  })

  it('creates a PR, rebases it, and records both requests without credentials', async () => {
    const created = await github.createPullRequest({
      owner: 'acme',
      repo: 'widgets',
      head: 'chain/step-1',
      base: 'main',
      title: 'Step 1',
      body: 'First step',
      draft: true
    })
    expect(created).toEqual({
      ok: true,
      pr: { number: 1, url: 'https://github.com/acme/widgets/pull/1', draft: true }
    })

    const updated = await github.updatePullRequestBase({ owner: 'acme', repo: 'widgets', number: 1, base: 'release' })
    expect(updated).toEqual({
      ok: true,
      pr: { number: 1, url: 'https://github.com/acme/widgets/pull/1', draft: true }
    })

    expect(readLog(stub.logPath)).toEqual([
      {
        method: 'POST',
        path: '/repos/acme/widgets/pulls',
        body: { head: 'chain/step-1', base: 'main', title: 'Step 1', body: 'First step', draft: true }
      },
      { method: 'PATCH', path: '/repos/acme/widgets/pulls/1', body: { base: 'release' } }
    ])
    const raw = readFileSync(stub.logPath, 'utf-8')
    expect(raw).not.toContain('stub-token')
    expect(raw.toLowerCase()).not.toContain('authorization')
  }, TIMEOUT)

  it('reads a created PR back through getPRMetadata-shaped GET', async () => {
    const res = await fetch(`${await stub.url}/repos/acme/widgets/pulls/1`)
    const pr = await res.json()
    expect(pr.base.ref).toBe('release')
    expect(pr.head.ref).toBe('chain/step-1')
  }, TIMEOUT)

  it('drives the 422 path for a head containing fail-pr', async () => {
    const res = await github.createPullRequest({
      owner: 'acme',
      repo: 'widgets',
      head: 'chain/fail-pr',
      base: 'main',
      title: 'Nope',
      body: '',
      draft: false
    })
    expect(res).toEqual({
      ok: false,
      error: {
        kind: 'http',
        status: 422,
        message: 'Validation Failed',
        errors: ['stub refused pull request for chain/fail-pr']
      }
    })
  }, TIMEOUT)

  it('answers an unknown route with a JSON 404', async () => {
    const res = await fetch(`${await stub.url}/nope`)
    expect(res.status).toBe(404)
    expect(await res.json()).toEqual({ message: 'Not Found' })
  }, TIMEOUT)
})

describe('github-stub seeded fail mode', () => {
  let stub

  beforeAll(() => {
    stub = startStub({ failPulls: true, issues: [{ number: 4, title: 'Seeded issue' }] })
  }, TIMEOUT)

  afterAll(async () => {
    stub.child.kill('SIGTERM')
    await stub.exited
    rmSync(stub.dir, { recursive: true, force: true })
  }, TIMEOUT)

  it('refuses every PR create with a 422 and serves seeded issues and the PRPoller GraphQL shape', async () => {
    const base = await stub.url
    const create = await fetch(`${base}/repos/acme/widgets/pulls`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ head: 'ok', base: 'main', title: 't', body: '', draft: false })
    })
    expect(create.status).toBe(422)
    expect((await create.json()).message).toBe('Validation Failed')

    const issue = await fetch(`${base}/repos/acme/widgets/issues/4`)
    expect(await issue.json()).toMatchObject({ number: 4, author_association: 'OWNER' })

    const search = await fetch(`${base}/search/issues?q=repo%3Aacme%2Fwidgets`)
    expect((await search.json()).items).toHaveLength(1)

    const graphql = await fetch(`${base}/graphql`, { method: 'POST', body: '{"query":"{}"}' })
    const gql = await graphql.json()
    expect(gql.errors).toBeUndefined()
    expect(gql.data.repository.defaultBranchRef.name).toBe('main')

    const user = await fetch(`${base}/user`, { headers: { Authorization: 'Bearer stub-token' } })
    expect(await user.json()).toEqual({ login: 'stub-user' })

    const repo = await fetch(`${base}/repos/acme/widgets`)
    expect((await repo.json()).fork).toBe(false)

    expect(readLog(stub.logPath).map((r) => r.path)).toContain('/search/issues?q=repo%3Aacme%2Fwidgets')
    expect(readFileSync(stub.logPath, 'utf-8')).not.toContain('stub-token')
  }, TIMEOUT)
})
