import { log as debugLog } from '../debug'

export const DEFAULT_GITHUB_API_BASE = 'https://api.github.com'

const LOOPBACK_HOSTNAMES: ReadonlySet<string> = new Set(['127.0.0.1', 'localhost', '[::1]'])

type Logger = (category: string, message: string) => void

export function resolveGithubApiBase(raw: string | undefined, log: Logger = debugLog): string {
  if (raw === undefined || raw === '') return DEFAULT_GITHUB_API_BASE
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    log('github', 'HARNESS_GITHUB_API_URL ignored: not a valid URL')
    return DEFAULT_GITHUB_API_BASE
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    log('github', 'HARNESS_GITHUB_API_URL ignored: only http and https are allowed')
    return DEFAULT_GITHUB_API_BASE
  }
  if (url.username !== '' || url.password !== '') {
    log('github', 'HARNESS_GITHUB_API_URL ignored: credentials are not allowed')
    return DEFAULT_GITHUB_API_BASE
  }
  if (!LOOPBACK_HOSTNAMES.has(url.hostname)) {
    log('github', `HARNESS_GITHUB_API_URL ignored: host ${url.hostname} is not loopback`)
    return DEFAULT_GITHUB_API_BASE
  }
  return url.origin
}

export const GITHUB_API_BASE = resolveGithubApiBase(process.env.HARNESS_GITHUB_API_URL)

export function githubApiUrl(path: string): string {
  return `${GITHUB_API_BASE}${path}`
}
