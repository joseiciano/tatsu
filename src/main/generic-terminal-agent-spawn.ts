import { shellQuote } from './shell-quote'
import type { TerminalAgentId } from '../shared/terminal-agents'

export interface GenericSpawnOpts {
  command: string
  model?: string | null
  initialPrompt?: string
  supportsPrompt?: boolean
}

export function buildGenericSpawnArgs(opts: GenericSpawnOpts): string {
  let cmd = opts.command

  // Append --model if model is present and command does not already include --model or -m
  if (opts.model && !opts.command.includes('--model') && !opts.command.includes('-m ')) {
    cmd += ` --model ${shellQuote(opts.model)}`
  }

  // Append shell-quoted initialPrompt if present and agent supports prompts
  if (opts.initialPrompt && opts.supportsPrompt !== false) {
    cmd += ` ${shellQuote(opts.initialPrompt)}`
  }

  return cmd
}
