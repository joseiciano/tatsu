import { useCallback, useEffect, useMemo, useState } from 'react'
import { useBackend } from '../../../backend'
import { useHooks, useWorkflowDefinitions, useWorkflowTrust } from '../../../store'
import type { WorkflowDefinitionDetail, WorkflowScope } from '../../../../shared/state/workflows'
import type { ResolvedDefinition } from '../../../../shared/workflow-def'
import {
  buildInputFields,
  needsFull as definitionNeedsFull,
  startBlockReason,
  trustNeeded,
  trustStepRows
} from '../launch-sheet-helpers'
import { LaunchSheetForm, type LaunchSheetOption, type LaunchSheetTrust } from './LaunchSheetForm'

interface LaunchSheetProps {
  worktreePath: string
  onClose: () => void
}

interface LoadedDefinition {
  id: string
  hash: string
  definition: ResolvedDefinition | null
  source: string
  scope: WorkflowScope
  detailHash: string
}

export function LaunchSheet({ worktreePath, onClose }: LaunchSheetProps): JSX.Element {
  const backend = useBackend()
  const definitions = useWorkflowDefinitions()
  const { consent, codexTrust } = useHooks()
  const [chosenId, setChosenId] = useState<string | null>(null)
  const [loaded, setLoaded] = useState<LoadedDefinition | null>(null)
  const [inputs, setInputs] = useState<Record<string, string>>({})
  const [allowFullFor, setAllowFullFor] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)
  const [installingHooks, setInstallingHooks] = useState(false)
  const [trusting, setTrusting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const options = useMemo<LaunchSheetOption[]>(
    () =>
      Object.values(definitions)
        .map((summary) => ({
          id: summary.id,
          name: summary.name,
          issue: summary.issues[0] ?? null,
          repo: summary.scope === 'repo'
        }))
        .sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id)),
    [definitions]
  )

  const selectedId =
    chosenId !== null && Object.hasOwn(definitions, chosenId)
      ? chosenId
      : options.find((option) => option.issue === null)?.id ?? ''
  const summary = selectedId === '' ? null : definitions[selectedId]
  const broken = !summary || summary.issues.length > 0
  const summaryId = summary?.id
  const summaryHash = summary?.hash
  const confirmKey = summaryId !== undefined && summaryHash !== undefined ? `${summaryId}@${summaryHash}` : null
  const allowFull = confirmKey !== null && allowFullFor === confirmKey
  const trustedHash = useWorkflowTrust(summaryId ?? null)

  useEffect(() => {
    if (broken || summaryId === undefined || summaryHash === undefined) return
    let cancelled = false
    const settle = (detail: WorkflowDefinitionDetail | null): void => {
      if (cancelled) return
      setLoaded({
        id: summaryId,
        hash: summaryHash,
        definition: detail?.definition ?? null,
        source: detail?.source ?? '',
        scope: detail?.summary.scope ?? 'repo',
        detailHash: detail?.summary.hash ?? ''
      })
    }
    backend.getWorkflowDefinition(summaryId).then(settle, () => settle(null))
    return () => {
      cancelled = true
    }
  }, [backend, broken, summaryId, summaryHash])

  const loading = !broken && (loaded?.id !== summaryId || loaded?.hash !== summaryHash)
  const definition = !broken && !loading ? loaded?.definition ?? null : null
  const fields = useMemo(() => buildInputFields(definition), [definition])
  const needsFull = definitionNeedsFull(definition)
  const needsTrust =
    loaded !== null && definition !== null
      ? trustNeeded({ scope: loaded.scope, hash: loaded.detailHash, trustedHash })
      : false
  const trustRows = useMemo(() => (definition ? trustStepRows(definition) : []), [definition])
  const trust: LaunchSheetTrust | null =
    needsTrust && loaded !== null ? { source: loaded.source, rows: trustRows, trusting } : null

  const blockReason = submitting
    ? 'Starting…'
    : loading
      ? 'Loading workflow…'
      : startBlockReason({ consent, codexTrust, inputs, needsFull, allowFull, trustNeeded: needsTrust, definition })

  const handleSelect = useCallback((id: string) => {
    setChosenId(id)
    setInputs({})
    setAllowFullFor(null)
    setError(null)
  }, [])

  const handleInputChange = useCallback((name: string, value: string) => {
    setInputs((prev) => ({ ...prev, [name]: value }))
  }, [])

  const handleInstallHooks = useCallback(async () => {
    setInstallingHooks(true)
    setError(null)
    try {
      if (!(await backend.acceptHooks())) setError('Could not install hooks')
    } catch {
      setError('Could not install hooks')
    } finally {
      setInstallingHooks(false)
    }
  }, [backend])

  const trustId = loaded?.id
  const trustHash = loaded?.detailHash
  const handleTrust = useCallback(async () => {
    if (trustId === undefined || trustHash === undefined || trustHash === '') return
    setTrusting(true)
    setError(null)
    try {
      const response = await backend.trustWorkflowDefinition(trustId, trustHash)
      if ('error' in response) setError(response.error)
    } catch {
      setError('Could not trust the workflow definition')
    } finally {
      setTrusting(false)
    }
  }, [backend, trustId, trustHash])

  const handleStart = useCallback(async () => {
    if (blockReason !== null || summaryId === undefined) return
    const declared = Object.fromEntries(fields.map(({ name }) => [name, inputs[name] ?? '']))
    setSubmitting(true)
    setError(null)
    try {
      const response = await backend.startWorkflowRun({
        defId: summaryId,
        worktreePath,
        inputs: declared,
        ...(needsFull && allowFull ? { allowFull: true } : {})
      })
      if ('runId' in response) {
        onClose()
        return
      }
      setError(response.error)
    } catch {
      setError('Could not start the workflow')
    } finally {
      setSubmitting(false)
    }
  }, [backend, blockReason, summaryId, fields, inputs, worktreePath, needsFull, allowFull, onClose])

  return (
    <LaunchSheetForm
      worktreeLabel={worktreePath.split('/').filter(Boolean).pop() ?? worktreePath}
      options={options}
      selectedId={selectedId}
      fields={fields}
      inputs={inputs}
      consent={consent}
      installingHooks={installingHooks}
      needsFull={needsFull}
      allowFull={allowFull}
      trust={trust}
      blockReason={blockReason}
      submitting={submitting}
      error={error}
      onSelect={handleSelect}
      onInputChange={handleInputChange}
      onInstallHooks={() => void handleInstallHooks()}
      onAllowFullChange={(checked) => setAllowFullFor(checked ? confirmKey : null)}
      onTrust={() => void handleTrust()}
      onStart={() => void handleStart()}
      onClose={onClose}
    />
  )
}
