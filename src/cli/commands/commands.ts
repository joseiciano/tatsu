import type { TatsuClient } from '../client'
import type { Output } from '../output'
import { diffCommand } from './diff'
import { newCommand } from './new'
import { statusCommand } from './status'
import { worktreesCommand } from './worktrees'

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
  defaultTimeoutMs?: number
  run(ctx: CommandContext): Promise<void> | void
}

export const commands: readonly Command[] = [statusCommand, worktreesCommand, newCommand, diffCommand]

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
