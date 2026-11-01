import { formatTemplateRef, renderTemplate, tokenizeTemplate, type TemplateScope } from '../../../shared/workflow-def'
import type { TerminalTab } from '../../../shared/state/terminals'
import type { StepSpawnExtras } from '../../agent-spawn'
import {
  StepStartError,
  type StepAttempt,
  type StepDriver,
  type StepDriverListener,
  type StepExecution
} from './types'

export const MAX_INTERPOLATED_VALUE_BYTES = 128 * 1024
export const MAX_INTERPOLATED_TOTAL_BYTES = 512 * 1024
export const SHELL_SUMMARY_LINES = 50
export const SHELL_SUMMARY_MAX_BYTES = 16 * 1024
export const SHELL_ENV_PREFIX = 'HARNESS_WF_'
export const SHELL_CANCEL_SIGNAL = 'SIGHUP'

export const SHELL_START_SUMMARIES = {
  empty: 'shell step has no command',
  tooLarge: 'interpolated value too large',
  nul: 'interpolated value contains NUL',
  malformed: 'interpolated value is not valid text',
  unsupported: 'template reference in an unsupported shell context',
  spawnFailed: 'shell failed to start'
} as const

export interface ShellCommand {
  command: string
  env: Record<string, string>
}

type Frame =
  | { kind: 'cmd'; depth: number }
  | { kind: 'double' }
  | { kind: 'single' }
  | { kind: 'ansi' }
  | { kind: 'backtick' }
  | { kind: 'param'; depth: number }
  | { kind: 'arith'; depth: number }

type RefContext = 'unquoted' | 'double' | 'unsupported'

const WORD_BOUNDARY = new Set([' ', '\t', '\n', ';', '&', '|', '(', ')', '<', '>'])
const COMMENT_START = new Set([' ', '\t', '\n', ';', '&', '|', '(', '<', '>'])

class QuoteScanner {
  private readonly stack: Frame[] = [{ kind: 'cmd', depth: 0 }]
  private escaped = false
  private comment = false
  private lost = false
  private dangling = false
  private prev = '\n'
  private wordRisky = false

  feed(text: string): void {
    for (let i = 0; i < text.length; i++) {
      const c = text[i]
      if (this.escaped) {
        this.escaped = false
        this.dangling = false
        this.prev = 'x'
        continue
      }
      if (this.comment) {
        if (c === '\n') this.comment = false
        this.prev = c
        continue
      }
      const before = this.top()
      if (before.kind === 'cmd') this.trackWord(text, i)
      const end = this.step(text, i)
      const kind = this.top().kind
      this.dangling = end === i && c === '$' && i === text.length - 1 && (kind === 'cmd' || kind === 'double')
      i = end
      this.prev = text[i]
    }
  }

  context(): RefContext {
    if (this.lost || this.comment || this.escaped || this.dangling) return 'unsupported'
    if (this.stack.some((frame) => frame.kind === 'cmd' && frame.depth > 0)) return 'unsupported'
    const top = this.top()
    if (top.kind === 'cmd') return this.wordRisky ? 'unsupported' : 'unquoted'
    if (top.kind === 'double') return 'double'
    return 'unsupported'
  }

  balanced(): boolean {
    return !this.lost && !this.escaped && this.stack.length === 1 && this.stack[0].kind === 'cmd' && this.stack[0].depth === 0
  }

  afterRef(): void {
    this.prev = 'x'
    this.dangling = false
  }

  private top(): Frame {
    return this.stack[this.stack.length - 1]
  }

  private trackWord(text: string, i: number): void {
    const c = text[i]
    if (WORD_BOUNDARY.has(c)) {
      this.wordRisky = false
      return
    }
    const wordStart = WORD_BOUNDARY.has(this.prev)
    if ((c === '~' && (wordStart || this.prev === '=' || this.prev === ':')) || (wordStart && c === '=')) {
      this.wordRisky = true
    }
    else if (wordStart) this.wordRisky = false
    if (wordStart && this.stack.length > 1 && /^case(?:[\s;&|()<>]|$)/.test(text.slice(i, i + 5))) this.lost = true
  }

  private step(text: string, i: number): number {
    const c = text[i]
    const next = text[i + 1]
    const top = this.top()
    switch (top.kind) {
      case 'single':
        if (c === "'") this.stack.pop()
        return i
      case 'ansi':
        if (c === '\\') this.escaped = true
        else if (c === "'") this.stack.pop()
        return i
      case 'backtick':
        if (c === '\\') this.escaped = true
        else if (c === '`') this.stack.pop()
        else if (c === "'" || c === '"') this.lost = true
        return i
      case 'param':
        if (c === '\\') this.escaped = true
        else if (c === "'" || c === '"' || c === '`' || c === '$') this.lost = true
        else if (c === '{') top.depth++
        else if (c === '}' && top.depth === 0) this.stack.pop()
        else if (c === '}') top.depth--
        return i
      case 'arith':
        if (c === "'" || c === '"' || c === '`' || c === '\\' || (c === '$' && next === '(')) this.lost = true
        else if (c === '(') top.depth++
        else if (c === ')' && top.depth === 0 && next === ')') {
          this.stack.pop()
          return i + 1
        } else if (c === ')' && top.depth > 0) top.depth--
        return i
      case 'double':
        if (c === '\\') this.escaped = true
        else if (c === '"') this.stack.pop()
        else return this.expansion(text, i)
        return i
      case 'cmd':
        return this.command(top, text, i)
      default: {
        const _exhaustive: never = top
        return _exhaustive
      }
    }
  }

  private command(top: { kind: 'cmd'; depth: number }, text: string, i: number): number {
    const c = text[i]
    const next = text[i + 1]
    if (c === '\\') this.escaped = true
    else if (c === "'") this.stack.push({ kind: 'single' })
    else if (c === '"') this.stack.push({ kind: 'double' })
    else if (c === '#' && this.prev === ')') this.lost = true
    else if (c === '#' && COMMENT_START.has(this.prev)) this.comment = true
    else if (c === '<' && next === '<') {
      if (text[i + 2] === '<') return i + 2
      this.lost = true
      return i + 1
    } else if (c === '(' && next === '(') {
      this.stack.push({ kind: 'arith', depth: 0 })
      return i + 1
    } else if (c === '(') top.depth++
    else if (c === ')' && top.depth > 0) top.depth--
    else if (c === ')' && this.stack.length > 1) this.stack.pop()
    else if (c === '$' && next === "'") {
      this.stack.push({ kind: 'ansi' })
      return i + 1
    } else return this.expansion(text, i)
    return i
  }

  private expansion(text: string, i: number): number {
    const c = text[i]
    const next = text[i + 1]
    if (c === '`') {
      this.stack.push({ kind: 'backtick' })
      return i
    }
    if (c !== '$') return i
    if (next === '[') this.lost = true
    if (next === '(' && text[i + 2] === '(') {
      this.stack.push({ kind: 'arith', depth: 0 })
      return i + 2
    }
    if (next === '(') {
      this.stack.push({ kind: 'cmd', depth: 0 })
      return i + 1
    }
    if (next === '{') {
      this.stack.push({ kind: 'param', depth: 0 })
      return i + 1
    }
    return i
  }
}

const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/

function envEntryBytes(name: string, value: string): number {
  if (value.includes('\0')) throw new StepStartError(SHELL_START_SUMMARIES.nul)
  if (LONE_SURROGATE.test(value)) throw new StepStartError(SHELL_START_SUMMARIES.malformed)
  const bytes = Buffer.byteLength(`${name}=${value}\0`, 'utf8')
  if (bytes > MAX_INTERPOLATED_VALUE_BYTES) throw new StepStartError(SHELL_START_SUMMARIES.tooLarge)
  return bytes
}

/**
 * Turns a shell step's `run` text into a command plus env without splicing
 * any interpolated value into the command string.
 *
 * Each distinct `{{...}}` reference gets one variable `HARNESS_WF_<n>` holding
 * its rendered value (empty when missing, so an inherited variable cannot
 * fill the slot). The literal text is the author's code and is kept as
 * written. A reference is replaced by a form chosen from the shell quote
 * context the author's text leaves it in:
 * - unquoted: `"${HARNESS_WF_n}"`
 * - inside the author's `"..."`: `${HARNESS_WF_n}` (still one quoted word)
 * - inside `$(...)`: the rules above apply afresh to the substitution
 *
 * Every other position fails closed with `StepStartError`: inside `'...'`
 * (the text often reaches a second shell, which would expand it unquoted),
 * comments, backticks, `${...}`, `$((...))`, `((...))`, `$[...]`, `$'...'` or
 * any `(...)` group (zsh glob qualifiers run code); in a word starting with
 * `=` or `~`, or where `~` follows `=` or `:` (zsh path and tilde
 * expansion); directly after a backslash or `$`. Constructs the scanner does not model make every
 * later reference fail: a heredoc `<<`, `case` inside a substitution, quotes
 * inside `${...}`, `$((...))` or backticks, `#` straight after `)`, and a run
 * that ends with an open quote or group.
 *
 * The value arrives as one literal word; what the author's code then does
 * with that word is the author's responsibility. Do not hand untrusted values
 * to another interpreter (`sh -c "..."`, `ssh`, `eval`, `trap`, `xargs sh`),
 * to arithmetic (`let`, `declare -i`, `[[ -eq ]]`, `[[ -v ]]`, array
 * subscripts), in command position, or as an option a program may parse
 * (end options with `--`).
 *
 * A value containing NUL or an unpaired UTF-16 surrogate, a `NAME=value` env
 * entry over `MAX_INTERPOLATED_VALUE_BYTES` (the Linux per-string limit),
 * entries totalling over `MAX_INTERPOLATED_TOTAL_BYTES`, and a blank `run`
 * also throw `StepStartError`, with a summary that never includes the value.
 */
export function buildShellCommand(run: string, scope: TemplateScope): ShellCommand {
  if (run.trim() === '') throw new StepStartError(SHELL_START_SUMMARIES.empty)
  const scanner = new QuoteScanner()
  const env: Record<string, string> = {}
  const names = new Map<string, string>()
  let command = ''
  let total = 0
  for (const token of tokenizeTemplate(run)) {
    if (token.kind !== 'ref') {
      const text = token.kind === 'text' ? token.text : token.raw
      scanner.feed(text)
      command += text
      continue
    }
    const context = scanner.context()
    if (context === 'unsupported') throw new StepStartError(SHELL_START_SUMMARIES.unsupported)
    const key = formatTemplateRef(token.ref)
    let name = names.get(key)
    if (name === undefined) {
      const value = renderTemplate(token.raw, scope).text
      name = `${SHELL_ENV_PREFIX}${names.size}`
      total += envEntryBytes(name, value)
      if (total > MAX_INTERPOLATED_TOTAL_BYTES) throw new StepStartError(SHELL_START_SUMMARIES.tooLarge)
      names.set(key, name)
      env[name] = value
    }
    command += context === 'unquoted' ? `"\${${name}}"` : `\${${name}}`
    scanner.afterRef()
  }
  if (names.size > 0 && !scanner.balanced()) throw new StepStartError(SHELL_START_SUMMARIES.unsupported)
  return { command, env }
}

const ANSI_SEQUENCE =
  /\u001b\][\s\S]*?(?:\u0007|\u001b\\)|\u001b[P^_X][\s\S]*?\u001b\\|\u001b\[[0-?]*[ -/]*[@-~]|\u001b[ -/]*[0-~]?/g
const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g

function overwriteCarriageReturns(line: string): string {
  const cells: string[] = []
  for (const segment of line.split('\r')) {
    const chars = [...segment]
    for (let i = 0; i < chars.length; i++) cells[i] = chars[i]
  }
  return cells.join('')
}

function utf8Tail(text: string, maxBytes: number): string {
  const bytes = Buffer.from(text, 'utf8')
  if (bytes.length <= maxBytes) return text
  let start = bytes.length - maxBytes
  while (start < bytes.length && (bytes[start] & 0xc0) === 0x80) start++
  return bytes.subarray(start).toString('utf8')
}

export function summarizeShellOutput(raw: string): string {
  const summary = raw
    .replace(ANSI_SEQUENCE, '')
    .split('\n')
    .map((line) => overwriteCarriageReturns(line).replace(CONTROL, ''))
    .filter((line) => line.trim() !== '')
    .slice(-SHELL_SUMMARY_LINES)
    .join('\n')
  return utf8Tail(summary, SHELL_SUMMARY_MAX_BYTES)
}

export interface ShellStepDriverDeps {
  addTab(worktreePath: string, tab: TerminalTab, spawn: StepSpawnExtras): void
  hasTerminal(id: string): boolean
  getHistory(id: string): string
  onExit(listener: (id: string, exitCode: number, signal?: number) => void): () => void
  kill(id: string, signal: typeof SHELL_CANCEL_SIGNAL): void
  newTabId(): string
}

export interface ShellStepDriver extends StepDriver {
  start(attempt: StepAttempt): StepExecution
  dispose(): void
}

export function createShellStepDriver(deps: ShellStepDriverDeps): ShellStepDriver {
  const listeners = new Set<StepDriverListener>()
  const owned = new Set<string>()
  const unsubscribeExit = deps.onExit((id, exitCode, signal) => {
    if (!owned.delete(id)) return
    const summary = summarizeShellOutput(deps.getHistory(id))
    const code = signal ? null : exitCode
    for (const listener of [...listeners]) listener({ type: 'exited', executionId: id, code, summary })
  })

  return {
    start(attempt: StepAttempt): StepExecution {
      const { step, runId, stepId, attemptId, worktreePath, scope } = attempt
      if (step.kind !== 'shell') throw new StepStartError('not a shell step')
      const { command, env } = buildShellCommand(step.run, scope)
      const id = deps.newTabId()
      const tab: TerminalTab = {
        id,
        type: 'shell',
        label: `⚙ ${stepId} · shell`,
        workflow: { runId, stepId, attemptId }
      }
      owned.add(id)
      deps.addTab(worktreePath, tab, { command, env })
      if (!deps.hasTerminal(id)) {
        owned.delete(id)
        throw new StepStartError(SHELL_START_SUMMARIES.spawnFailed)
      }
      return { executionId: id }
    },
    continue() {},
    cancel(executionId: string) {
      if (owned.delete(executionId)) deps.kill(executionId, SHELL_CANCEL_SIGNAL)
    },
    onEvent(listener: StepDriverListener) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    dispose() {
      unsubscribeExit()
      listeners.clear()
      owned.clear()
    }
  }
}
