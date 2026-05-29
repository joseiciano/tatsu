import { shellQuote } from './shell-quote'
import type { TerminalAgentId } from '../shared/terminal-agents'

export interface GenericSpawnOpts {
  command: string
  model?: string | null
  initialPrompt?: string
  supportsPrompt?: boolean
  supportsModel?: boolean
  assignsSessionId?: boolean
  sessionId?: string
}

export function buildGenericSpawnArgs(opts: GenericSpawnOpts): string {
  let cmd = opts.command

  // Append --model if model is present, supportsModel is not false, and command does not already include --model or -m
  if (opts.model && opts.supportsModel !== false && !opts.command.includes('--model') && !opts.command.includes('-m ')) {
    cmd += ` --model ${shellQuote(opts.model)}`
  }

  // Append --session-id if assignsSessionId is true, sessionId exists, and command does not already include --session-id
  if (opts.assignsSessionId === true && opts.sessionId && !opts.command.includes('--session-id')) {
    cmd += ` --session-id ${shellQuote(opts.sessionId)}`
  }

  // Append shell-quoted initialPrompt if present and agent supports prompts
  if (opts.initialPrompt && opts.supportsPrompt !== false) {
    cmd += ` ${shellQuote(opts.initialPrompt)}`
  }

  return cmd
}
