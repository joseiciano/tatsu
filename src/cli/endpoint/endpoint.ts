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
}

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

  throw new CliError(
    'not-running',
    'Tatsu is not running: no endpoint found. Start harness-server, or pass --url and --token (or set TATSU_URL and TATSU_TOKEN).'
  )
}
