import type { StateEvent } from '../../../src/shared/state'
import type { Worktree } from '../../../src/shared/state/worktrees'

export const CASE_ROOT_TOKEN = '$CASE'

export type HandlerReply = { value: unknown } | { noValue: true } | { error: string }

export interface LogLine {
  file: 'debug.log' | 'perf.log'
  line: string
}

export interface HandlerExpected {
  configAfter: string | null
  events: StateEvent[]
  reply?: HandlerReply
  repoFilesAfter?: Record<string, string | null>
  activityAfter?: string | null
  secretsAfter?: Record<string, string | null>
  logLines?: LogLine[]
}

export interface HandlerCase {
  name: string
  now: number
  kind: 'request' | 'signal' | 'event'
  channel?: string
  args?: unknown[]
  event?: StateEvent
  configBefore: string
  setup?: StateEvent[]
  themesDir?: string
  repoFiles?: Record<string, string | null>
  activityBefore?: string
  secretsBefore?: Record<string, string | null>
  ids?: string[]
  randomBytes?: string[]
  debugLogBefore?: string
  hooksInstaller?: 'ok' | 'throw'
  worktrees?: Worktree[]
  wsBound?: { host: string; port: number } | null
  expected?: HandlerExpected
}
