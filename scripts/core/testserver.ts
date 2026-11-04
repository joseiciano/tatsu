import { execFileSync, spawn, type ChildProcess } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO_ROOT = fileURLToPath(new URL('../..', import.meta.url))
const BINARY = join(process.env.CARGO_TARGET_DIR ?? join(REPO_ROOT, 'target'), 'debug', 'tatsu-core-testserver')
const URL_LINE = /^ws:\/\/\S+$/m
const START_TIMEOUT_MS = 30_000
const STOP_TIMEOUT_MS = 5_000

export interface TestServer {
  url: string
  token: string
  dataDir: string
  stop: () => Promise<void>
}

function cargoEnv(): NodeJS.ProcessEnv {
  return { ...process.env, PATH: `${join(homedir(), '.cargo', 'bin')}:${process.env.PATH ?? ''}` }
}

export function buildTestServer(): void {
  execFileSync('cargo', ['build', '-q', '-p', 'tatsu-core-testserver'], {
    cwd: REPO_ROOT,
    env: cargoEnv(),
    stdio: ['ignore', 'inherit', 'inherit']
  })
}

function waitForUrl(child: ChildProcess): Promise<string> {
  return new Promise((resolveUrl, reject) => {
    let out = ''
    let err = ''
    const timer = setTimeout(() => fail(new Error(`test server printed no URL within ${START_TIMEOUT_MS}ms`)), START_TIMEOUT_MS)
    const cleanup = (): void => {
      clearTimeout(timer)
      child.stdout?.off('data', onOut)
      child.stderr?.off('data', onErr)
      child.off('exit', onExit)
    }
    const fail = (e: Error): void => {
      cleanup()
      reject(e)
    }
    const onOut = (chunk: Buffer): void => {
      out += chunk.toString()
      const match = URL_LINE.exec(out)
      if (match) {
        cleanup()
        resolveUrl(match[0])
      }
    }
    const onErr = (chunk: Buffer): void => {
      err += chunk.toString()
    }
    const onExit = (code: number | null): void => fail(new Error(`test server exited (${code}) before listening: ${err}`))
    child.stdout?.on('data', onOut)
    child.stderr?.on('data', onErr)
    child.on('exit', onExit)
  })
}

function waitForExit(child: ChildProcess, ms: number): Promise<boolean> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve(true)
  return new Promise((done) => {
    const timer = setTimeout(() => done(false), ms)
    child.once('exit', () => {
      clearTimeout(timer)
      done(true)
    })
  })
}

// The test server runs the login-shell PATH fix on macOS; a passthrough fake
// shell and a temp HOME keep the user's real shell and rc files out of it.
export function passthroughShellHome(): string {
  const home = mkdtempSync(join(tmpdir(), 'tatsu-core-home-'))
  const shell = join(home, 'fake-login-shell')
  writeFileSync(shell, '#!/bin/sh\nexec /bin/sh -c "$2"\n')
  chmodSync(shell, 0o755)
  return home
}

export interface StartOptions {
  dataDir?: string
  tokenInDataDir?: string
  env?: NodeJS.ProcessEnv
}

export async function startTestServer(opts: StartOptions = {}): Promise<TestServer> {
  const ownsDataDir = opts.dataDir === undefined
  const dataDir = opts.dataDir ?? mkdtempSync(join(tmpdir(), 'tatsu-core-parity-'))
  const home = passthroughShellHome()
  const token = opts.tokenInDataDir ?? randomBytes(24).toString('hex')
  const tokenArgs = opts.tokenInDataDir === undefined ? ['--token', token] : []
  const child = spawn(BINARY, ['--data-dir', dataDir, ...tokenArgs, '--test-hooks', '--port', '0'], {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...(opts.env ?? process.env), HOME: home, SHELL: join(home, 'fake-login-shell') }
  })
  const stop = async (): Promise<void> => {
    child.kill('SIGINT')
    if (!(await waitForExit(child, STOP_TIMEOUT_MS))) {
      child.kill('SIGKILL')
      await waitForExit(child, STOP_TIMEOUT_MS)
    }
    if (ownsDataDir) rmSync(dataDir, { recursive: true, force: true })
    rmSync(home, { recursive: true, force: true })
  }
  try {
    const url = await waitForUrl(child)
    child.stdout?.resume()
    child.stderr?.resume()
    return { url, token, dataDir, stop }
  } catch (e) {
    await stop()
    throw e
  }
}
