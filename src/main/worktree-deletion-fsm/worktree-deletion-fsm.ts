import { removeWorktree, runWorktreeScript } from '../worktree'
import { loadRepoConfig } from '../repo-config'
import { log } from '../debug'
import type { Store } from '../store'
import type { WorktreesFSM } from '../worktrees-fsm'
import type { WorktreeContainers } from '../worktree-containers'
import type { PendingDeletion } from '../../shared/state/worktrees'

const MAX_TEARDOWN_LOG_CHARS = 100_000
const TEARDOWN_LOG_THROTTLE_MS = 100

interface WorktreeDeletionFSMOptions {
  getGlobalTeardownCmd: () => string
  worktreesFSM: WorktreesFSM
  containers?: Pick<WorktreeContainers, 'stopContainer' | 'execInContainer'>
}

/** Owns the pending-deletion state machine. Each enqueue runs independently
 * (parallel deletions are fine — they touch disjoint paths), streams
 * teardown script output into the store, and refreshes the worktree list
 * on completion. Lives entirely in main so deletions keep running if the
 * user navigates away; the renderer just reads state. */
export class WorktreeDeletionFSM {
  private store: Store
  private opts: WorktreeDeletionFSMOptions

  constructor(store: Store, opts: WorktreeDeletionFSMOptions) {
    this.store = store
    this.opts = opts
  }

  /** Kick off a deletion. Returns immediately after seeding the pending
   * entry; the actual work runs in the background. */
  enqueue(params: {
    repoRoot: string
    path: string
    branch: string
    force?: boolean
  }): void {
    void this.run(params)
  }

  dismiss(path: string): void {
    this.store.dispatch({ type: 'worktrees/pendingDeletionRemoved', payload: path })
  }

  private async run(params: {
    repoRoot: string
    path: string
    branch: string
    force?: boolean
  }): Promise<void> {
    const { repoRoot, path, branch, force } = params
    const repoCfg = loadRepoConfig(repoRoot)
    const teardownCmd = repoCfg.teardownCommand || this.opts.getGlobalTeardownCmd() || ''
    const hasTeardown = Boolean(teardownCmd.trim())
    const container = this.store.getSnapshot().state.worktrees.list.find((w) => w.path === path)?.container

    const initial: PendingDeletion = {
      path,
      repoRoot,
      branch,
      phase: hasTeardown ? 'running-teardown' : 'removing-worktree',
      teardownLog: hasTeardown ? '' : undefined
    }
    this.store.dispatch({ type: 'worktrees/pendingDeletionStarted', payload: initial })

    try {
      if (hasTeardown) {
        const teardownLog = this.createTeardownLogCollector(path)
        try {
          const result = container && this.opts.containers && typeof this.opts.containers.execInContainer === 'function'
            ? await this.opts.containers.execInContainer(container.id, teardownCmd, {
              workdir: container.workdir,
              shell: container.shell,
              onOutput: (chunk) => {
                teardownLog.append(chunk)
              }
            })
            : await runWorktreeScript(
              'teardown',
              teardownCmd,
              { worktreePath: path, branch, repoRoot },
              (_stream, chunk) => {
                teardownLog.append(chunk)
              }
            )
          teardownLog.flush()
          this.store.dispatch({
            type: 'worktrees/pendingDeletionUpdated',
            payload: { path, patch: { teardownExitCode: result.exitCode } }
          })
        } catch (teardownErr) {
          teardownLog.flush()
          const message = teardownErr instanceof Error ? teardownErr.message : String(teardownErr)
          log('worktree-deletion-fsm', `teardown exec failed for ${path}; continuing: ${message}`)
        }
        // Teardown failure is non-fatal — we still want to remove the
        // worktree, matching the previous synchronous behavior.
      }

      this.store.dispatch({
        type: 'worktrees/pendingDeletionUpdated',
        payload: { path, patch: { phase: 'removing-worktree' } }
      })
      if (container && this.opts.containers) {
        try {
          await this.opts.containers.stopContainer(container.id)
        } catch (cleanupErr) {
          const message = cleanupErr instanceof Error ? cleanupErr.message : String(cleanupErr)
          log('worktree-deletion-fsm', `container cleanup failed for ${container.id}; continuing worktree deletion: ${message}`)
        }
        this.store.dispatch({ type: 'worktrees/containerUpdated', payload: { path, container: undefined } })
      }
      await removeWorktree(repoRoot, path, force)

      // Clear the pending entry and refresh the list so the sidebar row
      // disappears in one render.
      this.store.dispatch({ type: 'worktrees/pendingDeletionRemoved', payload: path })
      await this.opts.worktreesFSM.refreshList()
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      log('worktree-deletion-fsm', `deletion failed for ${path}: ${message}`)
      this.store.dispatch({
        type: 'worktrees/pendingDeletionUpdated',
        payload: { path, patch: { phase: 'failed', error: message } }
      })
    }
  }
  private createTeardownLogCollector(path: string): { append: (chunk: string) => void; flush: () => void } {
    let buffered = ''
    let lastDispatched = ''
    let timer: ReturnType<typeof setTimeout> | undefined
    const cap = (content: string) => content.length > MAX_TEARDOWN_LOG_CHARS ? content.slice(-MAX_TEARDOWN_LOG_CHARS) : content
    const flush = () => {
      if (timer) {
        clearTimeout(timer)
        timer = undefined
      }
      if (buffered === lastDispatched) return
      lastDispatched = buffered
      this.store.dispatch({
        type: 'worktrees/pendingDeletionUpdated',
        payload: { path, patch: { teardownLog: buffered } }
      })
    }
    return {
      append: (chunk) => {
        buffered = cap(buffered + chunk)
        if (!timer) timer = setTimeout(flush, TEARDOWN_LOG_THROTTLE_MS)
      },
      flush
    }
  }
}
