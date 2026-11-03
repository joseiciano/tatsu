import { execFileSync, spawnSync } from 'node:child_process'
import { createCipheriv, createDecipheriv, pbkdf2Sync } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

const REPO_ROOT = fileURLToPath(new URL('../..', import.meta.url))
const TOOL = join(process.env.CARGO_TARGET_DIR ?? join(REPO_ROOT, 'target'), 'debug', 'examples', 'oscrypt_tool')

type Flavor = 'mac' | 'linux'

const PASSWORDS: Record<Flavor, string> = {
  mac: 'dGVzdC1rZXljaGFpbi1wd2Q=',
  linux: 'linux-secret-service-pw'
}

const VALUES: Record<string, string> = {
  githubToken: 'ghp_node-reference-é',
  wsAuthToken: 'a'.repeat(64),
  'backend-token:abc': 'backend-token-value',
  short: 'x',
  fullBlock: '0123456789abcdef'
}

function oscryptKey(password: string, iterations: number): Buffer {
  return pbkdf2Sync(password, 'saltysalt', iterations, 16, 'sha1')
}

const IV = Buffer.alloc(16, 0x20)

function referenceEncrypt(prefix: 'v10' | 'v11', password: string, iterations: number, plain: string): string {
  const cipher = createCipheriv('aes-128-cbc', oscryptKey(password, iterations), IV)
  return Buffer.concat([Buffer.from(prefix), cipher.update(plain, 'utf8'), cipher.final()]).toString('base64')
}

function referenceDecrypt(blob: string, password: string, iterations: number): { prefix: string; plain: string } {
  const buf = Buffer.from(blob, 'base64')
  const decipher = createDecipheriv('aes-128-cbc', oscryptKey(password, iterations), IV)
  const plain = Buffer.concat([decipher.update(buf.subarray(3)), decipher.final()]).toString('utf8')
  return { prefix: buf.subarray(0, 3).toString('latin1'), plain }
}

function electronEncrypt(flavor: Flavor, plain: string): string {
  return flavor === 'mac'
    ? referenceEncrypt('v10', PASSWORDS.mac, 1003, plain)
    : referenceEncrypt('v11', PASSWORDS.linux, 1, plain)
}

const ROOT = mkdtempSync(join(tmpdir(), 'tatsu-oscrypt-'))
let dirSeq = 0

function freshDir(): string {
  const dir = join(ROOT, `d${dirSeq++}`)
  mkdirSync(dir)
  return dir
}

function writeElectronFile(dir: string, data: Record<string, string>): void {
  writeFileSync(join(dir, 'secrets.enc'), JSON.stringify(data, null, 2), { mode: 0o600 })
}

function readFile(dir: string): Record<string, string> {
  return JSON.parse(readFileSync(join(dir, 'secrets.enc'), 'utf-8'))
}

function rust(
  dir: string,
  flavor: Flavor,
  command: 'write' | 'read',
  input: unknown,
  unavailable = false
): { ok: boolean; stdout: string; stderr: string; result?: Record<string, string | null> } {
  const args = [dir, flavor, command, ...(unavailable ? ['--unavailable'] : [])]
  const run = spawnSync(TOOL, args, {
    input: JSON.stringify(input),
    encoding: 'utf8',
    env: { ...process.env, OSCRYPT_TEST_PASSWORD: PASSWORDS[flavor] }
  })
  const resultLine = run.stdout.split('\n').find((line) => line.startsWith('RESULT '))
  return {
    ok: run.status === 0,
    stdout: run.stdout,
    stderr: run.stderr,
    result: resultLine ? JSON.parse(resultLine.slice('RESULT '.length)) : undefined
  }
}

beforeAll(() => {
  execFileSync('cargo', ['build', '-q', '-p', 'tatsu-core', '--example', 'oscrypt_tool'], {
    cwd: REPO_ROOT,
    env: { ...process.env, PATH: `${join(homedir(), '.cargo', 'bin')}:${process.env.PATH ?? ''}` },
    stdio: ['ignore', 'inherit', 'inherit']
  })
}, 300_000)

afterAll(() => {
  rmSync(ROOT, { recursive: true, force: true })
})

describe.each(['mac', 'linux'] as const)('%s OSCrypt', (flavor) => {
  it('Rust decrypts every blob the Node reference wrote', () => {
    const dir = freshDir()
    writeElectronFile(dir, Object.fromEntries(Object.entries(VALUES).map(([k, v]) => [k, electronEncrypt(flavor, v)])))

    const run = rust(dir, flavor, 'read', Object.keys(VALUES))

    expect(run.ok).toBe(true)
    expect(run.result).toEqual(VALUES)
  })

  it('Rust writes the same blobs as the Node reference, and Node decrypts them', () => {
    const dir = freshDir()
    expect(rust(dir, flavor, 'write', VALUES).ok).toBe(true)

    const file = readFile(dir)
    expect(Object.keys(file)).toEqual(Object.keys(VALUES))
    for (const [key, value] of Object.entries(VALUES)) {
      expect(file[key]).toBe(electronEncrypt(flavor, value))
      const decoded =
        flavor === 'mac' ? referenceDecrypt(file[key], PASSWORDS.mac, 1003) : referenceDecrypt(file[key], PASSWORDS.linux, 1)
      expect(decoded).toEqual({ prefix: flavor === 'mac' ? 'v10' : 'v11', plain: value })
    }
  })

  it('an unknown prefix or bad padding reads as absent', () => {
    const dir = freshDir()
    const good = Buffer.from(electronEncrypt(flavor, VALUES.githubToken), 'base64')
    const unknownPrefix = Buffer.concat([Buffer.from('v12'), good.subarray(3)])
    const badPadding = Buffer.from(good)
    badPadding[badPadding.length - 1] ^= 0x01
    writeElectronFile(dir, {
      unknownPrefix: unknownPrefix.toString('base64'),
      badPadding: badPadding.toString('base64'),
      plainText: Buffer.from('ghp_plain').toString('base64')
    })

    const run = rust(dir, flavor, 'read', ['unknownPrefix', 'badPadding', 'plainText'])

    expect(run.ok).toBe(true)
    expect(run.result).toEqual({ unknownPrefix: null, badPadding: null, plainText: null })
    expect(run.stdout).not.toContain(VALUES.githubToken)
  })

  it('without a key store, get is absent, set refuses with the TS log line, and the file is untouched', () => {
    const dir = freshDir()
    writeElectronFile(dir, { githubToken: electronEncrypt(flavor, VALUES.githubToken) })
    const before = readFileSync(join(dir, 'secrets.enc'))

    const read = rust(dir, flavor, 'read', ['githubToken'], true)
    expect(read.result).toEqual({ githubToken: null })

    const write = rust(dir, flavor, 'write', { githubToken: 'ghp_refused-value' }, true)
    expect(write.ok).toBe(false)
    expect(write.stdout).toMatch(
      /^\[\d{2}:\d{2}:\d{2}\.\d{3}\] \[secrets\] safeStorage encryption not available, refusing to store$/m
    )
    expect(write.stdout).not.toContain('ghp_refused-value')
    expect(readFileSync(join(dir, 'secrets.enc')).equals(before)).toBe(true)
  })
})

it('Linux reads the v10 blob Chromium writes with the fixed "peanuts" password', () => {
  const dir = freshDir()
  writeElectronFile(dir, { githubToken: referenceEncrypt('v10', 'peanuts', 1, VALUES.githubToken) })

  expect(rust(dir, 'linux', 'read', ['githubToken']).result).toEqual({ githubToken: VALUES.githubToken })
  expect(rust(dir, 'mac', 'read', ['githubToken']).result).toEqual({ githubToken: null })
})
