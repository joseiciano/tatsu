import { appendFile, mkdir } from 'fs/promises'
import { join } from 'path'
import { ensureRunsExcluded, takeSnapshot } from '../workflow-snapshots'
import type { RunArtifacts } from './types'

export function runArtifactsDir(worktreePath: string, runId: string): string {
  return join(worktreePath, '.harness', 'runs', runId)
}

export function runContextPath(worktreePath: string, runId: string): string {
  return join(runArtifactsDir(worktreePath, runId), 'context.md')
}

export function createGitRunArtifacts(): RunArtifacts {
  return {
    async prepare({ worktreePath, runId }) {
      await ensureRunsExcluded(worktreePath)
      await mkdir(runArtifactsDir(worktreePath, runId), { recursive: true })
    },
    async snapshot({ worktreePath, runId, stepId, n, parent }) {
      const { commit, ref } = await takeSnapshot({ worktree: worktreePath, runId, stepId, n, parent })
      return { commit, ref }
    },
    async appendContext({ contextPath, section }) {
      await appendFile(contextPath, section, 'utf8')
    }
  }
}
