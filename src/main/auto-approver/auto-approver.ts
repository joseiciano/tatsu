import { spawn, type ChildProcessWithoutNullStreams } from 'child_process'
import { homedir } from 'os'
import { log } from '../debug'
import { shellQuote } from '../shell-quote'
import { resolveUserShell, loginShellCommandArgs } from '../user-shell'
import type { AutoApproveDecision } from './types'
import {
  REVIEWER_MODEL,
  DEFAULT_TIMEOUT_MS,
  MAX_INPUT_BYTES,
  DENY_TOOL_NAMES,
  DENY_TOOL_PREFIXES,
  DENY_BASH_PATTERNS,
  DENY_PATH_SUBSTRINGS,
  POLICY_PROMPT
} from './constants'

export type { AutoApproveDecision } from './types'

interface AutoReviewOpts {
  claudeCommand: string
  timeoutMs?: number
  steerInstructions?: string
}

export function checkDenyList(
  toolName: string,
  input: Record<string, unknown>
): string | null {
  if (DENY_TOOL_NAMES.has(toolName)) {
    return `tool ${toolName} is on the deny list`
  }
  for (const prefix of DENY_TOOL_PREFIXES) {
    if (toolName.startsWith(prefix)) {
      return `tool ${toolName} is on the deny list`
    }
  }
  if (toolName === 'Bash') {
    const cmd = typeof input['command'] === 'string' ? input['command'] : ''
    for (const re of DENY_BASH_PATTERNS) {
      if (re.test(cmd)) return `Bash command matches deny pattern ${re}`
    }
  }
  const inputStr = safeStringify(input)
  for (const sub of DENY_PATH_SUBSTRINGS) {
    if (inputStr.includes(sub)) {
      return `input references protected path ${sub}`
    }
  }
  const home = homedir()
  const absPathRe = /(^|["\s'])(\/[A-Za-z][^\s"']*)/g
  let m: RegExpExecArray | null
  while ((m = absPathRe.exec(inputStr)) !== null) {
    const p = m[2]
    if (p.startsWith(home)) continue
    if (p.startsWith('/tmp/') || p === '/tmp') continue
    if (p.startsWith('/Volumes/')) continue
    return `input references absolute path outside home: ${p}`
  }
  return null
}

function safeStringify(v: unknown): string {
  try {
    return JSON.stringify(v)
  } catch {
    return ''
  }
}

function truncateInput(input: Record<string, unknown>): {
  text: string
  truncated: boolean
} {
  const raw = safeStringify(input)
  if (raw.length <= MAX_INPUT_BYTES) return { text: raw, truncated: false }
  const head = raw.slice(0, MAX_INPUT_BYTES)
  const moreBytes = raw.length - MAX_INPUT_BYTES
  return { text: `${head}...<truncated, ${moreBytes} more bytes>`, truncated: true }
}

export function buildPrompt(
  toolName: string,
  input: Record<string, unknown>,
  steerInstructions?: string
): string {
  const { text, truncated } = truncateInput(input)
  const steer = (steerInstructions || '').trim()
  const steerBlock = steer
    ? `\n## Project-specific guidance (additive — does not override the rules above):\n${steer}\n`
    : ''
  return `${POLICY_PROMPT}${steerBlock}
Tool: ${toolName}
Input${truncated ? ' (truncated)' : ''}: ${text}
`
}

export function parseDecision(stdout: string): AutoApproveDecision | null {
  const start = stdout.indexOf('{')
  if (start < 0) return null
  let depth = 0
  let end = -1
  let inString = false
  let escape = false
  for (let i = start; i < stdout.length; i++) {
    const c = stdout[i]
    if (escape) {
      escape = false
      continue
    }
    if (c === '\\') {
      escape = true
      continue
    }
    if (c === '"') {
      inString = !inString
      continue
    }
    if (inString) continue
    if (c === '{') depth++
    else if (c === '}') {
      depth--
      if (depth === 0) {
        end = i
        break
      }
    }
  }
  if (end < 0) return null
  const slice = stdout.slice(start, end + 1)
  let parsed: unknown
  try {
    parsed = JSON.parse(slice)
  } catch {
    return null
  }
  if (!parsed || typeof parsed !== 'object') return null
  const obj = parsed as Record<string, unknown>
  const decision = obj['decision']
  const reason = typeof obj['reason'] === 'string' ? obj['reason'] : ''
  if (decision === 'approve') {
    return { kind: 'approve', model: REVIEWER_MODEL, reason: reason || 'reviewer approved' }
  }
  if (decision === 'ask') {
    return { kind: 'ask', reason: reason || 'reviewer asked for human' }
  }
  return null
}

export async function autoReview(
  toolName: string,
  input: Record<string, unknown>,
  opts: AutoReviewOpts
): Promise<AutoApproveDecision> {
  const startedAt = Date.now()
  const denyReason = checkDenyList(toolName, input)
  if (denyReason) {
    log(
      'auto-approver',
      `deny-list match tool=${toolName} reason="${denyReason}" latency=0ms`
    )
    return { kind: 'ask', reason: denyReason }
  }

  const claudeCommand = (opts.claudeCommand || 'claude').trim() || 'claude'
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const args = [
    '-p',
    '--model',
    REVIEWER_MODEL,
    '--permission-mode',
    'plan'
  ]

  const cmdLine = `${claudeCommand} ${args.map(shellQuote).join(' ')}`
  const prompt = buildPrompt(toolName, input, opts.steerInstructions)

  return await new Promise<AutoApproveDecision>((resolve) => {
    let proc: ChildProcessWithoutNullStreams
    try {
      proc = spawn(resolveUserShell(), loginShellCommandArgs(cmdLine), {
        stdio: ['pipe', 'pipe', 'pipe'],
        env: { ...process.env, CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1' }
      })
    } catch (err) {
      const reason = `spawn failed: ${err instanceof Error ? err.message : String(err)}`
      log(
        'auto-approver',
        `tool=${toolName} decision=ask reason="${reason}" latency=${Date.now() - startedAt}ms`
      )
      resolve({ kind: 'ask', reason })
      return
    }

    let stdout = ''
    let stderr = ''
    let settled = false
    const finish = (decision: AutoApproveDecision): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      try {
        proc.kill('SIGTERM')
      } catch {
        /* ignore */
      }
      log(
        'auto-approver',
        `tool=${toolName} decision=${decision.kind} reason="${decision.reason}" latency=${Date.now() - startedAt}ms`
      )
      resolve(decision)
    }

    const timer = setTimeout(() => {
      finish({
        kind: 'ask',
        reason: `auto-review timed out after ${Math.round(timeoutMs / 1000)}s`
      })
    }, timeoutMs)

    proc.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8')
    })
    proc.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8')
    })
    proc.on('error', (err) => {
      const msg = err instanceof Error ? err.message : String(err)
      finish({ kind: 'ask', reason: `auto-reviewer process error: ${msg}` })
    })
    proc.on('close', (code, signal) => {
      if (settled) return
      if (code !== 0) {
        const tail = stderr.trim().slice(-200) || '(empty)'
        finish({
          kind: 'ask',
          reason: `auto-reviewer exited code=${code}${signal ? ` signal=${signal}` : ''} stderr="${tail}"`
        })
        return
      }
      const parsed = parseDecision(stdout)
      if (!parsed) {
        const tail = stdout.trim().slice(-200) || '(empty)'
        finish({
          kind: 'ask',
          reason: `auto-reviewer reply was not valid decision JSON: "${tail}"`
        })
        return
      }
      finish(parsed)
    })

    try {
      proc.stdin.write(prompt)
      proc.stdin.end()
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      finish({ kind: 'ask', reason: `auto-reviewer stdin write failed: ${msg}` })
    }
  })
}
