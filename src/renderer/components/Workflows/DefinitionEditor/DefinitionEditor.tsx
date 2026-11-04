import { useEffect, useState, type ReactNode } from 'react'
import { ArrowLeft, Loader2 } from 'lucide-react'
import { useBackend } from '../../../backend'
import type { WorkflowDefinitionDetail } from '../../../../shared/state/workflows'
import { DefinitionEditorForm } from './DefinitionEditorForm'
import { fileStem, NEW_WORKFLOW_TEMPLATE, type DefinitionEditorTarget, type EditedFile } from './definition-editor-model'

export interface DefinitionEditorProps {
  target: DefinitionEditorTarget
  activeRepoRoot: string | null
  onBack: () => void
  onDirtyChange?: (dirty: boolean) => void
}

type LoadState = { status: 'loading' } | { status: 'failed'; message: string } | { status: 'ready'; detail: WorkflowDefinitionDetail }

function editedFile(detail: WorkflowDefinitionDetail): EditedFile {
  const { summary } = detail
  const base = { defId: summary.id, name: fileStem(summary.path) }
  return summary.scope === 'repo' && summary.repoRoot ? { ...base, scope: 'repo', repoRoot: summary.repoRoot } : { ...base, scope: 'personal' }
}

function LoadingEditor({ onBack, children }: { onBack: () => void; children: ReactNode }): JSX.Element {
  return (
    <div className="flex flex-col gap-3">
      <button
        type="button"
        onClick={onBack}
        aria-label="Back to Library"
        className="self-start inline-flex items-center gap-1.5 px-3 py-1.5 text-xs rounded border border-border-strong text-fg hover:bg-panel-raised cursor-pointer transition-colors"
      >
        <ArrowLeft className="icon-xs" aria-hidden="true" />
        Library
      </button>
      {children}
    </div>
  )
}

export function DefinitionEditor({ target, activeRepoRoot, onBack, onDirtyChange }: DefinitionEditorProps): JSX.Element {
  const backend = useBackend()
  const editId = target.kind === 'edit' ? target.defId : null
  const [load, setLoad] = useState<LoadState>({ status: 'loading' })

  useEffect(() => {
    if (editId === null) return
    let live = true
    setLoad({ status: 'loading' })
    backend.getWorkflowDefinition(editId).then(
      (detail) => {
        if (!live) return
        setLoad(detail ? { status: 'ready', detail } : { status: 'failed', message: 'This workflow definition no longer exists.' })
      },
      (err: unknown) => {
        if (!live) return
        setLoad({ status: 'failed', message: `Could not load the workflow definition: ${err instanceof Error && err.message ? err.message : 'the request failed'}` })
      }
    )
    return () => {
      live = false
    }
  }, [backend, editId])

  if (target.kind === 'new') {
    return (
      <DefinitionEditorForm
        initialSource={NEW_WORKFLOW_TEMPLATE}
        initialFile={null}
        activeRepoRoot={activeRepoRoot}
        onBack={onBack}
        onDirtyChange={onDirtyChange}
      />
    )
  }
  if (load.status === 'loading') {
    return (
      <LoadingEditor onBack={onBack}>
        <p role="status" className="inline-flex items-center gap-1.5 text-xs text-dim">
          <Loader2 className="icon-xs animate-spin" aria-hidden="true" />
          Loading workflow definition…
        </p>
      </LoadingEditor>
    )
  }
  if (load.status === 'failed') {
    return (
      <LoadingEditor onBack={onBack}>
        <p role="alert" className="text-xs text-danger break-words">
          {load.message}
        </p>
      </LoadingEditor>
    )
  }
  return (
    <DefinitionEditorForm
      initialSource={load.detail.source}
      initialFile={editedFile(load.detail)}
      activeRepoRoot={activeRepoRoot}
      onBack={onBack}
      onDirtyChange={onDirtyChange}
    />
  )
}
