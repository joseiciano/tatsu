import * as nodeFs from 'fs'
import { randomBytes } from 'crypto'
import { basename, dirname, join } from 'path'
import { formatErr, log as debugLog } from '../debug'
import { userDataDir } from '../paths'

export const CLI_ENDPOINT_FILE_NAME = 'cli-endpoint.json'
export const CLI_ENDPOINT_VERSION = 1

type EndpointFs = Pick<typeof nodeFs, 'writeFileSync' | 'chmodSync' | 'renameSync' | 'readFileSync' | 'unlinkSync'>

export interface CliEndpointDeps {
  path?: string
  fs?: EndpointFs
  log?: (category: string, message: string, data?: unknown) => void
  pid?: number
  now?: () => number
}

export interface CliEndpointFile {
  version: typeof CLI_ENDPOINT_VERSION
  url: string
  token: string
  pid: number
  startedAt: number
}

const LOOPBACK_BIND_HOSTS = new Set(['', '0.0.0.0', '127.0.0.1', 'localhost', '::'])

export function cliEndpointPath(): string {
  return join(userDataDir(), CLI_ENDPOINT_FILE_NAME)
}

export function endpointUrl(port: number, bindHost: string): string {
  if (LOOPBACK_BIND_HOSTS.has(bindHost)) return `ws://127.0.0.1:${port}`
  const host = bindHost.includes(':') ? `[${bindHost}]` : bindHost
  return `ws://${host}:${port}`
}

function isEnoent(err: unknown): boolean {
  return err instanceof Error && 'code' in err && err.code === 'ENOENT'
}

export function writeCliEndpoint(
  { port, token, bindHost }: { port: number; token: string; bindHost: string },
  deps: CliEndpointDeps = {}
): void {
  const fs = deps.fs ?? nodeFs
  const log = deps.log ?? debugLog
  const pid = deps.pid ?? process.pid
  let path: string | undefined
  let tmp: string | undefined
  try {
    path = deps.path ?? cliEndpointPath()
    const file: CliEndpointFile = {
      version: CLI_ENDPOINT_VERSION,
      url: endpointUrl(port, bindHost),
      token,
      pid,
      startedAt: (deps.now ?? Date.now)()
    }
    tmp = join(dirname(path), `.${basename(path)}.${pid}.${randomBytes(4).toString('hex')}.tmp`)
    fs.writeFileSync(tmp, `${JSON.stringify(file)}\n`, { mode: 0o600, flag: 'wx' })
    fs.chmodSync(tmp, 0o600)
    fs.renameSync(tmp, path)
    log('cli-endpoint', `wrote ${path}`)
  } catch (err) {
    log('cli-endpoint', `write failed for ${path ?? CLI_ENDPOINT_FILE_NAME}: ${formatErr(err)}`)
    if (tmp) {
      try {
        fs.unlinkSync(tmp)
      } catch {
        // temp file was never created
      }
    }
  }
}

export function removeCliEndpoint(deps: CliEndpointDeps = {}): void {
  const fs = deps.fs ?? nodeFs
  const log = deps.log ?? debugLog
  const pid = deps.pid ?? process.pid
  let path: string | undefined
  try {
    path = deps.path ?? cliEndpointPath()
    let owner: unknown
    try {
      owner = (JSON.parse(fs.readFileSync(path, 'utf8')) as { pid?: unknown } | null)?.pid
    } catch (err) {
      if (isEnoent(err)) return
      log('cli-endpoint', `left ${path} in place: unreadable (${formatErr(err)})`)
      return
    }
    if (owner !== pid) {
      log('cli-endpoint', `left ${path} in place: owned by pid ${String(owner)}`)
      return
    }
    fs.unlinkSync(path)
    log('cli-endpoint', `removed ${path}`)
  } catch (err) {
    log('cli-endpoint', `remove failed for ${path ?? CLI_ENDPOINT_FILE_NAME}: ${formatErr(err)}`)
  }
}
