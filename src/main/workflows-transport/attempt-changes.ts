import { realpath, stat } from 'fs/promises'
import { snapshotRefName } from '../workflow-snapshots'
import type { WorkflowRunAttempt, WorkflowRunLookup } from '../workflow-run-records'
import { getRangeChangedFiles, readBlobAtCommit, resolveCommitRef, type BlobAtCommit } from '../worktree'
import type {
  WorkflowAttemptChangedFilesResponse,
  WorkflowAttemptFileDiffResponse,
  WorkflowSnapshotRef
} from '../../shared/state/workflows'

export const ATTEMPT_CHANGED_FILES_MAX = 500
export const ATTEMPT_FILE_DIFF_MAX_BYTES = 1024 * 1024
const PATH_MAX_CHARS = 4096
const OBJECT_ID = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/

export const ATTEMPT_CHANGES_ERRORS = {
  invalid: 'invalid request',
  unknownAttempt: 'Unknown attempt',
  noSnapshot: 'No snapshot for this attempt',
  snapshotMissing: 'snapshot missing',
  worktreeMissing: 'The worktree for this run is gone',
  readFailed: 'Could not read the changes for this attempt',
  notChanged: 'That file is not among this attempt’s changes',
  tooLarge: 'File too large to show',
  binary: 'Binary file; no text diff to show'
} as const

type Failure = { error: string }

interface ResolvedRange {
  worktreePath: string
  base: string
  head: string
}

function fail(error: string): Failure {
  return { error }
}

function snapshotRefFor({ run, attempt }: WorkflowRunAttempt, slot: 'base' | 'head'): string | null {
  const n = 2 * (attempt.n - 1) + (slot === 'head' ? 1 : 0)
  try {
    return snapshotRefName({ runId: run.runId, stepId: attempt.stepId, n })
  } catch {
    return null
  }
}

async function verifySnapshot(
  worktreePath: string,
  snapshot: WorkflowSnapshotRef,
  expectedRef: string | null
): Promise<boolean> {
  if (typeof snapshot.commit !== 'string' || !OBJECT_ID.test(snapshot.commit)) return false
  if (expectedRef === null || snapshot.ref !== expectedRef) return false
  return (await resolveCommitRef({ worktreePath, ref: expectedRef })) === snapshot.commit
}

async function worktreeDir(path: unknown): Promise<string | null> {
  if (typeof path !== 'string' || path === '') return null
  try {
    const resolved = await realpath(path)
    return (await stat(resolved)).isDirectory() ? resolved : null
  } catch {
    return null
  }
}

async function resolveRange(runs: WorkflowRunLookup, attemptId: unknown): Promise<ResolvedRange | Failure> {
  const found = await runs.getAttempt(attemptId)
  if (!found) return fail(ATTEMPT_CHANGES_ERRORS.unknownAttempt)
  const { baseSnapshot, headSnapshot } = found.attempt
  if (!baseSnapshot || !headSnapshot) return fail(ATTEMPT_CHANGES_ERRORS.noSnapshot)
  const worktreePath = await worktreeDir(found.run.worktreePath)
  if (worktreePath === null) return fail(ATTEMPT_CHANGES_ERRORS.worktreeMissing)
  const [baseOk, headOk] = await Promise.all([
    verifySnapshot(worktreePath, baseSnapshot, snapshotRefFor(found, 'base')),
    verifySnapshot(worktreePath, headSnapshot, snapshotRefFor(found, 'head'))
  ])
  if (!baseOk || !headOk) return fail(ATTEMPT_CHANGES_ERRORS.snapshotMissing)
  return { worktreePath, base: baseSnapshot.commit, head: headSnapshot.commit }
}

async function changedFiles(range: ResolvedRange): Promise<WorkflowAttemptChangedFilesResponse> {
  try {
    return await getRangeChangedFiles({ ...range, maxFiles: ATTEMPT_CHANGED_FILES_MAX })
  } catch {
    return fail(ATTEMPT_CHANGES_ERRORS.readFailed)
  }
}

function isRequestPath(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= PATH_MAX_CHARS && !value.includes('\0')
}

function sideText(blob: BlobAtCommit): string | Failure {
  if (blob.kind === 'ok') return blob.text
  return fail(blob.kind === 'too-large' ? ATTEMPT_CHANGES_ERRORS.tooLarge : ATTEMPT_CHANGES_ERRORS.readFailed)
}

export async function getAttemptChangedFiles(
  runs: WorkflowRunLookup,
  attemptId: unknown
): Promise<WorkflowAttemptChangedFilesResponse> {
  const range = await resolveRange(runs, attemptId)
  return 'error' in range ? range : changedFiles(range)
}

export async function getAttemptFileDiff(
  runs: WorkflowRunLookup,
  attemptId: unknown,
  path: unknown
): Promise<WorkflowAttemptFileDiffResponse> {
  if (!isRequestPath(path)) return fail(ATTEMPT_CHANGES_ERRORS.invalid)
  const range = await resolveRange(runs, attemptId)
  if ('error' in range) return range
  const listed = await changedFiles(range)
  if ('error' in listed) return listed
  const file = listed.files.find((candidate) => candidate.path === path)
  if (!file) return fail(ATTEMPT_CHANGES_ERRORS.notChanged)
  if (file.additions === null || file.deletions === null) return fail(ATTEMPT_CHANGES_ERRORS.binary)
  const read = (commit: string): Promise<BlobAtCommit> =>
    readBlobAtCommit({ worktreePath: range.worktreePath, commit, path, maxBytes: ATTEMPT_FILE_DIFF_MAX_BYTES })
  const [original, modified] = await Promise.all([
    file.status === 'added' ? '' : read(range.base).then(sideText),
    file.status === 'deleted' ? '' : read(range.head).then(sideText)
  ])
  if (typeof original !== 'string') return original
  if (typeof modified !== 'string') return modified
  return { original, modified }
}
