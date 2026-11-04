import { execFile } from 'child_process'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { promisify } from 'util'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { Store } from '../store'
import { WorktreesFSM } from '.'

vi.mock('../debug', () => ({ log: vi.fn() }))
vi.mock('../perf-log', () => ({ perfLog: vi.fn(), getPerfLogFilePath: vi.fn(() => '/tmp/perf.log') }))
vi.mock('../repo-config', () => ({ loadRepoConfig: vi.fn(() => ({})) }))
vi.mock('../github', () => ({ getPRMetadata: vi.fn(async () => null) }))

const execFileAsync = promisify(execFile)

async function git(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await execFileAsync(
    'git',
    ['-c', 'user.email=test@example.com', '-c', 'user.name=Test', '-c', 'commit.gpgsign=false', ...args],
    { cwd }
  )
  return stdout.trim()
}

let root: string
let repo: string
let featureTip: string
let mainTip: string

beforeAll(async () => {
  vi.stubEnv('GIT_CONFIG_GLOBAL', '/dev/null')
  vi.stubEnv('GIT_CONFIG_NOSYSTEM', '1')
  root = realpathSync(mkdtempSync(join(tmpdir(), 'wt-fsm-git-')))
  repo = join(root, 'repo')
  await execFileAsync('git', ['init', '-q', '-b', 'main', repo])
  writeFileSync(join(repo, 'a.txt'), 'a\n')
  await git(repo, 'add', 'a.txt')
  await git(repo, 'commit', '-q', '-m', 'init')
  mainTip = await git(repo, 'rev-parse', 'HEAD')
  await git(repo, 'checkout', '-q', '-b', 'feature-x')
  writeFileSync(join(repo, 'b.txt'), 'b\n')
  await git(repo, 'add', 'b.txt')
  await git(repo, 'commit', '-q', '-m', 'feature')
  featureTip = await git(repo, 'rev-parse', 'HEAD')
  await git(repo, 'checkout', '-q', 'main')
})

afterAll(() => {
  vi.unstubAllEnvs()
  rmSync(root, { recursive: true, force: true })
})

function makeFsm() {
  const reserved: string[] = []
  const released: string[] = []
  const created = vi.fn()
  const fsm = new WorktreesFSM(new Store(), {
    getRepoRoots: () => [repo],
    getWorktreeSetupCmd: () => '',
    getWorktreeBaseMode: () => 'local',
    onWorktreeCreated: created,
    onWorkflowWorktreeReserved: (path) => reserved.push(path),
    onWorkflowWorktreeReleased: (path) => released.push(path)
  })
  return { fsm, reserved, released, created }
}

describe('WorktreesFSM.runPending with baseBranch (real git)', () => {
  it('forks the workflow worktree from the chosen base branch tip', async () => {
    const { fsm, reserved, released, created } = makeFsm()
    const outcome = await fsm.runPending({
      id: 'p1',
      repoRoot: repo,
      branchName: 'wf/demo/item-0a1b2c3d',
      workflow: true,
      baseBranch: 'feature-x'
    })
    expect(outcome).toMatchObject({ outcome: 'success' })
    if (outcome.outcome !== 'success') return
    expect(await git(outcome.createdPath, 'rev-parse', 'HEAD')).toBe(featureTip)
    expect(reserved).toEqual([outcome.createdPath])
    expect(released).toEqual([])
    expect(created).toHaveBeenCalledOnce()
  })

  it('forks from the default HEAD when no baseBranch is given', async () => {
    const { fsm } = makeFsm()
    const outcome = await fsm.runPending({ id: 'p2', repoRoot: repo, branchName: 'wf/demo/plain-0a1b2c3d' })
    expect(outcome).toMatchObject({ outcome: 'success' })
    if (outcome.outcome !== 'success') return
    expect(await git(outcome.createdPath, 'rev-parse', 'HEAD')).toBe(mainTip)
  })

  it.each([
    ['an unknown base', 'nope'],
    ['a leading-dash base', '-x'],
    ['a base containing ..', 'a..b'],
    ['an empty base', '']
  ])('refuses %s without leaking a reservation', async (_label, baseBranch) => {
    const { fsm, reserved, released, created } = makeFsm()
    const branchName = `wf/demo/refused-${Math.random().toString(16).slice(2, 10)}`
    const outcome = await fsm.runPending({ id: 'p3', repoRoot: repo, branchName, workflow: true, baseBranch })
    expect(outcome).toMatchObject({ outcome: 'error' })
    expect(reserved).toEqual([])
    expect(released).toEqual([])
    expect(created).not.toHaveBeenCalled()
    await expect(git(repo, 'rev-parse', '--verify', '--quiet', `refs/heads/${branchName}`)).rejects.toThrow()
  })

  it('refuses a target branch that already exists instead of checking it out', async () => {
    await git(repo, 'branch', 'wf/demo/taken-0a1b2c3d', 'main')
    const { fsm, reserved, released, created } = makeFsm()
    const outcome = await fsm.runPending({
      id: 'p4',
      repoRoot: repo,
      branchName: 'wf/demo/taken-0a1b2c3d',
      workflow: true,
      baseBranch: 'feature-x'
    })
    expect(outcome).toMatchObject({ outcome: 'error', error: expect.stringContaining('already exists') })
    expect(reserved).toEqual([])
    expect(released).toEqual([])
    expect(created).not.toHaveBeenCalled()
  })

  it('releases the reservation when worktree creation fails after the base check passes', async () => {
    const branchName = 'wf/demo/blocked-0a1b2c3d'
    const blockedPath = join(root, 'repo-worktrees', branchName)
    mkdirSync(blockedPath, { recursive: true })
    writeFileSync(join(blockedPath, 'occupied.txt'), 'x\n')
    const { fsm, reserved, released, created } = makeFsm()
    const outcome = await fsm.runPending({ id: 'p6', repoRoot: repo, branchName, workflow: true, baseBranch: 'feature-x' })
    expect(outcome).toMatchObject({ outcome: 'error' })
    expect(reserved).toEqual([blockedPath])
    expect(released).toEqual([blockedPath])
    expect(created).not.toHaveBeenCalled()
  })

  it('keeps the base branch when retrying a failed entry', async () => {
    const { fsm } = makeFsm()
    await git(repo, 'branch', 'wf/demo/retry-0a1b2c3d', 'main')
    const first = await fsm.runPending({
      id: 'p5',
      repoRoot: repo,
      branchName: 'wf/demo/retry-0a1b2c3d',
      workflow: true,
      baseBranch: 'feature-x'
    })
    expect(first).toMatchObject({ outcome: 'error' })
    await git(repo, 'branch', '-D', 'wf/demo/retry-0a1b2c3d')
    const retried = await fsm.retryPending('p5')
    expect(retried).toMatchObject({ outcome: 'success' })
    if (retried.outcome !== 'success') return
    expect(await git(retried.createdPath, 'rev-parse', 'HEAD')).toBe(featureTip)
  })
})
