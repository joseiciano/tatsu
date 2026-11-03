import { execFileSync, spawnSync } from 'node:child_process'
import { cpSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import { createRequire } from 'node:module'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, expect, it, vi } from 'vitest'

const REPO_ROOT = fileURLToPath(new URL('../..', import.meta.url))
function keytarResolvable(): boolean {
  try {
    createRequire(join(REPO_ROOT, 'src', 'main', 'secrets', 'secrets.ts')).resolve('keytar')
    return true
  } catch {
    return false
  }
}

if (keytarResolvable()) {
  throw new Error('keytar is installed: the TS secrets backend would use the real OS keychain, refusing to run')
}

const TOOL = join(process.env.CARGO_TARGET_DIR ?? join(REPO_ROOT, 'target'), 'debug', 'examples', 'secrets_tool')

const VALUES: Record<string, string> = {
  githubToken: 'ghp_node-written-é',
  wsAuthToken: 'a'.repeat(64),
  'backend-token:abc': 'backend-token-value',
  openaiApiKey: 'sk-openai-value'
}

const ROOT = mkdtempSync(join(tmpdir(), 'tatsu-secrets-'))
let dirSeq = 0

function freshDir(): string {
  return join(ROOT, `d${dirSeq++}`)
}

function cargoEnv(): NodeJS.ProcessEnv {
  return { ...process.env, PATH: `${join(homedir(), '.cargo', 'bin')}:${process.env.PATH ?? ''}` }
}

type NodeSecrets = typeof import('../../src/main/secrets')

async function nodeSecrets(dir: string): Promise<NodeSecrets> {
  process.env.HARNESS_DATA_DIR = dir
  vi.resetModules()
  const paths = await import('../../src/main/paths')
  if (paths.userDataDir() !== dir) throw new Error('TS secrets would not use the temp data dir')
  return import('../../src/main/secrets')
}

function rust(dir: string, args: string[], input?: unknown): { ok: boolean; stderr: string } {
  const result = spawnSync(TOOL, [dir, ...args], {
    input: input === undefined ? '' : JSON.stringify(input),
    encoding: 'utf8'
  })
  return { ok: result.status === 0, stderr: result.stderr }
}

function mode(path: string): number {
  return statSync(path).mode & 0o777
}

beforeAll(() => {
  execFileSync('cargo', ['build', '-q', '-p', 'tatsu-core', '--example', 'secrets_tool'], {
    cwd: REPO_ROOT,
    env: cargoEnv(),
    stdio: ['ignore', 'inherit', 'inherit']
  })
}, 300_000)

afterAll(() => {
  rmSync(ROOT, { recursive: true, force: true })
})

it('Rust decrypts every key the Node file backend wrote', async () => {
  const dir = freshDir()
  const node = await nodeSecrets(dir)
  for (const [key, value] of Object.entries(VALUES)) node.setSecret(key, value)

  expect(rust(dir, ['verify'], VALUES)).toEqual({ ok: true, stderr: '' })
  expect(rust(dir, ['verify'], { ...VALUES, githubToken: 'wrong' }).ok).toBe(false)
})

it('Node decrypts every key the Rust file backend wrote', async () => {
  const dir = freshDir()
  expect(rust(dir, ['write'], VALUES).ok).toBe(true)

  const node = await nodeSecrets(dir)
  for (const [key, value] of Object.entries(VALUES)) {
    expect(node.hasSecret(key)).toBe(true)
    expect(node.getSecret(key)).toBe(value)
  }
  expect(mode(join(dir, 'secrets.enc'))).toBe(0o600)
  expect(mode(join(dir, '.secret-key'))).toBe(0o600)
})

it('Rust updates a Node file without breaking the keys it did not touch', async () => {
  const dir = freshDir()
  const node = await nodeSecrets(dir)
  for (const [key, value] of Object.entries(VALUES)) node.setSecret(key, value)

  expect(rust(dir, ['write'], { githubToken: 'ghp_rust-rotated' }).ok).toBe(true)

  const reread = await nodeSecrets(dir)
  expect(reread.getSecret('githubToken')).toBe('ghp_rust-rotated')
  for (const key of ['wsAuthToken', 'backend-token:abc', 'openaiApiKey']) {
    expect(reread.getSecret(key)).toBe(VALUES[key])
  }
})

it('Rust deletes produce the same secrets.enc bytes as Node deletes', async () => {
  const rustDir = freshDir()
  const nodeDir = freshDir()
  const node = await nodeSecrets(rustDir)
  for (const [key, value] of Object.entries(VALUES)) node.setSecret(key, value)
  cpSync(rustDir, nodeDir, { recursive: true })
  const written = readFileSync(join(rustDir, 'secrets.enc'))

  expect(rust(rustDir, ['delete', 'never-set']).ok).toBe(true)
  expect(readFileSync(join(rustDir, 'secrets.enc')).equals(written)).toBe(true)

  expect(rust(rustDir, ['delete', 'wsAuthToken']).ok).toBe(true)
  ;(await nodeSecrets(nodeDir)).deleteSecret('wsAuthToken')

  expect(readFileSync(join(rustDir, 'secrets.enc')).equals(readFileSync(join(nodeDir, 'secrets.enc')))).toBe(true)
})
