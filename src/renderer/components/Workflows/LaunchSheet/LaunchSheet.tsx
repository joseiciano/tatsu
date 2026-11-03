import { useCallback, useEffect, useMemo, useState } from 'react'
import { useBackend } from '../../../backend'
import { useHooks, useWorkflowDefinitions } from '../../../store'
import type { ResolvedDefinition } from '../../../../shared/workflow-def'
import { buildInputFields, needsFull as definitionNeedsFull, startBlockReason } from '../launch-sheet-helpers'
import { LaunchSheetForm, type LaunchSheetOption } from './LaunchSheetForm'

interface LaunchSheetProps {
  worktreePath: string
  onClose: () => void
}

interface LoadedDefinition {
  id: string
  hash: string
  definition: ResolvedDefinition | null
}

export function LaunchSheet({ worktreePath, onClose }: LaunchSheetProps): JSX.Element {
  const backend = useBackend()
  const definitions = useWorkflowDefinitions()
  const { consent } = useHooks()
  const [chosenId, setChosenId] = useState<string | null>(null)
  const [loaded, setLoaded] = useState<LoadedDefinition | null>(null)
  const [inputs, setInputs] = useState<Record<string, string>>({})
  const [allowFullFor, setAllowFullFor] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)
  const [installingHooks, setInstallingHooks] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const options = useMemo<LaunchSheetOption[]>(
    () =>
      Object.values(definitions)
        .map((summary) => ({ id: summary.id, name: summary.name, issue: summary.issues[0] ?? null }))
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

  useEffect(() => {
    if (broken || summaryId === undefined || summaryHash === undefined) return
    let cancelled = false
    const settle = (definition: ResolvedDefinition | null): void => {
      if (!cancelled) setLoaded({ id: summaryId, hash: summaryHash, definition })
    }
    backend.getWorkflowDefinition(summaryId).then(
      (detail) => settle(detail?.definition ?? null),
      () => settle(null)
    )
    return () => {
      cancelled = true
    }
  }, [backend, broken, summaryId, summaryHash])

  const loading = !broken && (loaded?.id !== summaryId || loaded?.hash !== summaryHash)
  const definition = !broken && !loading ? loaded?.definition ?? null : null
  const fields = useMemo(() => buildInputFields(definition), [definition])
  const needsFull = definitionNeedsFull(definition)

  const blockReason = submitting
    ? 'Starting…'
    : loading
      ? 'Loading workflow…'
      : startBlockReason({ consent, inputs, needsFull, allowFull, definition })

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
      blockReason={blockReason}
      submitting={submitting}
      error={error}
      onSelect={handleSelect}
      onInputChange={handleInputChange}
      onInstallHooks={() => void handleInstallHooks()}
      onAllowFullChange={(checked) => setAllowFullFor(checked ? confirmKey : null)}
      onStart={() => void handleStart()}
      onClose={onClose}
    />
  )
}
