import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react'
import { ArrowLeft, FolderGit2, Loader2, Save } from 'lucide-react'
import { useBackend } from '../../../backend'
import { useWorkflowDefinition } from '../../../store'
import { MonacoEditor } from '../../MonacoEditor'
import { WORKFLOW_NO_REPO_DIR_ERROR, type WorkflowSaveDefinitionPayload } from '../../../../shared/state/workflows'
import { validateWorkflowDefinition, type WorkflowValidationResult } from '../../../../shared/workflow-def'
import { diagnosticsToMarkers, splitLines } from '../diagnostics-to-markers'
import { ConfirmDialog } from './ConfirmDialog'
import {
  errorCount,
  planSave,
  problemsLabel,
  repoLabel,
  saveWarnings,
  VALIDATE_DEBOUNCE_MS,
  type EditedFile,
  type SaveDestination
} from './definition-editor-model'

export interface DefinitionEditorFormProps {
  initialSource: string
  initialFile: EditedFile | null
  activeRepoRoot: string | null
  onBack: () => void
  onDirtyChange?: (dirty: boolean) => void
}

interface PendingSave {
  payload: WorkflowSaveDefinitionPayload
  warnings: string[]
}

const BUTTON_CLASS =
  'inline-flex items-center gap-1.5 px-3 py-1.5 text-xs rounded border border-border-strong text-fg hover:bg-panel-raised cursor-pointer transition-colors aria-disabled:opacity-50 aria-disabled:cursor-not-allowed aria-disabled:hover:bg-transparent'

function failure(err: unknown): string {
  return err instanceof Error && err.message ? err.message : 'The request failed'
}

function saveError(error: string, payload: WorkflowSaveDefinitionPayload): string {
  if (error === WORKFLOW_NO_REPO_DIR_ERROR && payload.scope === 'repo') {
    return `${error}. Create and commit a .harness/workflows folder in ${repoLabel(payload.repoRoot)}, or save to your personal workflows instead. Your draft is kept.`
  }
  return `Could not save: ${error}`
}

function savedLabel(payload: WorkflowSaveDefinitionPayload): string {
  return payload.scope === 'repo' ? `Saved to ${repoLabel(payload.repoRoot)}` : 'Saved to your personal workflows'
}

export function DefinitionEditorForm({
  initialSource,
  initialFile,
  activeRepoRoot,
  onBack,
  onDirtyChange
}: DefinitionEditorFormProps): JSX.Element {
  const backend = useBackend()
  const nameId = useId()
  const repoReasonId = useId()
  const [file, setFile] = useState<EditedFile | null>(initialFile)
  const summary = useWorkflowDefinition(file?.defId ?? null)
  const [draft, setDraft] = useState(initialSource)
  const [baseline, setBaseline] = useState(initialSource)
  const [fileName, setFileName] = useState('')
  const [validated, setValidated] = useState<{ source: string; result: WorkflowValidationResult }>(() => ({
    source: initialSource,
    result: validateWorkflowDefinition(initialSource)
  }))
  const [pending, setPending] = useState<PendingSave | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [status, setStatus] = useState<string | null>(null)
  const draftRef = useRef(draft)
  const mounted = useRef(true)
  draftRef.current = draft

  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])

  const dirty = draft !== baseline
  useEffect(() => {
    onDirtyChange?.(dirty)
  }, [dirty, onDirtyChange])

  useEffect(() => {
    if (validated.source === draft) return
    const timer = setTimeout(() => setValidated({ source: draft, result: validateWorkflowDefinition(draft) }), VALIDATE_DEBOUNCE_MS)
    return () => clearTimeout(timer)
  }, [draft, validated.source])

  const diagnostics = validated.result.diagnostics
  const markers = useMemo(() => diagnosticsToMarkers(diagnostics, splitLines(validated.source)), [diagnostics, validated.source])
  const parsedName = validated.result.parsed?.name ?? ''

  const performSave = useCallback(
    (payload: WorkflowSaveDefinitionPayload) => {
      setBusy(true)
      setError(null)
      setStatus(null)
      backend.saveWorkflowDefinition(payload).then(
        (result) => {
          if (!mounted.current) return
          setBusy(false)
          setPending(null)
          if ('error' in result) {
            setError(saveError(result.error, payload))
            return
          }
          const base = { defId: result.defId, name: payload.name }
          setFile(payload.scope === 'repo' ? { ...base, scope: 'repo', repoRoot: payload.repoRoot } : { ...base, scope: 'personal' })
          setBaseline(payload.source)
          setStatus(savedLabel(payload))
        },
        (err: unknown) => {
          if (!mounted.current) return
          setBusy(false)
          setPending(null)
          setError(`Could not save: ${failure(err)}`)
        }
      )
    },
    [backend]
  )

  const requestSave = useCallback(
    (destination: SaveDestination) => {
      if (busy || pending) return
      const source = draftRef.current
      const result = validateWorkflowDefinition(source)
      const plan = planSave({
        destination,
        file,
        source,
        newName: fileName.trim() || (result.parsed?.name ?? ''),
        activeRepoRoot
      })
      if (plan.kind === 'refuse') {
        setStatus(null)
        setError(plan.reason)
        return
      }
      const warnings = saveWarnings(plan.payload, errorCount(result.diagnostics))
      if (warnings.length > 0) {
        setError(null)
        setPending({ payload: plan.payload, warnings })
        return
      }
      performSave(plan.payload)
    },
    [activeRepoRoot, busy, file, fileName, pending, performSave]
  )

  const saveOwn = useCallback(() => requestSave('own'), [requestSave])
  const isRepoFile = file?.scope === 'repo'
  const repoBlocked = !isRepoFile && activeRepoRoot === null
  const title = file ? `Edit ${summary?.name ?? file.name}` : 'New workflow'
  const location = file
    ? file.scope === 'repo'
      ? `${repoLabel(file.repoRoot)} · ${summary?.path ?? file.name}`
      : summary?.path ?? file.name
    : 'Not saved yet'
  const errors = errorCount(diagnostics)

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-3">
        <button type="button" onClick={onBack} aria-label="Back to Library" className={BUTTON_CLASS}>
          <ArrowLeft className="icon-xs" aria-hidden="true" />
          Library
        </button>
        <div className="min-w-0 flex-1">
          <h2 className="text-sm font-medium text-fg-bright break-words">{title}</h2>
          <p className="text-xs text-faint break-all">
            {location}
            {dirty && <span className="text-warning"> · Unsaved changes</span>}
          </p>
        </div>
        <div className="flex flex-wrap gap-1.5">
          <button
            type="button"
            onClick={saveOwn}
            aria-disabled={busy || undefined}
            className={BUTTON_CLASS}
          >
            {busy ? <Loader2 className="icon-xs animate-spin" aria-hidden="true" /> : <Save className="icon-xs" aria-hidden="true" />}
            {isRepoFile ? 'Save to repo' : 'Save'}
          </button>
          {!isRepoFile && (
            <button
              type="button"
              onClick={() => {
                if (!repoBlocked) requestSave('repo')
              }}
              aria-disabled={busy || repoBlocked || undefined}
              aria-describedby={repoBlocked ? repoReasonId : undefined}
              className={BUTTON_CLASS}
            >
              <FolderGit2 className="icon-xs" aria-hidden="true" />
              Save to repo
            </button>
          )}
        </div>
      </div>
      {repoBlocked && (
        <p id={repoReasonId} className="text-xs text-faint">
          Select a worktree to save this workflow to its repository.
        </p>
      )}
      {!file && (
        <div className="flex flex-wrap items-center gap-2">
          <label htmlFor={nameId} className="text-xs text-dim">
            File name
          </label>
          <input
            id={nameId}
            value={fileName}
            onChange={(e) => setFileName(e.target.value)}
            placeholder={parsedName || 'new-workflow'}
            maxLength={100}
            className="min-w-0 flex-1 sm:flex-none sm:w-64 rounded border border-border-strong bg-panel px-2 py-1 text-xs text-fg"
          />
          <span className="text-xs text-faint">Defaults to the workflow’s name:</span>
        </div>
      )}
      {error && (
        <p role="alert" className="text-xs text-danger break-words">
          {error}
        </p>
      )}
      <p role="status" className="text-xs text-success">
        {dirty ? '' : status ?? ''}
      </p>
      <div className="h-[60vh] min-h-64 rounded border border-border overflow-hidden">
        <MonacoEditor
          value={initialSource}
          filePath="workflow.yaml"
          markers={markers}
          ariaLabel="Workflow definition YAML"
          onChange={setDraft}
          onSave={saveOwn}
        />
      </div>
      <section aria-label="Problems" className="flex flex-col gap-1">
        <h3 className="text-xs font-medium text-dim">
          {diagnostics.length === 0 ? 'No problems' : `${problemsLabel(diagnostics.length)}${errors > 0 ? ' · cannot be run' : ''}`}
        </h3>
        {diagnostics.length > 0 && (
          <ul className="flex flex-col gap-0.5">
            {diagnostics.map((d, i) => (
              <li key={i} className={`text-xs break-words ${d.severity === 'error' ? 'text-danger' : 'text-warning'}`}>
                Line {d.line}: {d.message}
              </li>
            ))}
          </ul>
        )}
      </section>
      {pending && (
        <ConfirmDialog
          title={pending.payload.scope === 'repo' ? 'Save to the repository?' : 'Save with problems?'}
          confirmLabel={pending.payload.scope === 'repo' ? 'Save to repo' : 'Save anyway'}
          cancelLabel="Keep editing"
          busy={busy}
          onConfirm={() => performSave(pending.payload)}
          onCancel={() => setPending(null)}
        >
          {pending.warnings.map((warning) => (
            <p key={warning}>{warning}</p>
          ))}
        </ConfirmDialog>
      )}
    </div>
  )
}
