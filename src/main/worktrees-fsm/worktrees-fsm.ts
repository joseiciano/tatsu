import {
  addWorktree,
  defaultWorktreeDir,
  fetchPullRequestRef,
  listWorktrees,
  localBranchExists,
  removeWorktree,
  runWorktreeScript,
  symlinkClaudeSettings,
  type WorktreeInfo
} from '../worktree'
import { getPRMetadata } from '../github'
import { loadRepoConfig } from '../repo-config'
import type { WorktreeContainers, CreatedWorktreeContainer } from '../worktree-containers'
import { log } from '../debug'
import type { Store } from '../store'
import type { Worktree, PendingWorktree } from '../../shared/state/worktrees'
import { hydratePersistedWorktreeContainers } from '../build-initial-state'
import type { PersistedWorktreeContainer } from '../persistence'

const MAX_SETUP_LOG_CHARS = 100_000
const SETUP_LOG_THROTTLE_MS = 100

/** Sanitize a PR's head branch into a name that's safe as both a git
 *  branch (we're not strict here since git accepts most things) and a
 *  filesystem path component. Slashes survive — git accepts them and
 *  `git worktree add` is happy to nest dirs the same way fresh-start
 *  worktrees do for branches like `feature/foo`. */
export function sanitizeHeadBranchForLocal(headBranch: string): string {
  const cleaned = headBranch
    .replace(/[~^:?*\[\]\\\x00-\x1f\x7f]/g, '')
    .replace(/\.{2,}/g, '.')
    .replace(/@\{/g, '')
    .replace(/^[-.]+|[-.]+$/g, '')
  return cleaned
}

/** Pick a local branch name for a PR's head. Prefers the upstream head
 *  ref directly so the PR poller's ref-match logic just works; falls
 *  back to a `<head>-pr-<N>` suffix when a local branch with that name
 *  already exists (e.g. the user has their own work on that ref). */
export async function chooseLocalPRBranchName(
  repoRoot: string,
  headBranch: string,
  prNumber: number
): Promise<string> {
  const sanitized = sanitizeHeadBranchForLocal(headBranch)
  const candidate = sanitized || `pr-${prNumber}`
  if (await localBranchExists(repoRoot, candidate)) {
    return `${candidate}-pr-${prNumber}`
  }
  return candidate
}

export type PendingOutcome =
  | { id: string; outcome: 'success'; createdPath: string }
  | { id: string; outcome: 'setup-failed'; createdPath: string }
  | { id: string; outcome: 'error'; error: string }

interface WorktreesFSMOptions {
  getRepoRoots: () => string[]
  getPersistedWorktreeContainers?: () => Record<string, PersistedWorktreeContainer> | undefined
  getWorktreeSetupCmd: () => string
  getWorktreeBaseMode: () => 'remote' | 'local'
  getEnableWorktreeContainers?: () => boolean
  containers?: WorktreeContainers
  /** Called after a worktree has been created on disk (and its setup
   * script has run, regardless of script outcome). The host wires this
   * to (a) PR poller refresh and (b) PanesFSM.ensureInitialized so the
   * default Claude+Shell pair is created with the initial prompt. */
  onWorktreeCreated: (params: {
    createdPath: string
    initialPrompt?: string
    teleportSessionId?: string
    agentKind?: 'claude' | 'codex' | 'opencode'
    model?: string
  }) => void
}

/** Owns the pending-creation state machine plus the "refresh the flat
 * worktree list across every known repo" operation. All writes go through
 * the Store. Designed so the renderer awaits `runPending(…)` end-to-end;
 * in-progress status transitions are visible via the usual state events. */
export class WorktreesFSM {
  private store: Store
  private opts: WorktreesFSMOptions

  constructor(store: Store, opts: WorktreesFSMOptions) {
    this.store = store
    this.opts = opts
  }

  /** Walk all known repos, list worktrees, flatten, and dispatch
   * worktrees/listChanged. Safe to call repeatedly. */
  async refreshList(): Promise<Worktree[]> {
    const roots = this.opts.getRepoRoots()
    const results = await Promise.all(
      roots.map((r) =>
        listWorktrees(r).catch((err) => {
          log('worktrees-fsm', `listWorktrees failed for ${r}`, err instanceof Error ? err.message : err)
          return [] as Worktree[]
        })
      )
    )
    const flat = hydratePersistedWorktreeContainers(
      results.flat(),
      this.opts.getPersistedWorktreeContainers?.(),
      this.store.getSnapshot().state.worktrees.list
    )
    this.store.dispatch({ type: 'worktrees/listChanged', payload: flat })
    void this.verifyRecoveredContainers(flat)
    return flat
  }

  private async verifyRecoveredContainers(worktrees: Worktree[]): Promise<void> {
    if (!this.opts.containers) return
    const isContainerRunning = this.opts.containers.isContainerRunning
    const starting = worktrees.filter((wt) => wt.container?.status === 'starting')
    await Promise.all(starting.map(async (wt) => {
      const container = wt.container!
      try {
        const running = await isContainerRunning(container.id)
        this.store.dispatch({
          type: 'worktrees/containerUpdated',
          payload: {
            path: wt.path,
            container: {
              ...container,
              status: running ? 'running' as const : 'stopped' as const,
              error: undefined
            }
          }
        })
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        this.store.dispatch({
          type: 'worktrees/containerUpdated',
          payload: { path: wt.path, container: { ...container, status: 'error' as const, error: message } }
        })
      }
    }))
  }

  dispatchRepos(roots: string[]): void {
    this.store.dispatch({ type: 'worktrees/reposChanged', payload: roots })
  }

  /** Drive the creation FSM to completion. Dispatches state transitions as
   * it goes so the pending screens stay live, and resolves with a terminal
   * outcome that the renderer uses to route focus. The initialPrompt /
   * teleportSessionId are carried through to onWorktreeCreated so the
   * panes layer can embed them in the new Claude tab — the renderer
   * never has to stage them locally. */
  async runPending(params: {
    id: string
    repoRoot: string
    branchName: string
    initialPrompt?: string
    teleportSessionId?: string
    agentKind?: 'claude' | 'codex' | 'opencode'
    model?: string
  }): Promise<PendingOutcome> {
    const { id, repoRoot, branchName, initialPrompt, teleportSessionId, agentKind, model } = params
    const pending: PendingWorktree = {
      id,
      repoRoot,
      branchName,
      status: 'creating',
      initialPrompt,
      teleportSessionId,
      agentKind,
      model
    }
    this.store.dispatch({ type: 'worktrees/pendingAdded', payload: pending })

    try {
      const wtDir = defaultWorktreeDir(repoRoot)
      const mode = this.opts.getWorktreeBaseMode()
      const created = await addWorktree(repoRoot, wtDir, branchName, {
        fetchRemote: mode === 'remote'
      })
      this.store.dispatch({
        type: 'worktrees/pendingUpdated',
        payload: { id, patch: { createdPath: created.path } }
      })
      const container = await this.maybeCreateContainer(id, repoRoot, created.path)
      return await this.finishCreateWithContainerCleanup({
        id,
        repoRoot,
        created,
        container,
        initialPrompt,
        teleportSessionId,
        agentKind,
        model
      })
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      await this.cleanupWorktreeOnFailure(id, repoRoot)
      this.store.dispatch({
        type: 'worktrees/pendingUpdated',
        payload: { id, patch: { status: 'error', error: message } }
      })
      return { id, outcome: 'error', error: message }
    }
  }

  /** Open someone else's PR as a worktree. Fetches the PR head into a
   * local branch named after the PR's actual head ref (or `<head>-pr-<N>`
   * if that name is taken locally), so the PR poller's ref-match logic
   * just works — no per-worktree marker needed. */
  async runPendingPR(params: {
    id: string
    repoRoot: string
    prNumber: number
    initialPrompt?: string
    agentKind?: 'claude' | 'codex' | 'opencode'
    model?: string
  }): Promise<PendingOutcome> {
    const { id, repoRoot, prNumber, initialPrompt, agentKind, model } = params
    // Show *something* while we go ask GitHub for the head ref name.
    let branchName = `pr-${prNumber}`
    const pending: PendingWorktree = {
      id,
      repoRoot,
      branchName,
      status: 'creating',
      initialPrompt,
      agentKind,
      model
    }
    this.store.dispatch({ type: 'worktrees/pendingAdded', payload: pending })

    try {
      const meta = await getPRMetadata(repoRoot, prNumber)
      if (!meta) throw new Error(`Couldn't fetch PR #${prNumber} from GitHub`)

      branchName = await chooseLocalPRBranchName(repoRoot, meta.headBranch, prNumber)
      if (branchName !== pending.branchName) {
        this.store.dispatch({
          type: 'worktrees/pendingUpdated',
          payload: { id, patch: { branchName } }
        })
      }

      await fetchPullRequestRef(repoRoot, prNumber, branchName)

      const wtDir = defaultWorktreeDir(repoRoot)
      const created = await addWorktree(repoRoot, wtDir, branchName, {
        checkoutExisting: true
      })
      this.store.dispatch({
        type: 'worktrees/pendingUpdated',
        payload: { id, patch: { createdPath: created.path } }
      })
      const container = await this.maybeCreateContainer(id, repoRoot, created.path)
      return await this.finishCreateWithContainerCleanup({
        id,
        repoRoot,
        created,
        container,
        initialPrompt,
        agentKind,
        model
      })
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      await this.cleanupWorktreeOnFailure(id, repoRoot)
      this.store.dispatch({
        type: 'worktrees/pendingUpdated',
        payload: { id, patch: { status: 'error', error: message } }
      })
      return { id, outcome: 'error', error: message }
    }
  }

  /** Remove the worktree directory from disk if it was already created
   *  but the overall creation flow failed (e.g. container creation threw).
   *  Reads createdPath from the pending entry so it works from any catch
   *  block without needing a local variable. Best-effort — logs on failure. */
  private async cleanupWorktreeOnFailure(id: string, repoRoot: string): Promise<void> {
    const pendingEntry = this.store.getSnapshot().state.worktrees.pending.find((p) => p.id === id)
    if (!pendingEntry?.createdPath) return
    try {
      await removeWorktree(repoRoot, pendingEntry.createdPath)
    } catch (cleanupErr) {
      log('worktrees-fsm', `worktree cleanup failed for ${pendingEntry.createdPath}`, cleanupErr instanceof Error ? cleanupErr.message : cleanupErr)
    }
  }

  private async finishCreateWithContainerCleanup(args: {
    id: string
    repoRoot: string
    created: WorktreeInfo
    container?: CreatedWorktreeContainer
    initialPrompt?: string
    teleportSessionId?: string
    agentKind?: 'claude' | 'codex' | 'opencode'
    model?: string
  }): Promise<PendingOutcome> {
    try {
      return await this.finishCreate(args)
    } catch (err) {
      if (args.container && this.opts.containers) {
        try {
          await this.opts.containers.stopContainer(args.container.id)
          this.store.dispatch({ type: 'worktrees/containerUpdated', payload: { path: args.created.path, container: undefined } })
        } catch (cleanupErr) {
          log('worktrees-fsm', `container cleanup failed for ${args.container.id}`, cleanupErr instanceof Error ? cleanupErr.message : cleanupErr)
        }
      }
      throw err
    }
  }

  private async maybeCreateContainer(
    id: string,
    repoRoot: string,
    worktreePath: string
  ): Promise<CreatedWorktreeContainer | undefined> {
    if (!this.opts.getEnableWorktreeContainers?.() || !this.opts.containers) return undefined
    const repoCfg = loadRepoConfig(repoRoot)
    if (repoCfg.container?.disabled) return undefined

    this.store.dispatch({
      type: 'worktrees/pendingUpdated',
      payload: { id, patch: { setupLog: 'Creating Docker container...' } }
    })

    log('worktrees-fsm', `Creating Docker container for ${worktreePath}`)
    const config = this.opts.containers.resolveContainerConfig(repoRoot, worktreePath, repoCfg.container)
    return await this.opts.containers.createForWorktree(repoRoot, worktreePath, config)
  }

  /** Shared post-creation steps: setup script + .claude symlink +
   * onWorktreeCreated callback + refreshList + final pending outcome. */
  private async finishCreate(args: {
    id: string
    repoRoot: string
    created: WorktreeInfo
    container?: CreatedWorktreeContainer
    initialPrompt?: string
    teleportSessionId?: string
    agentKind?: 'claude' | 'codex' | 'opencode'
    model?: string
  }): Promise<PendingOutcome> {
    const { id, repoRoot, created, container, initialPrompt, teleportSessionId, agentKind, model } = args

    this.applySharedClaudeSettings(repoRoot, created.path)
    await this.refreshList()

    if (container) {
      this.store.dispatch({
        type: 'worktrees/containerUpdated',
        payload: { path: created.path, container: { ...container, status: 'starting' as const } }
      })
    }

    const setupCmd = this.resolveSetupCmd(repoRoot)
    let setupFailed = false
    if (setupCmd) {
      this.store.dispatch({
        type: 'worktrees/pendingUpdated',
        payload: { id, patch: { status: 'setup', setupLog: '' } }
      })
      const setupLog = this.createSetupLogCollector(id)
      let result: { ok: boolean; exitCode: number; stdout: string; stderr: string }
      if (container) {
        const containers = this.opts.containers
        if (!containers) throw new Error('Container support not available')
        let streamed = false
        const execResult = await containers.execInContainer(
          container.id,
          setupCmd,
          {
            workdir: container.workdir,
            shell: container.shell,
            onOutput: (chunk) => {
              streamed = true
              setupLog.append(chunk)
            }
          }
        )
        result = { ok: execResult.exitCode === 0, exitCode: execResult.exitCode, stdout: execResult.stdout, stderr: execResult.stderr }
        if (!streamed && (execResult.stdout || execResult.stderr)) {
          setupLog.replace(execResult.stderr ? [execResult.stdout, execResult.stderr].filter(Boolean).join('\n') : execResult.stdout)
        }
      } else {
        result = await runWorktreeScript(
          'setup',
          setupCmd,
          { worktreePath: created.path, branch: created.branch, repoRoot },
          (_stream, chunk) => {
            setupLog.append(chunk)
          }
        )
      }
      setupLog.flush()
      setupFailed = !result.ok
      this.store.dispatch({
        type: 'worktrees/pendingUpdated',
        payload: { id, patch: { setupExitCode: result.exitCode } }
      })
    }

    if (container) {
      const containerStillRunning = this.opts.containers
        ? await this.opts.containers.isContainerRunning(container.id)
        : true
      this.store.dispatch({
        type: 'worktrees/containerUpdated',
        payload: { path: created.path, container: { ...container, status: containerStillRunning ? 'running' as const : 'stopped' as const } }
      })
    }

    this.opts.onWorktreeCreated({
      createdPath: created.path,
      initialPrompt,
      teleportSessionId,
      agentKind,
      model
    })

    if (setupFailed) {
      this.store.dispatch({
        type: 'worktrees/pendingUpdated',
        payload: { id, patch: { status: 'setup-failed', createdPath: created.path } }
      })
      return { id, outcome: 'setup-failed', createdPath: created.path }
    }

    this.store.dispatch({ type: 'worktrees/pendingRemoved', payload: id })
    return { id, outcome: 'success', createdPath: created.path }
  }

  private createSetupLogCollector(id: string): { append: (chunk: string) => void; replace: (content: string) => void; flush: () => void } {
    let buffered = ''
    let lastDispatched = ''
    let timer: ReturnType<typeof setTimeout> | undefined
    const cap = (content: string) => content.length > MAX_SETUP_LOG_CHARS ? content.slice(-MAX_SETUP_LOG_CHARS) : content
    const flush = () => {
      if (timer) {
        clearTimeout(timer)
        timer = undefined
      }
      if (buffered === lastDispatched) return
      lastDispatched = buffered
      this.store.dispatch({
        type: 'worktrees/pendingUpdated',
        payload: { id, patch: { setupLog: buffered } }
      })
    }
    return {
      append: (chunk) => {
        buffered = cap(buffered + chunk)
        if (!timer) timer = setTimeout(flush, SETUP_LOG_THROTTLE_MS)
      },
      replace: (content) => {
        buffered = cap(content)
        flush()
      },
      flush
    }
  }

  /** Post-creation work for externally-created worktrees (e.g. the MCP
   * create_worktree tool): symlink shared Claude settings synchronously,
   * then run the setup script. The symlink runs before the first await
   * so callers can fire-and-forget and still rely on it being in place
   * before they spawn the Claude tab. */
  async runWorktreeSetup(ctx: { repoRoot: string; worktreePath: string; branch: string }): Promise<void> {
    this.applySharedClaudeSettings(ctx.repoRoot, ctx.worktreePath)
    const container = await this.getOrCreateExternalContainer(ctx.repoRoot, ctx.worktreePath)
    const setupCmd = this.resolveSetupCmd(ctx.repoRoot)
    if (!setupCmd) return
    if (container) {
      const containers = this.opts.containers
      if (!containers) throw new Error('Container support not available')
      const result = await containers.execInContainer(container.id, setupCmd, {
        workdir: container.workdir,
        shell: container.shell
      })
      if (result.exitCode !== 0) throw new Error(`Setup script failed with exit code ${result.exitCode}`)
      return
    }
    await runWorktreeScript('setup', setupCmd, {
      worktreePath: ctx.worktreePath,
      branch: ctx.branch,
      repoRoot: ctx.repoRoot
    })
  }

  private async getOrCreateExternalContainer(repoRoot: string, worktreePath: string): Promise<CreatedWorktreeContainer | undefined> {
    if (!this.opts.getEnableWorktreeContainers?.() || !this.opts.containers) return undefined
    const repoCfg = loadRepoConfig(repoRoot)
    if (repoCfg.container?.disabled) return undefined
    const existing = this.store.getSnapshot().state.worktrees.list.find((w) => w.path === worktreePath)?.container
    if (existing?.status === 'running' || existing?.status === 'starting') return existing as CreatedWorktreeContainer
    const config = this.opts.containers.resolveContainerConfig(repoRoot, worktreePath, repoCfg.container)
    const container = await this.opts.containers.createForWorktree(repoRoot, worktreePath, config)
    try {
      await this.refreshList()
      this.store.dispatch({
        type: 'worktrees/containerUpdated',
        payload: { path: worktreePath, container: { ...container, status: 'running' as const } }
      })
      return container
    } catch (err) {
      try {
        await this.opts.containers.stopContainer(container.id)
      } catch (cleanupErr) {
        log('worktrees-fsm', `external container cleanup failed for ${container.id}`, cleanupErr instanceof Error ? cleanupErr.message : cleanupErr)
      }
      throw err
    }
  }

  /** Symlink the new worktree's .claude/settings.local.json to main's copy
   * when `shareClaudeSettings` is enabled. Synchronous — callers should
   * invoke this BEFORE spawning the Claude tab so it sees shared settings
   * from its first read. */
  applySharedClaudeSettings(repoRoot: string, worktreePath: string): void {
    const snapshot = this.store.getSnapshot().state
    if (!snapshot.settings.shareClaudeSettings) return
    try {
      const mainWt = snapshot.worktrees.list.find(
        (w) => w.repoRoot === repoRoot && w.isMain
      )
      if (mainWt && mainWt.path !== worktreePath) {
        symlinkClaudeSettings(mainWt.path, worktreePath)
      }
    } catch (err) {
      log('hooks', `symlinkClaudeSettings failed for ${worktreePath}`, err instanceof Error ? err.message : err)
    }
  }

  private resolveSetupCmd(repoRoot: string): string {
    const repoCfg = loadRepoConfig(repoRoot)
    return repoCfg.setupCommand || this.opts.getWorktreeSetupCmd() || ''
  }

  async retryPending(id: string): Promise<PendingOutcome> {
    const current = this.store
      .getSnapshot()
      .state.worktrees.pending.find((p) => p.id === id)
    if (!current) {
      return { id, outcome: 'error', error: 'Pending entry not found' }
    }
    // Clear the terminal-state flags so status transitions look right.
    this.store.dispatch({
      type: 'worktrees/pendingUpdated',
      payload: {
        id,
        patch: { status: 'creating', error: undefined, setupLog: undefined, setupExitCode: undefined }
      }
    })
    const markError = (err: unknown): PendingOutcome => {
      const message = err instanceof Error ? err.message : String(err)
      this.store.dispatch({
        type: 'worktrees/pendingUpdated',
        payload: { id, patch: { status: 'error', error: message } }
      })
      return { id, outcome: 'error', error: message }
    }
    if (current.createdPath) {
      try {
        const existing = this.store.getSnapshot().state.worktrees.list.find((w) => w.path === current.createdPath)
        if (existing) {
          const container = (existing.container?.status === 'running' || existing.container?.status === 'starting')
            ? existing.container as CreatedWorktreeContainer
            : await this.maybeCreateContainer(id, current.repoRoot, existing.path)
          return this.finishCreateWithContainerCleanup({
            id,
            repoRoot: current.repoRoot,
            created: existing,
            container,
            initialPrompt: current.initialPrompt,
            teleportSessionId: current.teleportSessionId,
            agentKind: current.agentKind,
            model: current.model
          })
        }
        const refreshed = await this.refreshList()
        const refreshedExisting = refreshed.find((w) => w.path === current.createdPath)
        if (refreshedExisting) {
          const container = (refreshedExisting.container?.status === 'running' || refreshedExisting.container?.status === 'starting')
            ? refreshedExisting.container as CreatedWorktreeContainer
            : await this.maybeCreateContainer(id, current.repoRoot, refreshedExisting.path)
          return this.finishCreateWithContainerCleanup({
            id,
            repoRoot: current.repoRoot,
            created: refreshedExisting,
            container,
            initialPrompt: current.initialPrompt,
            teleportSessionId: current.teleportSessionId,
            agentKind: current.agentKind,
            model: current.model
          })
        }
      } catch (err) {
        return markError(err)
      }
    }
    return this.runPending({
      id,
      repoRoot: current.repoRoot,
      branchName: current.branchName,
      initialPrompt: current.initialPrompt,
      teleportSessionId: current.teleportSessionId,
      agentKind: current.agentKind,
      model: current.model
    })
  }

  dismissPending(id: string): void {
    this.store.dispatch({ type: 'worktrees/pendingRemoved', payload: id })
  }
}
