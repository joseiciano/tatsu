import { join } from 'node:path'
import { CliError } from '../errors'

export type EndpointSource = 'flag' | 'env' | (string & {})

export interface ResolvedEndpoint {
  url: string
  token: string
  source: EndpointSource
}

export interface EndpointFlags {
  url?: string
  token?: string
}

export interface EndpointIO {
  env: Readonly<Record<string, string | undefined>>
  readFile: (path: string) => Promise<string>
  homedir: () => string
  platform: NodeJS.Platform
  isPidAlive: (pid: number) => boolean
}

const ENDPOINT_FILE_NAME = 'cli-endpoint.json'
const DESKTOP_APP_DIRS = ['Harness', 'Harness (Dev)']

const HELP_HINT = "Run 'tatsu --help' for usage."

function nonEmpty(value: string | undefined): string | undefined {
  return value === undefined || value === '' ? undefined : value
}

function displayUrl(raw: string, label: string): string {
  let parsed: URL
  try {
    parsed = new URL(raw)
  } catch {
    throw new CliError('usage', `${label} is not a valid URL. ${HELP_HINT}`)
  }
  if (parsed.protocol !== 'ws:' && parsed.protocol !== 'wss:') {
    throw new CliError('usage', `${label} must be a ws:// or wss:// URL. ${HELP_HINT}`)
  }
  if (!parsed.searchParams.has('token')) return raw
  parsed.searchParams.delete('token')
  return parsed.toString()
}

export function describeSource(source: EndpointSource): string {
  if (source === 'flag') return '--url/--token'
  if (source === 'env') return 'TATSU_URL/TATSU_TOKEN'
  return source
}

export async function resolveEndpoint(flags: EndpointFlags, io: EndpointIO): Promise<ResolvedEndpoint> {
  const flagUrl = nonEmpty(flags.url)
  const flagToken = nonEmpty(flags.token)
  if (flagUrl || flagToken) {
    if (!flagUrl || !flagToken) throw new CliError('usage', `--url and --token must be passed together. ${HELP_HINT}`)
    return { url: displayUrl(flagUrl, '--url'), token: flagToken, source: 'flag' }
  }

  const envUrl = nonEmpty(io.env.TATSU_URL)
  if (envUrl) {
    const envToken = nonEmpty(io.env.TATSU_TOKEN)
    if (!envToken) throw new CliError('usage', `TATSU_URL is set but TATSU_TOKEN is not. ${HELP_HINT}`)
    return { url: displayUrl(envUrl, 'TATSU_URL'), token: envToken, source: 'env' }
  }

  const staleFiles: string[] = []
  for (const path of candidateFiles(io)) {
    const file = await readEndpointFile(io, path)
    if (!file) continue
    if (!io.isPidAlive(file.pid)) {
      staleFiles.push(path)
      continue
    }
    return { url: file.url, token: file.token, source: path }
  }
  throw notRunning(staleFiles)
}

function desktopConfigDir(io: EndpointIO): string | undefined {
  if (io.platform === 'darwin') return join(io.homedir(), 'Library', 'Application Support')
  if (io.platform === 'linux') return nonEmpty(io.env.XDG_CONFIG_HOME) ?? join(io.homedir(), '.config')
  return undefined
}

export function candidateFiles(io: EndpointIO): string[] {
  const candidates: string[] = []
  const explicit = nonEmpty(io.env.TATSU_ENDPOINT_FILE)
  if (explicit) candidates.push(explicit)
  const dataDir = nonEmpty(io.env.HARNESS_DATA_DIR)
  if (dataDir) candidates.push(join(dataDir, ENDPOINT_FILE_NAME))
  candidates.push(join(io.homedir(), '.harness', ENDPOINT_FILE_NAME))
  const desktopDir = desktopConfigDir(io)
  if (desktopDir) candidates.push(...DESKTOP_APP_DIRS.map((app) => join(desktopDir, app, ENDPOINT_FILE_NAME)))
  return [...new Set(candidates)]
}

interface EndpointFile {
  url: string
  token: string
  pid: number
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isWsUrl(value: unknown): value is string {
  if (typeof value !== 'string') return false
  try {
    const { protocol } = new URL(value)
    return protocol === 'ws:' || protocol === 'wss:'
  } catch {
    return false
  }
}

export function parseEndpointFile(text: string): EndpointFile | undefined {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return undefined
  }
  if (!isRecord(parsed) || parsed.version !== 1) return undefined
  const { url, token, pid } = parsed
  if (!isWsUrl(url) || typeof token !== 'string' || token === '') return undefined
  if (typeof pid !== 'number' || !Number.isSafeInteger(pid) || pid <= 0) return undefined
  return { url, token, pid }
}

async function readEndpointFile(io: EndpointIO, path: string): Promise<EndpointFile | undefined> {
  let text: string
  try {
    text = await io.readFile(path)
  } catch {
    return undefined
  }
  return parseEndpointFile(text)
}

function notRunning(staleFiles: string[]): CliError {
  const reason = staleFiles.length
    ? `stale endpoint file${staleFiles.length > 1 ? 's' : ''} at ${staleFiles.join(', ')}`
    : 'no endpoint file found'
  return new CliError(
    'not-running',
    `Tatsu is not running (${reason}). Start harness-server, or enable the desktop app's WebSocket transport ` +
      `("wsTransportEnabled": true in its config.json, or launch it with HARNESS_WS_TRANSPORT=1), ` +
      'or pass --url and --token (or set TATSU_URL and TATSU_TOKEN).',
    { staleFiles }
  )
}

export function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    return err instanceof Error && 'code' in err && err.code === 'EPERM'
  }
}
