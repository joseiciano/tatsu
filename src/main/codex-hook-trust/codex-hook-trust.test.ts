import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  readdirSync,
  statSync,
  rmSync,
  symlinkSync,
  realpathSync,
  existsSync,
  watch,
  type FSWatcher
} from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'

vi.mock('../debug', () => ({ log: vi.fn() }))

import { log } from '../debug'
import { resolveCodexHome } from '../folder-trust'
import {
  codexEventSnake,
  codexHookKey,
  codexHookIdentityJson,
  codexHookHash,
  readCodexHookTrust,
  summarizeCodexHookTrust,
  startCodexHookTrustMonitor,
  type CodexHookGroup,
  type CodexHookHandler,
  type CodexHookTrustSummary
} from '.'

const STOP_HASH = 'sha256:4f1aa7bed366149ee244fb905269c4c01a5529accac1f4a405529d3888ef9f8c'
const SESSION_START_HASH = 'sha256:96cc81a196212d261ff38a60c5017702fa38431245cc4f6d1b96b0af85b32576'
const PRE_TOOL_USE_HASH = 'sha256:94034b6614dd94e8b983d01f818076b38d60e5f5916119ba5ee07f82fa771f61'
const ANY_HASH = expect.stringMatching(/^sha256:[0-9a-f]{64}$/)

const EVENTS = ['SessionStart', 'PreToolUse', 'PostToolUse', 'UserPromptSubmit', 'Stop'] as const

const isOwnedHandler = (h: CodexHookHandler): boolean => h.command.includes('harness-hook.sh')

function tatsuHandler(event: string, home = '/h'): CodexHookHandler {
  return { type: 'command', command: `bash '${home}/.codex/harness-hook.sh' ${event}`, timeout: 5 }
}

function tatsuGroup(event: string): CodexHookGroup {
  return { hooks: [tatsuHandler(event)] }
}

const userHandler: CodexHookHandler = { type: 'command', command: 'echo user', timeout: 10 }
const userGroup: CodexHookGroup = { hooks: [userHandler] }

function stateTable(key: string, body: string): string {
  return `[hooks.state."${key}"]\n${body}\n`
}

let tmp: string
const monitors: Array<{ stop: () => void }> = []
const watchers: FSWatcher[] = []

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'codex-hook-trust-'))
  vi.mocked(log).mockClear()
})

afterEach(() => {
  for (const m of monitors.splice(0)) m.stop()
  for (const w of watchers.splice(0)) w.close()
  rmSync(tmp, { recursive: true, force: true })
})

describe('codexEventSnake / codexHookKey / codexHookIdentityJson', () => {
  it.each([
    ['SessionStart', 'session_start'],
    ['PreToolUse', 'pre_tool_use'],
    ['PostToolUse', 'post_tool_use'],
    ['UserPromptSubmit', 'user_prompt_submit'],
    ['Stop', 'stop']
  ])('snakes %s as %s', (event, snake) => {
    expect(codexEventSnake(event)).toBe(snake)
  })

  it('builds the positional key from the path as given, snaked event, group and handler index', () => {
    expect(codexHookKey('/h/.codex/hooks.json', 'SessionStart', 0, 0)).toBe('/h/.codex/hooks.json:session_start:0:0')
    expect(codexHookKey('/h/.codex/hooks.json', 'PreToolUse', 2, 1)).toBe('/h/.codex/hooks.json:pre_tool_use:2:1')
  })

  it('produces the worked canonical identity JSON for the Stop entry', () => {
    expect(codexHookIdentityJson('Stop', tatsuGroup('Stop'))).toBe(
      `{"event_name":"stop","hooks":[{"async":false,"command":"bash '/h/.codex/harness-hook.sh' Stop","timeout":5,"type":"command"}]}`
    )
  })

  it('identifies only the handler at handlerIndex', () => {
    expect(codexHookIdentityJson('Stop', { hooks: [userHandler, tatsuHandler('Stop')] }, 1)).toBe(
      codexHookIdentityJson('Stop', tatsuGroup('Stop'))
    )
  })

  it('keeps a matcher on PreToolUse and drops it on Stop', () => {
    const pre = JSON.parse(codexHookIdentityJson('PreToolUse', { matcher: 'Bash', hooks: [tatsuHandler('PreToolUse')] }))
    expect(pre.matcher).toBe('Bash')
    expect(codexHookIdentityJson('Stop', { matcher: 'Bash', hooks: [tatsuHandler('Stop')] })).toBe(
      codexHookIdentityJson('Stop', tatsuGroup('Stop'))
    )
  })

  it.each([
    ['missing timeout', undefined, 600],
    ['zero timeout', 0, 1]
  ])('normalizes %s to %i', (_name, timeout, expected) => {
    const json = codexHookIdentityJson('Stop', { hooks: [{ type: 'command', command: 'x', timeout }] })
    expect(JSON.parse(json).hooks[0].timeout).toBe(expected)
  })

  it('is independent of key order in the input', () => {
    const reordered = {
      hooks: [{ timeout: 5, command: "bash '/h/.codex/harness-hook.sh' PreToolUse", type: 'command' }],
      matcher: 'Bash'
    } as CodexHookGroup
    expect(codexHookIdentityJson('PreToolUse', reordered)).toBe(
      codexHookIdentityJson('PreToolUse', { matcher: 'Bash', hooks: [tatsuHandler('PreToolUse')] })
    )
  })
})

describe('codexHookHash', () => {
  it('pins the Stop hash (verified against codex 0.164.0)', () => {
    expect(codexHookHash('Stop', tatsuGroup('Stop'))).toBe(STOP_HASH)
  })

  it.each([
    ['SessionStart', SESSION_START_HASH],
    ['PreToolUse', PRE_TOOL_USE_HASH]
  ])('pins the %s hash (verified against codex 0.164.0)', (event, hash) => {
    expect(codexHookHash(event, tatsuGroup(event))).toBe(hash)
  })
})

describe('readCodexHookTrust statuses', () => {
  it('maps stored state to trusted / modified / disabled / untrusted and skips user handlers', async () => {
    const hooksPath = join(tmp, 'hooks.json')
    const configPath = join(tmp, 'config.toml')
    writeFileSync(
      hooksPath,
      JSON.stringify({
        hooks: {
          Stop: [tatsuGroup('Stop')],
          SessionStart: [tatsuGroup('SessionStart')],
          PreToolUse: [tatsuGroup('PreToolUse')],
          PostToolUse: [tatsuGroup('PostToolUse'), userGroup],
          UserPromptSubmit: [tatsuGroup('UserPromptSubmit')]
        }
      })
    )
    writeFileSync(
      configPath,
      stateTable(`${hooksPath}:stop:0:0`, `trusted_hash = "${STOP_HASH}"`) +
        stateTable(`${hooksPath}:session_start:0:0`, 'trusted_hash = "sha256:stale"') +
        stateTable(`${hooksPath}:pre_tool_use:0:0`, `trusted_hash = "${PRE_TOOL_USE_HASH}"\nenabled = false`) +
        stateTable(`${hooksPath}:post_tool_use:1:0`, 'trusted_hash = "sha256:user"')
    )

    const report = await readCodexHookTrust({ hooksPath, configPath, isOwnedHandler })

    expect(report.readable).toBe(true)
    expect(report.entries).toEqual([
      { event: 'Stop', groupIndex: 0, handlerIndex: 0, key: `${hooksPath}:stop:0:0`, hash: STOP_HASH, storedHash: STOP_HASH, status: 'trusted' },
      { event: 'SessionStart', groupIndex: 0, handlerIndex: 0, key: `${hooksPath}:session_start:0:0`, hash: SESSION_START_HASH, storedHash: 'sha256:stale', status: 'modified' },
      { event: 'PreToolUse', groupIndex: 0, handlerIndex: 0, key: `${hooksPath}:pre_tool_use:0:0`, hash: PRE_TOOL_USE_HASH, storedHash: PRE_TOOL_USE_HASH, status: 'disabled' },
      { event: 'PostToolUse', groupIndex: 0, handlerIndex: 0, key: `${hooksPath}:post_tool_use:0:0`, hash: ANY_HASH, storedHash: null, status: 'untrusted' },
      { event: 'UserPromptSubmit', groupIndex: 0, handlerIndex: 0, key: `${hooksPath}:user_prompt_submit:0:0`, hash: ANY_HASH, storedHash: null, status: 'untrusted' }
    ])
  })

  it('reports a Tatsu handler sharing a group with a user handler at its own handler index', async () => {
    const hooksPath = join(tmp, 'hooks.json')
    const configPath = join(tmp, 'config.toml')
    writeFileSync(hooksPath, JSON.stringify({ hooks: { Stop: [{ hooks: [userHandler, tatsuHandler('Stop')] }] } }))
    writeFileSync(configPath, stateTable(`${hooksPath}:stop:0:1`, `trusted_hash = "${STOP_HASH}"`))

    const report = await readCodexHookTrust({ hooksPath, configPath, isOwnedHandler })

    expect(report.entries).toEqual([
      { event: 'Stop', groupIndex: 0, handlerIndex: 1, key: `${hooksPath}:stop:0:1`, hash: STOP_HASH, storedHash: STOP_HASH, status: 'trusted' }
    ])
  })
})

describe('readCodexHookTrust position', () => {
  it.each([
    ['index 0 (where Tatsu used to sit)', 'stop:0:0', 'untrusted'],
    ['index 1 (where Tatsu sits now)', 'stop:1:0', 'trusted']
  ])('trust stored under %s reads %s', async (_name, suffix, status) => {
    const hooksPath = join(tmp, 'hooks.json')
    const configPath = join(tmp, 'config.toml')
    writeFileSync(hooksPath, JSON.stringify({ hooks: { Stop: [userGroup, tatsuGroup('Stop')] } }))
    writeFileSync(configPath, stateTable(`${hooksPath}:${suffix}`, `trusted_hash = "${STOP_HASH}"`))

    const report = await readCodexHookTrust({ hooksPath, configPath, isOwnedHandler })

    expect(report.entries).toHaveLength(1)
    expect(report.entries[0]).toMatchObject({ groupIndex: 1, key: `${hooksPath}:stop:1:0`, status })
  })
})

describe('readCodexHookTrust file handling + summary', () => {
  function writeAllFive(hooksPath: string): void {
    writeFileSync(
      hooksPath,
      JSON.stringify({
        hooks: {
          Stop: [tatsuGroup('Stop')],
          UserPromptSubmit: [tatsuGroup('UserPromptSubmit')],
          SessionStart: [tatsuGroup('SessionStart')],
          PreToolUse: [tatsuGroup('PreToolUse')],
          PostToolUse: [tatsuGroup('PostToolUse')]
        }
      })
    )
  }

  it('missing hooks.json is readable with no entries and summarizes as not-installed', async () => {
    const report = await readCodexHookTrust({
      hooksPath: join(tmp, 'hooks.json'),
      configPath: join(tmp, 'config.toml'),
      isOwnedHandler
    })
    expect(report.readable).toBe(true)
    expect(report.entries).toEqual([])
    expect(summarizeCodexHookTrust(report, EVENTS)).toEqual({ state: 'not-installed', reviewEvents: [] })
  })

  it('invalid hooks.json is unreadable and summarizes as unknown', async () => {
    const hooksPath = join(tmp, 'hooks.json')
    writeFileSync(hooksPath, '{not json')
    const report = await readCodexHookTrust({ hooksPath, configPath: join(tmp, 'config.toml'), isOwnedHandler })
    expect(report.readable).toBe(false)
    expect(report.entries).toEqual([])
    expect(summarizeCodexHookTrust(report, EVENTS)).toEqual({ state: 'unknown', reviewEvents: [] })
  })

  it('missing config.toml leaves every entry untrusted and lists all five events sorted', async () => {
    const hooksPath = join(tmp, 'hooks.json')
    writeAllFive(hooksPath)
    const report = await readCodexHookTrust({ hooksPath, configPath: join(tmp, 'config.toml'), isOwnedHandler })
    expect(report.readable).toBe(true)
    expect(report.entries.map((e) => e.status)).toEqual(['untrusted', 'untrusted', 'untrusted', 'untrusted', 'untrusted'])
    expect(summarizeCodexHookTrust(report, EVENTS)).toEqual({
      state: 'needs-review',
      reviewEvents: ['PostToolUse', 'PreToolUse', 'SessionStart', 'Stop', 'UserPromptSubmit']
    })
  })

  it('unparseable config.toml is unknown and logs once without file contents', async () => {
    const hooksPath = join(tmp, 'hooks.json')
    const configPath = join(tmp, 'config.toml')
    writeAllFive(hooksPath)
    writeFileSync(configPath, '[hooks.state SECRET_SENTINEL_VALUE\n')

    const report = await readCodexHookTrust({ hooksPath, configPath, isOwnedHandler })

    expect(report.readable).toBe(false)
    expect(report.entries).toEqual([])
    expect(summarizeCodexHookTrust(report, EVENTS)).toEqual({ state: 'unknown', reviewEvents: [] })
    expect(vi.mocked(log)).toHaveBeenCalledTimes(1)
    expect(vi.mocked(log).mock.calls[0][0]).toBe('codex-hook-trust')
    expect(JSON.stringify(vi.mocked(log).mock.calls)).not.toContain('SECRET_SENTINEL_VALUE')
  })
})

describe('summarizeCodexHookTrust', () => {
  const entry = (event: string, status: 'trusted' | 'modified' | 'untrusted' | 'disabled') => ({
    event,
    groupIndex: 0,
    handlerIndex: 0,
    key: `/h/.codex/hooks.json:${codexEventSnake(event)}:0:0`,
    hash: 'sha256:x',
    storedHash: null,
    status
  })
  const report = (entries: ReturnType<typeof entry>[]) => ({
    hooksPath: '/h/.codex/hooks.json',
    configPath: '/h/.codex/config.toml',
    readable: true,
    entries
  })

  it.each<[string, ReturnType<typeof entry>[], CodexHookTrustSummary]>([
    ['all trusted', [entry('Stop', 'trusted'), entry('SessionStart', 'trusted')], { state: 'ok', reviewEvents: [] }],
    ['non-trusted event outside expectedEvents is ignored', [entry('Stop', 'trusted'), entry('SubagentStart', 'untrusted')], { state: 'ok', reviewEvents: [] }],
    ['modified and disabled both need review, deduped', [entry('Stop', 'modified'), entry('Stop', 'untrusted'), entry('PreToolUse', 'disabled'), entry('SessionStart', 'trusted')], { state: 'needs-review', reviewEvents: ['PreToolUse', 'Stop'] }]
  ])('%s', (_name, entries, expected) => {
    expect(summarizeCodexHookTrust(report(entries), EVENTS)).toEqual(expected)
  })
})

describe('readCodexHookTrust is read-only', () => {
  it('leaves every fixture byte-identical with unchanged mtime and creates no files', async () => {
    const hooksPath = join(tmp, 'hooks.json')
    const badHooksPath = join(tmp, 'bad-hooks.json')
    const configPath = join(tmp, 'config.toml')
    const badConfigPath = join(tmp, 'bad-config.toml')
    writeFileSync(hooksPath, JSON.stringify({ hooks: { Stop: [userGroup, tatsuGroup('Stop')], SessionStart: [tatsuGroup('SessionStart')] } }))
    writeFileSync(badHooksPath, '{not json')
    writeFileSync(configPath, stateTable(`${hooksPath}:stop:0:0`, `trusted_hash = "${STOP_HASH}"`))
    writeFileSync(badConfigPath, '[features')

    const files = [hooksPath, badHooksPath, configPath, badConfigPath]
    const snapshot = () => files.map((f) => ({ f, bytes: readFileSync(f), mtimeMs: statSync(f).mtimeMs }))
    const before = snapshot()
    const listingBefore = readdirSync(tmp).sort()

    await readCodexHookTrust({ hooksPath, configPath, isOwnedHandler })
    await readCodexHookTrust({ hooksPath, configPath: badConfigPath, isOwnedHandler })
    await readCodexHookTrust({ hooksPath, configPath: join(tmp, 'missing.toml'), isOwnedHandler })
    await readCodexHookTrust({ hooksPath: badHooksPath, configPath, isOwnedHandler })
    await readCodexHookTrust({ hooksPath: join(tmp, 'missing.json'), configPath, isOwnedHandler })

    expect(snapshot()).toEqual(before)
    expect(readdirSync(tmp).sort()).toEqual(listingBefore)
  })
})

describe('readCodexHookTrust with a symlinked CODEX_HOME', () => {
  it.each([
    ['the realpath key', true, 'trusted'],
    ['the symlink-spelled key', false, 'untrusted']
  ])('trust stored under %s reads %s', async (_name, useRealKey, status) => {
    const real = join(tmp, 'real')
    const link = join(tmp, 'link')
    mkdirSync(real)
    symlinkSync(real, link)
    const home = resolveCodexHome({ CODEX_HOME: link }, '/h')
    const realPrefix = `${realpathSync(real)}/hooks.json:`
    writeFileSync(join(real, 'hooks.json'), JSON.stringify({ hooks: { Stop: [tatsuGroup('Stop')] } }))
    const storedKey = useRealKey ? `${realPrefix}stop:0:0` : `${link}/hooks.json:stop:0:0`
    writeFileSync(join(real, 'config.toml'), stateTable(storedKey, `trusted_hash = "${STOP_HASH}"`))

    const report = await readCodexHookTrust({
      hooksPath: join(home, 'hooks.json'),
      configPath: join(home, 'config.toml'),
      isOwnedHandler
    })

    expect(report.entries).toHaveLength(1)
    expect(report.entries[0].key.startsWith(realPrefix)).toBe(true)
    expect(report.entries[0].status).toBe(status)
  })
})

describe('startCodexHookTrustMonitor', () => {
  const DEBOUNCE = 20
  const QUIET_MS = DEBOUNCE * 5
  const A: CodexHookTrustSummary = { state: 'needs-review', reviewEvents: ['Stop'] }
  const B: CodexHookTrustSummary = { state: 'ok', reviewEvents: [] }
  const waitOpts = { timeout: 3000, interval: 10 }

  function start(opts: Parameters<typeof startCodexHookTrustMonitor>[0]) {
    const m = startCodexHookTrustMonitor(opts)
    monitors.push(m)
    return m
  }

  function sawFile(dir: string, name: string): Promise<void> {
    return new Promise((resolve) => {
      const w = watch(dir, { persistent: false }, (_e, filename) => {
        if (filename === name) resolve()
      })
      watchers.push(w)
    })
  }

  async function writeAndObserve(dir: string, name: string): Promise<void> {
    let done = false
    const seen = sawFile(dir, name).then(() => {
      done = true
    })
    const deadline = Date.now() + 3000
    while (!done && Date.now() < deadline) {
      writeFileSync(join(dir, name), `${Date.now()}\n`)
      await Promise.race([seen, new Promise((r) => setTimeout(r, 50))])
    }
    if (!done) throw new Error(`watcher never saw ${name} in ${dir}`)
  }

  const quiet = () => new Promise((r) => setTimeout(r, QUIET_MS))

  it('refreshes after config.toml or hooks.json changes in the watched dir, not other files', async () => {
    const compute = vi.fn(async () => A)
    start({ watchDir: tmp, compute, onChange: vi.fn(), debounceMs: DEBOUNCE })
    await vi.waitFor(() => expect(compute).toHaveBeenCalledTimes(1), waitOpts)
    await writeAndObserve(tmp, 'warmup.txt')

    await writeAndObserve(tmp, 'other.txt')
    await quiet()
    expect(compute).toHaveBeenCalledTimes(1)

    writeFileSync(join(tmp, 'config.toml'), 'x = 1\n')
    await vi.waitFor(() => expect(compute).toHaveBeenCalledTimes(2), waitOpts)

    writeFileSync(join(tmp, 'hooks.json'), '{}')
    await vi.waitFor(() => expect(compute).toHaveBeenCalledTimes(3), waitOpts)
  })

  it('calls onChange only when the summary changes', async () => {
    let current: CodexHookTrustSummary = A
    const compute = vi.fn(async () => ({ ...current, reviewEvents: [...current.reviewEvents] }))
    const onChange = vi.fn()
    const m = start({ watchDir: tmp, compute, onChange, debounceMs: DEBOUNCE })
    await vi.waitFor(() => expect(onChange).toHaveBeenCalledTimes(1), waitOpts)
    expect(onChange).toHaveBeenLastCalledWith(A)
    await m.refresh()

    const beforeRefresh = compute.mock.calls.length
    await m.refresh()
    expect(compute).toHaveBeenCalledTimes(beforeRefresh + 1)
    expect(onChange).toHaveBeenCalledTimes(1)

    current = B
    await m.refresh()
    expect(onChange).toHaveBeenCalledTimes(2)
    expect(onChange).toHaveBeenLastCalledWith(B)
  })

  it('shares one compute between concurrent refresh() calls', async () => {
    const compute = vi.fn(async () => A)
    const m = start({ watchDir: tmp, compute, onChange: vi.fn(), debounceMs: DEBOUNCE })
    await vi.waitFor(() => expect(compute).toHaveBeenCalledTimes(1), waitOpts)
    await m.refresh()
    const baseline = compute.mock.calls.length

    let release!: (s: CodexHookTrustSummary) => void
    compute.mockImplementationOnce(() => new Promise<CodexHookTrustSummary>((r) => (release = r)))
    const p1 = m.refresh()
    const p2 = m.refresh()
    await vi.waitFor(() => expect(compute).toHaveBeenCalledTimes(baseline + 1), waitOpts)
    release(B)
    await Promise.all([p1, p2])

    expect(compute).toHaveBeenCalledTimes(baseline + 1)
  })

  it('reports unknown when compute throws', async () => {
    const compute = vi.fn(async (): Promise<CodexHookTrustSummary> => {
      throw new Error('boom')
    })
    const onChange = vi.fn()
    const m = start({ watchDir: tmp, compute, onChange, debounceMs: DEBOUNCE })
    await vi.waitFor(() => expect(onChange).toHaveBeenCalledWith({ state: 'unknown', reviewEvents: [] }), waitOpts)
    await expect(m.refresh()).resolves.toBeUndefined()
  })

  it('stop() cancels a pending debounced refresh', async () => {
    const debounceMs = 300
    const compute = vi.fn(async () => A)
    const m = start({ watchDir: tmp, compute, onChange: vi.fn(), debounceMs })
    await vi.waitFor(() => expect(compute).toHaveBeenCalledTimes(1), waitOpts)
    await writeAndObserve(tmp, 'warmup.txt')

    await writeAndObserve(tmp, 'config.toml')
    await new Promise((r) => setTimeout(r, 20))
    m.stop()
    await new Promise((r) => setTimeout(r, debounceMs * 2))

    expect(compute).toHaveBeenCalledTimes(1)
  })

  it('stop() ends watcher-driven refreshes', async () => {
    const compute = vi.fn(async () => A)
    const m = start({ watchDir: tmp, compute, onChange: vi.fn(), debounceMs: DEBOUNCE })
    await vi.waitFor(() => expect(compute).toHaveBeenCalledTimes(1), waitOpts)
    await writeAndObserve(tmp, 'warmup.txt')

    m.stop()
    await writeAndObserve(tmp, 'config.toml')
    await quiet()

    expect(compute).toHaveBeenCalledTimes(1)
  })

  it('tolerates a missing watchDir without creating it, and starts watching once it exists', async () => {
    const dir = join(tmp, 'codex-home')
    const compute = vi.fn(async () => A)
    const m = start({ watchDir: dir, compute, onChange: vi.fn(), debounceMs: DEBOUNCE })
    await vi.waitFor(() => expect(compute).toHaveBeenCalledTimes(1), waitOpts)
    await m.refresh()
    expect(existsSync(dir)).toBe(false)

    mkdirSync(dir)
    const beforeRefresh = compute.mock.calls.length
    await m.refresh()
    const baseline = compute.mock.calls.length
    expect(baseline).toBe(beforeRefresh + 1)
    await writeAndObserve(dir, 'warmup.txt')

    writeFileSync(join(dir, 'config.toml'), 'x = 1\n')
    await vi.waitFor(() => expect(compute).toHaveBeenCalledTimes(baseline + 1), waitOpts)
  })
})
