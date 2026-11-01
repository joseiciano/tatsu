import { spawnSync } from 'child_process'
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { TemplateScope } from '../../../shared/workflow-def'
import type { TerminalTab } from '../../../shared/state/terminals'
import type { StepSpawnExtras } from '../../agent-spawn'
import {
  MAX_INTERPOLATED_VALUE_BYTES,
  SHELL_START_SUMMARIES,
  SHELL_SUMMARY_MAX_BYTES,
  StepStartError,
  buildShellCommand,
  createShellStepDriver,
  summarizeShellOutput,
  type StepAttempt,
  type StepDriverEvent
} from '.'

const HOSTILE = [
  'a; touch PWNED',
  '$(touch PWNED)',
  '`touch PWNED`',
  `"'quoted'"`,
  'line one\nline two; touch PWNED\n',
  'a  *  b'
]

const hasZsh = spawnSync('zsh', ['-f', '-c', 'true']).status === 0
const hasBash = spawnSync('bash', ['--norc', '-c', 'true']).status === 0

function scopeWith(inputs: Record<string, string>, extra: Partial<TemplateScope> = {}): TemplateScope {
  return { inputs, steps: {}, run: { id: 'run-1', worktree: '/wt', contextPath: '/wt/ctx.md' }, ...extra }
}

let cwd: string

beforeEach(() => {
  cwd = mkdtempSync(join(tmpdir(), 'shell-step-'))
})

afterEach(() => {
  rmSync(cwd, { recursive: true, force: true })
})

type Shell = 'sh' | 'bash' | 'zsh'

const SHELL_ARGV: Record<Shell, (command: string) => [string, string[]]> = {
  sh: (command) => ['/bin/sh', ['-c', command]],
  bash: (command) => ['bash', ['--norc', '--noprofile', '-c', command]],
  zsh: (command) => ['zsh', ['-f', '-c', command]]
}

function runIn(shell: Shell, command: string, env: Record<string, string>): Buffer {
  const [file, args] = SHELL_ARGV[shell](command)
  const result = spawnSync(file, args, {
    cwd,
    env: { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: cwd, ZDOTDIR: cwd, ...env }
  })
  expect(result.status).toBe(0)
  return result.stdout
}

function expectNoSideEffects(): void {
  expect(existsSync(join(cwd, 'PWNED'))).toBe(false)
  expect(readdirSync(cwd)).toEqual([])
}

const SHELLS: Array<{ shell: Shell; skip: boolean }> = [
  { shell: 'sh', skip: false },
  { shell: 'bash', skip: !hasBash },
  { shell: 'zsh', skip: !hasZsh }
]

describe.each(SHELLS)('buildShellCommand under $shell -c', ({ shell, skip }) => {
  it.skipIf(skip).each(HOSTILE)('prints %j byte-for-byte when unquoted', (value) => {
    const { command, env } = buildShellCommand("printf '%s' {{inputs.x}}", scopeWith({ x: value }))
    expect(runIn(shell, command, env).equals(Buffer.from(value))).toBe(true)
    expectNoSideEffects()
  })

  it.skipIf(skip).each(HOSTILE)('prints %j byte-for-byte inside the author double quotes', (value) => {
    const { command, env } = buildShellCommand(`printf '%s' "pre {{inputs.x}} post"`, scopeWith({ x: value }))
    expect(runIn(shell, command, env).equals(Buffer.from(`pre ${value} post`))).toBe(true)
    expectNoSideEffects()
  })

  it.skipIf(skip).each(HOSTILE)('prints %j byte-for-byte inside a command substitution', (value) => {
    const { command, env } = buildShellCommand(
      `printf '%s' "$(printf '%s' "<{{inputs.x}}>")"`,
      scopeWith({ x: value })
    )
    const expected = `<${value}>`.replace(/\n+$/, '')
    expect(runIn(shell, command, env).toString()).toBe(expected)
    expectNoSideEffects()
  })

  it.skipIf(skip)('passes step summaries through after an apostrophe in a comment', () => {
    const { command, env } = buildShellCommand(
      "# don't break\nprintf '%s' {{steps.plan.summary}}",
      scopeWith({}, { steps: { plan: { status: 'done', summary: 'a; touch PWNED' } } })
    )
    expect(runIn(shell, command, env).toString()).toBe('a; touch PWNED')
    expectNoSideEffects()
  })
})

describe('buildShellCommand', () => {
  it('never puts a value substring in the command', () => {
    const values = { a: 'zq-alpha-7f3e; rm -rf ~', b: '$(zq-bravo-91c2)', c: '`zq-charlie-0d4b`' }
    const { command, env } = buildShellCommand('echo {{inputs.a}} "{{inputs.b}}" && echo {{inputs.c}}', scopeWith(values))
    for (const value of Object.values(values)) {
      expect(command).not.toContain(value)
      for (const fragment of value.match(/zq-[a-z]+-[0-9a-f]+/g) ?? []) expect(command).not.toContain(fragment)
    }
    expect(command).toBe('echo "${HARNESS_WF_0}" "${HARNESS_WF_1}" && echo "${HARNESS_WF_2}"')
    expect(Object.values(env).sort()).toEqual(Object.values(values).sort())
  })

  it('reuses one variable for a repeated reference', () => {
    const { command, env } = buildShellCommand('echo {{inputs.a}} {{inputs.a}}', scopeWith({ a: 'v' }))
    expect(command).toBe('echo "${HARNESS_WF_0}" "${HARNESS_WF_0}"')
    expect(env).toEqual({ HARNESS_WF_0: 'v' })
  })

  it('sets a missing value to an empty string so an inherited variable cannot fill it', () => {
    const { command, env } = buildShellCommand("printf '%s' {{inputs.gone}}", scopeWith({}))
    expect(env).toEqual({ HARNESS_WF_0: '' })
    expect(runIn('sh', command, { ...env }).toString()).toBe('')
    const inherited = spawnSync('/bin/sh', ['-c', command], { env: { ...process.env, HARNESS_WF_0: 'leak', ...env } })
    expect(inherited.stdout.toString()).toBe('')
  })

  it('formats non-string values the way renderTemplate does', () => {
    const { env } = buildShellCommand(
      'echo {{steps.plan.data.n}} {{steps.plan.data.obj}}',
      scopeWith({}, { steps: { plan: { status: 'done', data: { n: 3, obj: { k: [1] } } } } })
    )
    expect(env).toEqual({ HARNESS_WF_0: '3', HARNESS_WF_1: '{"k":[1]}' })
  })

  it.each([
    ['single quotes', "sh -c 'printf %s {{inputs.x}}'"],
    ['a comment', 'echo hi # {{inputs.x}}'],
    ['a subshell or glob qualifier group', 'print -l *({{inputs.x}})'],
    ['a glob qualifier group with quotes', 'print -l *("{{inputs.x}}")'],
    ['a word starting with =', 'echo ={{inputs.x}}'],
    ['a word starting with ~', 'echo ~{{inputs.x}}'],
    ['an assignment tilde', 'x=~{{inputs.x}}'],
    ['legacy arithmetic', 'echo "next: $[ {{inputs.x}} + 1 ]"'],
    ['a case pattern inside a substitution', 'echo "$(case go in go) (( n = {{inputs.x}} ));; esac)"'],
    ['a line after a comment glued to a substitution', 'echo $(pwd)# $(( {{inputs.x}} + 1 ))'],
    ['a line after quotes inside a parameter expansion', 'echo ${A:-"}"}; (( n = {{inputs.x}} ))'],
    ['a line after quotes inside arithmetic', "echo $(( $(printf '))))' >/dev/null; echo 1) + {{inputs.x}} ))"],
    ['a run that ends inside an open quote', 'echo {{inputs.x}} "unterminated'],
    ['backticks', 'echo `echo {{inputs.x}}`'],
    ['a parameter expansion', 'echo "${HOME:-{{inputs.x}}}"'],
    ['arithmetic', 'echo $(( {{inputs.x}} + 1 ))'],
    ['an arithmetic command', '(( {{inputs.x}} ))'],
    ['ANSI-C quotes', "echo $'{{inputs.x}}'"],
    ['a heredoc', 'cat <<EOF\n{{inputs.x}}\nEOF'],
    ['a backslash', 'echo \\{{inputs.x}}'],
    ['a dollar sign', 'echo ${{inputs.x}}']
  ])('refuses a reference inside %s', (_label, run) => {
    expect(() => buildShellCommand(run, scopeWith({ x: '1' }))).toThrow(
      new StepStartError(SHELL_START_SUMMARIES.unsupported)
    )
  })

  it('allows a here-string', () => {
    expect(buildShellCommand('cat <<< {{inputs.x}}', scopeWith({ x: '1' })).command).toBe(
      'cat <<< "${HARNESS_WF_0}"'
    )
  })

  it('refuses an oversize value with a value-free summary', () => {
    const big = 'secret-'.repeat(Math.ceil(MAX_INTERPOLATED_VALUE_BYTES / 7) + 1)
    let error: unknown
    try {
      buildShellCommand('echo {{inputs.x}}', scopeWith({ x: big }))
    } catch (err) {
      error = err
    }
    expect(error).toBeInstanceOf(StepStartError)
    expect(error).toMatchObject({ summary: 'interpolated value too large' })
    expect((error as Error).message).not.toContain('secret')
  })

  it('sizes the whole env entry against the limit', () => {
    const room = MAX_INTERPOLATED_VALUE_BYTES - 'HARNESS_WF_0=\0'.length
    const exact = 'é'.repeat(room / 2)
    expect(buildShellCommand('echo {{inputs.x}}', scopeWith({ x: exact })).env.HARNESS_WF_0).toBe(exact)
    expect(() => buildShellCommand('echo {{inputs.x}}', scopeWith({ x: `${exact}a` }))).toThrow(
      new StepStartError(SHELL_START_SUMMARIES.tooLarge)
    )
  })

  it('refuses entries that together exceed the total size limit', () => {
    const chunk = 'v'.repeat(100 * 1024)
    const inputs = Object.fromEntries(Array.from({ length: 6 }, (_, i) => [`k${i}`, chunk]))
    const run = Object.keys(inputs)
      .map((key) => `{{inputs.${key}}}`)
      .join(' ')
    expect(() => buildShellCommand(`echo ${run}`, scopeWith(inputs))).toThrow(
      new StepStartError(SHELL_START_SUMMARIES.tooLarge)
    )
  })

  it('refuses a value with an unpaired surrogate', () => {
    expect(() => buildShellCommand('echo {{inputs.x}}', scopeWith({ x: 'cut \uD83D' }))).toThrow(
      new StepStartError(SHELL_START_SUMMARIES.malformed)
    )
    expect(buildShellCommand('echo {{inputs.x}}', scopeWith({ x: 'ok \uD83D\uDE00' })).env.HARNESS_WF_0).toBe(
      'ok \u{1F600}'
    )
  })

  it('still accepts common constructs before a reference', () => {
    expect(
      buildShellCommand('cd "${HOME}" && x=$(pwd) # it\'s fine\nprintf \'%s\' "$x/{{inputs.x}}" HEAD~1', scopeWith({ x: 'v' }))
        .command
    ).toBe('cd "${HOME}" && x=$(pwd) # it\'s fine\nprintf \'%s\' "$x/${HARNESS_WF_0}" HEAD~1')
  })

  it('refuses a value containing NUL', () => {
    expect(() => buildShellCommand('echo {{inputs.x}}', scopeWith({ x: 'a\0b' }))).toThrow(
      new StepStartError('interpolated value contains NUL')
    )
  })

  it('refuses a blank command', () => {
    expect(() => buildShellCommand('  \n', scopeWith({}))).toThrow(new StepStartError(SHELL_START_SUMMARIES.empty))
  })
})

describe('summarizeShellOutput', () => {
  it('strips CSI, OSC and other escapes and resolves carriage returns', () => {
    const raw =
      '\u001b]0;title\u0007\u001b]8;;http://x\u001b\\link\u001b]8;;\u001b\\\r\n' +
      '\u001b[1;31mred\u001b[0m text\r\n' +
      'progress 10%\rprogress 100%\r\n' +
      '\u001b(Bplain\u001b=\n' +
      '   \r\n\n'
    expect(summarizeShellOutput(raw)).toBe('link\nred text\nprogress 100%\nplain')
  })

  it('caps the summary to its last 16 KiB without splitting a character', () => {
    const raw = `${'é'.repeat(20000)}\nend 😀\n`
    const summary = summarizeShellOutput(raw)
    expect(Buffer.byteLength(summary, 'utf8')).toBeLessThanOrEqual(SHELL_SUMMARY_MAX_BYTES)
    expect(Buffer.byteLength(summary, 'utf8')).toBeGreaterThan(SHELL_SUMMARY_MAX_BYTES - 4)
    expect(summary.endsWith('\nend 😀')).toBe(true)
    expect(summary).not.toContain('\uFFFD')
  })

  it('keeps the last 50 non-empty lines', () => {
    const raw = Array.from({ length: 80 }, (_, i) => `line ${i}\r\n\r\n`).join('')
    const lines = summarizeShellOutput(raw).split('\n')
    expect(lines).toHaveLength(50)
    expect(lines[0]).toBe('line 30')
    expect(lines.at(-1)).toBe('line 79')
  })
})

class FakePty {
  readonly tabs: Array<{ worktreePath: string; tab: TerminalTab; spawn: StepSpawnExtras }> = []
  readonly killed: string[] = []
  readonly alive = new Set<string>()
  readonly history = new Map<string, string>()
  failSpawn = false
  private readonly listeners = new Set<(id: string, code: number, signal?: number) => void>()
  private ids = 0

  deps() {
    return {
      addTab: (worktreePath: string, tab: TerminalTab, spawn: StepSpawnExtras) => {
        this.tabs.push({ worktreePath, tab, spawn })
        if (!this.failSpawn) this.alive.add(tab.id)
      },
      hasTerminal: (id: string) => this.alive.has(id),
      getHistory: (id: string) => this.history.get(id) ?? '',
      onExit: (listener: (id: string, code: number, signal?: number) => void) => {
        this.listeners.add(listener)
        return () => {
          this.listeners.delete(listener)
        }
      },
      kill: (id: string) => {
        this.killed.push(id)
      },
      newTabId: () => `shell-tab-${++this.ids}`
    }
  }

  get listenerCount(): number {
    return this.listeners.size
  }

  exit(id: string, code: number, signal?: number): void {
    this.alive.delete(id)
    for (const listener of [...this.listeners]) listener(id, code, signal)
  }
}

function shellAttempt(run: string, inputs: Record<string, string> = {}): StepAttempt {
  return {
    runId: 'run-1',
    stepId: 'test',
    attemptId: 'att-1',
    n: 1,
    worktreePath: '/wt',
    inputs,
    step: { kind: 'shell', id: 'test', run, needs: [] },
    scope: scopeWith(inputs)
  }
}

describe('createShellStepDriver', () => {
  it('opens a tagged step tab with explicit command and env only', () => {
    const pty = new FakePty()
    const driver = createShellStepDriver(pty.deps())
    const execution = driver.start(shellAttempt('npm test -- {{inputs.x}}', { x: 'zq-only-in-env' }))
    expect(execution).toEqual({ executionId: 'shell-tab-1' })
    expect(pty.tabs).toEqual([
      {
        worktreePath: '/wt',
        tab: {
          id: 'shell-tab-1',
          type: 'shell',
          label: '⚙ test · shell',
          workflow: { runId: 'run-1', stepId: 'test', attemptId: 'att-1' }
        },
        spawn: { command: 'npm test -- "${HARNESS_WF_0}"', env: { HARNESS_WF_0: 'zq-only-in-env' } }
      }
    ])
  })

  it('emits exited with the summary read from history at exit', () => {
    const pty = new FakePty()
    const driver = createShellStepDriver(pty.deps())
    const events: StepDriverEvent[] = []
    driver.onEvent((event) => events.push(event))
    const { executionId } = driver.start(shellAttempt('make'))
    pty.history.set(executionId, '\u001b[32mok\u001b[0m\r\n')
    pty.exit('other-tab', 0)
    pty.exit(executionId, 2)
    pty.exit(executionId, 2)
    expect(events).toEqual([{ type: 'exited', executionId, code: 2, summary: 'ok' }])
  })

  it('reports a signal death as a null code so it never counts as success', () => {
    const pty = new FakePty()
    const driver = createShellStepDriver(pty.deps())
    const events: StepDriverEvent[] = []
    driver.onEvent((event) => events.push(event))
    const { executionId } = driver.start(shellAttempt('make'))
    pty.exit(executionId, 0, 9)
    expect(events).toEqual([{ type: 'exited', executionId, code: null, summary: '' }])
  })

  it('validates before opening a tab', () => {
    const pty = new FakePty()
    const driver = createShellStepDriver(pty.deps())
    expect(() => driver.start(shellAttempt('echo {{inputs.x}}', { x: 'a\0' }))).toThrow(StepStartError)
    expect(pty.tabs).toEqual([])
  })

  it('fails the start when the PTY did not spawn', () => {
    const pty = new FakePty()
    pty.failSpawn = true
    const driver = createShellStepDriver(pty.deps())
    expect(() => driver.start(shellAttempt('make'))).toThrow(new StepStartError(SHELL_START_SUMMARIES.spawnFailed))
  })

  it('kills only its own executions on cancel and stops reporting them', () => {
    const pty = new FakePty()
    const driver = createShellStepDriver(pty.deps())
    const events: StepDriverEvent[] = []
    driver.onEvent((event) => events.push(event))
    const { executionId } = driver.start(shellAttempt('sleep 100'))
    driver.cancel('someone-else')
    driver.cancel(executionId)
    pty.exit(executionId, 143)
    expect(pty.killed).toEqual([executionId])
    expect(events).toEqual([])
  })

  it('unsubscribes from PTY exits on dispose', () => {
    const pty = new FakePty()
    const driver = createShellStepDriver(pty.deps())
    expect(pty.listenerCount).toBe(1)
    driver.dispose()
    expect(pty.listenerCount).toBe(0)
  })
})
