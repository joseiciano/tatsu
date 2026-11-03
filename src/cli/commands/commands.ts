import type { AppState } from '../../shared/state'
import type { Output } from '../output'

export interface CommandOption {
  type: 'string' | 'boolean'
  description: string
  short?: string
  multiple?: boolean
  valueName?: string
}

export interface GlobalOptions {
  json: boolean
  url?: string
  token?: string
  timeoutMs?: number
}

export interface TatsuClient {
  readonly endpoint: { url: string; source: string }
  snapshot(): Promise<AppState>
  request<T = unknown>(name: string, ...args: unknown[]): Promise<T>
  close(): void
}

export interface CommandContext {
  values: Record<string, string | boolean | (string | boolean)[] | undefined>
  positionals: string[]
  globals: GlobalOptions
  env: Readonly<Record<string, string | undefined>>
  client(): Promise<TatsuClient>
  output: Output
}

export interface Command {
  name: string
  summary: string
  usage: string
  options: Record<string, CommandOption>
  run(ctx: CommandContext): Promise<void> | void
}

export const commands: readonly Command[] = []

export interface CommandMatch {
  command: Command
  rest: string[]
}

export function findCommand(registry: readonly Command[], positionals: readonly string[]): CommandMatch | undefined {
  for (let n = positionals.length; n > 0; n--) {
    const name = positionals.slice(0, n).join(' ')
    const command = registry.find((c) => c.name === name)
    if (command) return { command, rest: positionals.slice(n) }
  }
  return undefined
}
