import { basename, isAbsolute, relative } from 'path'
import type { WorktreeContainerStatus } from '../../shared/state/worktrees'

export interface WorktreeContainerTarget {
  worktreePath: string
  name: string
  shell: string
  workdir: string
  status: WorktreeContainerStatus
  error?: string
}

export type WorktreeContainerResolver = (
  id: string,
  cwd: string
) => WorktreeContainerTarget | undefined

export interface PtySpawnInput {
  id: string
  cwd: string
  command: string
  args: string[]
  extraEnv?: Record<string, string>
  isShell: boolean
  resolver?: WorktreeContainerResolver
}

interface PtySpawnSpec {
  kind: 'spawn'
  command: string
  args: string[]
  cwd: string
  env: Record<string, string>
  isContainer: boolean
}

interface PtySpawnError {
  kind: 'error'
  message: string
}

export type PtySpawnPlan = PtySpawnSpec | PtySpawnError

const ENV_KEY_RE = /^[A-Za-z_][A-Za-z0-9_]*$/

function commandArgsForShell(shell: string, command: string): string[] {
  const shellName = basename(shell).toLowerCase()
  if (shellName === 'fish' || shellName === 'nu' || shellName === 'nushell') return [shell, '-c', command]
  if (shellName === 'pwsh' || shellName === 'powershell' || shellName === 'powershell.exe' || shellName === 'pwsh.exe') {
    return [shell, '-NoLogo', '-NoProfile', '-Command', command]
  }
  return [shell, '-c', command]
}

function isExecModeArgs(args: string[]): boolean {
  return args.some((a) => a === '-c' || a === '-ilc' || a === '-lc' || a === '-ic')
}

export function buildPtySpawnPlan(input: PtySpawnInput): PtySpawnPlan {
  const { id, cwd, command, args, extraEnv, isShell, resolver } = input

  // Validate extraEnv keys
  if (extraEnv) {
    for (const key of Object.keys(extraEnv)) {
      if (!ENV_KEY_RE.test(key)) {
        return { kind: 'error', message: `Invalid env key: "${key}". Environment variable names must match /^[A-Za-z_][A-Za-z0-9_]*$/` }
      }
    }
  }

  // Resolve container target
  const target = resolver?.(id, cwd)
  if (!target) {
    // Host path — preserve exact existing behavior
    const env: Record<string, string> = {
      ...process.env,
      ...(extraEnv || {}),
      CLAUDE_HARNESS_ID: id,
      HARNESS_TERMINAL_ID: id
    } as Record<string, string>
    const shell = command || env.SHELL || '/bin/zsh'
    return { kind: 'spawn', command: shell, args, cwd, env, isContainer: false }
  }

  // Container path — status must be running
  if (target.status !== 'running') {
    const hint = target.status === 'stopped'
      ? `Container "${target.name}" is stopped. Restart or recreate it from Settings → Worktrees.`
      : target.status === 'error'
        ? `Container "${target.name}" is in error state${target.error ? `: ${target.error}` : ''}. Recreate it from Settings → Worktrees.`
        : `Container "${target.name}" is ${target.status}. Wait for it to start or recreate from Settings → Worktrees.`
    return { kind: 'error', message: hint }
  }

  const rel = relative(target.worktreePath, cwd)
  if (rel !== '' && rel !== '.') {
    if (rel === '..' || rel.startsWith('..\\') || rel.startsWith('../') || isAbsolute(rel)) {
      return { kind: 'error', message: `cwd "${cwd}" is not inside worktree "${target.worktreePath}"` }
    }
  }
  const mappedCwd = rel === '' || rel === '.' ? target.workdir : `${target.workdir}/${rel.replace(/\\/g, '/')}`

  // Build docker exec args
  const dockerArgs: string[] = ['exec', '-it']

  // Terminal IDs + minimal terminal vars inside container
  dockerArgs.push('-e', `HARNESS_TERMINAL_ID=${id}`)
  dockerArgs.push('-e', `CLAUDE_HARNESS_ID=${id}`)
  dockerArgs.push('-e', 'TERM=xterm-256color')
  dockerArgs.push('-e', 'COLORTERM=truecolor')

  // Extra env keys (validated above). Values may be secrets, so pass only
  // the key name to docker -e (value is inherited from the host process env).
  if (extraEnv) {
    for (const k of Object.keys(extraEnv)) {
      dockerArgs.push('-e', k)
    }
  }

  dockerArgs.push('--workdir', mappedCwd)

  const shell = target.shell || '/bin/sh'

  if (isShell && isExecModeArgs(args)) {
    // Extract the command from the last arg (zsh-style: <shell> -ilc <cmd>)
    const cmdStr = args[args.length - 1] || ''
    dockerArgs.push(target.name, ...commandArgsForShell(shell, cmdStr))
  } else if (isShell) {
    // Interactive shell tab — spawn the shell itself
    dockerArgs.push(target.name, shell)
  } else {
    // Non-shell command (agent/CLI) — pass command + args directly
    dockerArgs.push(target.name, command, ...args)
  }

  // Host docker process env stays normal so docker CLI can be found
  const env: Record<string, string> = {
    ...process.env,
    ...(extraEnv || {}),
    CLAUDE_HARNESS_ID: id,
    HARNESS_TERMINAL_ID: id
  } as Record<string, string>

  return { kind: 'spawn', command: 'docker', args: dockerArgs, cwd, env, isContainer: true }
}
