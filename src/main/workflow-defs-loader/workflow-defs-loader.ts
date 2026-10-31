import { createHash } from 'crypto'
import { mkdirSync, readdirSync, readFileSync, statSync } from 'fs'
import { join } from 'path'
import { log as defaultLog } from '../debug'
import { userDataDir } from '../paths'
import type {
  WorkflowDefinitionDetail,
  WorkflowDefinitionSummary,
  WorkflowsEvent
} from '../../shared/state/workflows'
import { validateWorkflowDefinition, type WorkflowDiagnostic } from '../../shared/workflow-def'

export const MAX_WORKFLOW_FILE_BYTES = 256 * 1024
const MAX_ISSUES = 5
const MAX_ISSUE_LENGTH = 200
const ID_PREFIX = 'personal:'
const PERSONAL_ID_PATTERN = /^personal:[a-z0-9]+(?:-[a-z0-9]+)*$/
const YAML_EXTENSION = /\.ya?ml$/i

type SkipReason = 'empty-id' | 'duplicate-id' | 'not-a-file' | 'too-large' | 'unreadable'

export interface WorkflowDefsLoaderDeps {
  dir: string
  dispatch: (event: WorkflowsEvent) => void
  log?: (category: string, message: string, data?: unknown) => void
}

export interface WorkflowDefsLoader {
  reload(): number
  getDefinition(id: unknown): WorkflowDefinitionDetail | null
}

export function workflowsDir(): string {
  return join(userDataDir(), 'workflows')
}

function stemOf(filename: string): string {
  return filename.replace(YAML_EXTENSION, '')
}

function slugOf(stem: string): string {
  return stem
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
}

function errorCode(err: unknown): string {
  return err instanceof Error && 'code' in err && typeof err.code === 'string' ? err.code : 'unknown'
}

function truncate(text: string): string {
  return text.length <= MAX_ISSUE_LENGTH ? text : `${text.slice(0, MAX_ISSUE_LENGTH - 1)}…`
}

export function capIssues(diagnostics: readonly WorkflowDiagnostic[]): string[] {
  const ordered = [
    ...diagnostics.filter((d) => d.severity === 'error'),
    ...diagnostics.filter((d) => d.severity !== 'error')
  ]
  return ordered.slice(0, MAX_ISSUES).map((d) => truncate(`Line ${d.line}: ${d.message}`))
}

export function createWorkflowDefsLoader(deps: WorkflowDefsLoaderDeps): WorkflowDefsLoader {
  const { dir, dispatch } = deps
  const log = deps.log ?? defaultLog
  let filesById = new Map<string, string>()

  function skip(file: string, reason: SkipReason, extra?: Record<string, unknown>): void {
    log('workflow', 'definition skipped', { file, reason, ...extra })
  }

  function readBytes(file: string): Buffer | SkipReason {
    const path = join(dir, file)
    try {
      const stats = statSync(path)
      if (!stats.isFile()) return 'not-a-file'
      if (stats.size > MAX_WORKFLOW_FILE_BYTES) return 'too-large'
      const bytes = readFileSync(path)
      return bytes.length > MAX_WORKFLOW_FILE_BYTES ? 'too-large' : bytes
    } catch {
      return 'unreadable'
    }
  }

  function buildDetail(file: string, id: string, bytes: Buffer): WorkflowDefinitionDetail {
    const source = bytes.toString('utf-8')
    const result = validateWorkflowDefinition(source)
    const summary: WorkflowDefinitionSummary = {
      id,
      name: result.parsed?.name ?? stemOf(file),
      scope: 'personal',
      path: join(dir, file),
      hash: createHash('sha256').update(bytes).digest('hex'),
      stepIds: result.parsed?.steps.map((step) => step.id) ?? [],
      issues: capIssues(result.diagnostics)
    }
    return { ...result, summary, source }
  }

  function listYamlFiles(): string[] | null {
    try {
      mkdirSync(dir, { recursive: true })
      return readdirSync(dir)
        .filter((file) => YAML_EXTENSION.test(file))
        .sort()
    } catch (err) {
      log('workflow', 'definitions directory unreadable', { code: errorCode(err) })
      return null
    }
  }

  function reload(): number {
    const files = listYamlFiles() ?? []
    const nextFiles = new Map<string, string>()
    const definitions: WorkflowDefinitionSummary[] = []
    let skipped = 0
    for (const file of files) {
      const slug = slugOf(stemOf(file))
      if (!slug) {
        skip(file, 'empty-id')
        skipped += 1
        continue
      }
      const id = `${ID_PREFIX}${slug}`
      if (nextFiles.has(id)) {
        skip(file, 'duplicate-id', { id })
        skipped += 1
        continue
      }
      const bytes = readBytes(file)
      if (typeof bytes === 'string') {
        skip(file, bytes, { id })
        skipped += 1
        continue
      }
      const detail = buildDetail(file, id, bytes)
      const errors = detail.diagnostics.filter((d) => d.severity === 'error').length
      log('workflow', 'definition loaded', {
        file,
        id,
        errors,
        warnings: detail.diagnostics.length - errors,
        unsupported: detail.diagnostics.filter((d) => d.code === 'unsupported-feature').length
      })
      nextFiles.set(id, file)
      definitions.push(detail.summary)
    }
    filesById = nextFiles
    dispatch({ type: 'workflows/definitionsLoaded', payload: { scope: 'personal', definitions } })
    log('workflow', 'definitions scanned', { loaded: definitions.length, skipped })
    return definitions.length
  }

  function getDefinition(id: unknown): WorkflowDefinitionDetail | null {
    if (typeof id !== 'string' || !PERSONAL_ID_PATTERN.test(id)) return null
    const file = filesById.get(id)
    if (!file) return null
    const bytes = readBytes(file)
    if (typeof bytes === 'string') {
      skip(file, bytes, { id })
      return null
    }
    return buildDetail(file, id, bytes)
  }

  return { reload, getDefinition }
}
