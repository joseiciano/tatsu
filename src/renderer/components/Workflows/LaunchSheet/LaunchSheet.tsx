import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useBackend } from '../../../backend'
import { sanitizeBranchInput } from '../../../branch-name'
import { useAppState, useHooks, useWorkflowDefinitions, useWorkflowTrust, useWorktreeRepoRoot } from '../../../store'
import {
  capPermissions,
  isWorkflowInputNumber,
  type WorkflowDefinitionDetail,
  type WorkflowScope
} from '../../../../shared/state/workflows'
import type { ResolvedDefinition, WorkflowAgent } from '../../../../shared/workflow-def'
import {
  LAUNCH_BUDGET_INVALID_REASON,
  budgetCostNotice,
  buildInputFields,
  definitionsForRepo,
  existingWorktreeOptions,
  hasGate,
  inputTrustChecks,
  inputTrustKey,
  needsFull as definitionNeedsFull,
  overrideRows,
  parseLaunchBudget,
  resolveOverrides,
  startBlockReason,
  targetBlockReason,
  trustNeeded,
  trustStepRows,
  untrustedInputs,
  workflowBranchName,
  type InputTrustVerdict,
  type LaunchTarget,
  type OverrideDraft
} from '../launch-sheet-helpers'
import {
  LaunchSheetForm,
  type LaunchSheetOption,
  type LaunchSheetTargetView,
  type LaunchSheetTrust,
  type TargetMode
} from './LaunchSheetForm'

interface LaunchSheetProps {
  worktreePath?: string
  defId?: string
  onClose: () => void
  onStarted?: (worktreePath: string) => void
}

interface LoadedDefinition {
  id: string
  hash: string
  definition: ResolvedDefinition | null
  source: string
  scope: WorkflowScope
  detailHash: string
}

interface BudgetDraft {
  key: string
  text: string
}

interface OverrideDrafts {
  key: string
  drafts: Record<string, OverrideDraft>
}

const NO_DRAFTS: Record<string, OverrideDraft> = {}
const INPUT_TRUST_DEBOUNCE_MS = 250

function basename(path: string): string {
  return path.split('/').filter(Boolean).pop() ?? path
}

function newBranchSuffix(): string {
  return crypto.randomUUID().slice(0, 8)
}

export function LaunchSheet({ worktreePath, defId, onClose, onStarted }: LaunchSheetProps): JSX.Element {
  const backend = useBackend()
  const definitions = useWorkflowDefinitions()
  const { consent, codexTrust } = useHooks()
  const repoRoots = useAppState((s) => s.worktrees.repoRoots)
  const worktrees = useAppState((s) => s.worktrees.list)
  const runs = useAppState((s) => s.workflows.runs)
  const presetRepo = useWorktreeRepoRoot(worktreePath ?? null)
  const [repoChoice, setRepoChoice] = useState<string | null>(() =>
    defId !== undefined && Object.hasOwn(definitions, defId) ? definitions[defId].repoRoot ?? null : null
  )
  const [mode, setMode] = useState<TargetMode>('new')
  const [branchDraft, setBranchDraft] = useState<string | null>(null)
  const [branchSuffix] = useState(newBranchSuffix)
  const [existingChoice, setExistingChoice] = useState<string | null>(null)
  const mounted = useRef(true)
  const [chosenId, setChosenId] = useState<string | null>(defId ?? null)
  const [loaded, setLoaded] = useState<LoadedDefinition | null>(null)
  const [inputs, setInputs] = useState<Record<string, string>>({})
  const [allowFullFor, setAllowFullFor] = useState<string | null>(null)
  const [autopilotFor, setAutopilotFor] = useState<string | null>(null)
  const [budgetDraft, setBudgetDraft] = useState<BudgetDraft | null>(null)
  const [overrideDrafts, setOverrideDrafts] = useState<OverrideDrafts | null>(null)
  const [overridesOpen, setOverridesOpen] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [installingHooks, setInstallingHooks] = useState(false)
  const [trusting, setTrusting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [inputVerdicts, setInputVerdicts] = useState<Record<string, InputTrustVerdict>>({})
  const [fullDemandedFor, setFullDemandedFor] = useState<string | null>(null)
  const requestedTrust = useRef(new Set<string>())

  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])

  const repoRoot =
    worktreePath !== undefined
      ? presetRepo
      : repoChoice !== null && repoRoots.includes(repoChoice)
        ? repoChoice
        : repoRoots[0] ?? null

  const options = useMemo<LaunchSheetOption[]>(
    () =>
      definitionsForRepo(definitions, repoRoot)
        .map((summary) => ({
          id: summary.id,
          name: summary.name,
          issue: summary.issues[0] ?? null,
          repo: summary.scope === 'repo'
        }))
        .sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id)),
    [definitions, repoRoot]
  )

  const selectedId =
    chosenId !== null && options.some((option) => option.id === chosenId)
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
  const drafts = confirmKey !== null && overrideDrafts?.key === confirmKey ? overrideDrafts.drafts : NO_DRAFTS
  const resolved = useMemo(() => (definition ? resolveOverrides(definition, drafts) : null), [definition, drafts])
  const effective = resolved?.effective ?? null
  const overrides = resolved?.overrides
  const overrideList = useMemo(() => overrideRows(definition), [definition])
  const budgetShown = overrideList.length > 0
  const budgetText = budgetShown && confirmKey !== null && budgetDraft?.key === confirmKey ? budgetDraft.text : ''
  const budget = parseLaunchBudget(budgetText)
  const budgetUsd = budget.kind === 'ok' ? budget.usd : null
  const budgetNotice = useMemo(() => budgetCostNotice(resolved), [resolved])
  const trustChecks = useMemo(() => inputTrustChecks(fields, inputs), [fields, inputs])
  const untrusted = useMemo(
    () => untrustedInputs(trustChecks, repoRoot, inputVerdicts),
    [trustChecks, repoRoot, inputVerdicts]
  )
  const pendingTrustKeys = (repoRoot === null ? [] : trustChecks.map((check) => inputTrustKey(repoRoot, check)))
    .filter((key) => !Object.hasOwn(inputVerdicts, key))
    .join('\0')

  useEffect(() => {
    if (repoRoot === null || pendingTrustKeys === '') return
    const timer = setTimeout(() => {
      for (const check of trustChecks) {
        const key = inputTrustKey(repoRoot, check)
        if (requestedTrust.current.has(key) || !isWorkflowInputNumber(check.number)) continue
        requestedTrust.current.add(key)
        const settle = (verdict: InputTrustVerdict): void => {
          if (mounted.current) setInputVerdicts((prev) => ({ ...prev, [key]: verdict }))
        }
        backend.checkWorkflowInputTrust(repoRoot, check.type, check.number).then(
          (response) => settle('trusted' in response ? (response.trusted ? 'trusted' : 'untrusted') : 'unknown'),
          () => settle('unknown')
        )
      }
    }, INPUT_TRUST_DEBOUNCE_MS)
    return () => clearTimeout(timer)
  }, [backend, repoRoot, pendingTrustKeys, trustChecks])

  const capsFull =
    (confirmKey === null || fullDemandedFor !== confirmKey) &&
    untrusted.some((check) => repoRoot === null || inputVerdicts[inputTrustKey(repoRoot, check)] !== 'unknown')
  const capped = capsFull && effective !== null ? capPermissions(effective) : effective
  const needsFull = definitionNeedsFull(capped)
  const fullHidden = capsFull && definitionNeedsFull(effective)
  const gated = hasGate(effective)
  const autopilotBlocked = untrusted.length > 0
  const autopilot = gated && !autopilotBlocked && confirmKey !== null && autopilotFor === confirmKey
  const needsTrust =
    loaded !== null && definition !== null
      ? trustNeeded({ scope: loaded.scope, hash: loaded.detailHash, trustedHash })
      : false
  const trustRows = useMemo(() => (definition ? trustStepRows(definition) : []), [definition])
  const trust: LaunchSheetTrust | null =
    needsTrust && loaded !== null ? { source: loaded.source, rows: trustRows, trusting } : null

  const existingOptions = useMemo(
    () => (worktreePath === undefined ? existingWorktreeOptions({ worktrees, repoRoot, runs }) : []),
    [worktreePath, worktrees, repoRoot, runs]
  )
  const existingPath =
    existingChoice !== null && existingOptions.some((option) => option.path === existingChoice)
      ? existingChoice
      : existingOptions[0]?.path ?? null
  const branchName = branchDraft ?? workflowBranchName(summary?.name ?? '', branchSuffix)
  const target: LaunchTarget =
    worktreePath !== undefined
      ? { kind: 'preset', worktreePath }
      : mode === 'new'
        ? { kind: 'new', repoRoot, branchName }
        : { kind: 'existing', repoRoot, worktreePath: existingPath }
  const targetReason = targetBlockReason({ target, repoRoots, worktrees, runs })

  const blockReason = submitting
    ? 'Starting…'
    : targetReason ??
      (loading
        ? 'Loading workflow…'
        : resolved?.reason ??
          (budget.kind === 'invalid' ? LAUNCH_BUDGET_INVALID_REASON : null) ??
          startBlockReason({
            consent,
            codexTrust,
            inputs,
            needsFull,
            allowFull,
            trustNeeded: needsTrust,
            definition: effective
          }))

  const handleSelect = useCallback((id: string) => {
    setChosenId(id)
    setInputs({})
    setAllowFullFor(null)
    setAutopilotFor(null)
    setBudgetDraft(null)
    setOverrideDrafts(null)
    setError(null)
  }, [])

  const updateDraft = useCallback(
    (stepId: string, update: (draft: OverrideDraft) => OverrideDraft) => {
      if (confirmKey === null) return
      setOverrideDrafts((prev) => {
        const base = prev?.key === confirmKey ? prev.drafts : {}
        const current = Object.hasOwn(base, stepId) ? base[stepId] : {}
        return { key: confirmKey, drafts: { ...base, [stepId]: update(current) } }
      })
    },
    [confirmKey]
  )

  const handleOverrideAgent = useCallback(
    (stepId: string, agent: WorkflowAgent) => updateDraft(stepId, () => ({ agent })),
    [updateDraft]
  )

  const handleOverrideModel = useCallback(
    (stepId: string, model: string) => updateDraft(stepId, (draft) => ({ ...draft, model })),
    [updateDraft]
  )

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

  const createWorktree = useCallback(
    async (root: string, branch: string): Promise<string | null> => {
      const id = `pending:${crypto.randomUUID()}`
      const created = await backend.runPendingWorktree({ id, repoRoot: root, branchName: branch, workflow: true })
      if (!mounted.current) return null
      if (created.outcome !== 'success') void backend.dismissPendingWorktree(id)
      if (created.outcome === 'error') {
        setError(created.error)
        return null
      }
      setRepoChoice(root)
      setMode('existing')
      setExistingChoice(created.createdPath)
      return created.createdPath
    },
    [backend]
  )

  const handleStart = useCallback(async () => {
    if (blockReason !== null || summaryId === undefined) return
    const declared = Object.fromEntries(fields.map(({ name }) => [name, inputs[name] ?? '']))
    setSubmitting(true)
    setError(null)
    try {
      const path =
        target.kind === 'new'
          ? target.repoRoot === null
            ? null
            : await createWorktree(target.repoRoot, target.branchName)
          : target.worktreePath
      if (path === null || !mounted.current) return
      const response = await backend.startWorkflowRun({
        defId: summaryId,
        worktreePath: path,
        inputs: declared,
        ...(needsFull && allowFull ? { allowFull: true } : {}),
        ...(overrides ? { overrides } : {}),
        ...(autopilot ? { autopilot: true } : {}),
        ...(budgetUsd !== null ? { budgetUsd } : {})
      })
      if (!mounted.current) return
      if ('runId' in response) {
        onStarted?.(path)
        onClose()
        return
      }
      setError(response.error)
      if (fullHidden) {
        setFullDemandedFor(confirmKey)
        setInputVerdicts({})
        requestedTrust.current.clear()
      }
    } catch {
      if (mounted.current) setError('Could not start the workflow')
    } finally {
      if (mounted.current) setSubmitting(false)
    }
  }, [
    backend,
    blockReason,
    summaryId,
    fields,
    inputs,
    target,
    createWorktree,
    needsFull,
    allowFull,
    fullHidden,
    confirmKey,
    overrides,
    autopilot,
    budgetUsd,
    onStarted,
    onClose
  ])

  const targetView: LaunchSheetTargetView =
    worktreePath !== undefined
      ? { kind: 'preset', label: basename(worktreePath) }
      : {
          kind: 'choose',
          repos: repoRoots.map((root) => ({ root, label: basename(root) })),
          repoRoot,
          mode,
          branchName,
          branchInvalid: mode === 'new' && targetReason !== null,
          existing: existingOptions,
          existingPath
        }

  const filesRoot = target.kind === 'new' ? target.repoRoot : target.worktreePath

  return (
    <LaunchSheetForm
      target={targetView}
      pickerRoots={{ repoRoot, filesRoot }}
      options={options}
      selectedId={selectedId}
      fields={fields}
      inputs={inputs}
      consent={consent}
      installingHooks={installingHooks}
      needsFull={needsFull}
      allowFull={allowFull}
      trust={trust}
      untrustedInputs={untrusted.map(({ name, type }) => ({ name, type }))}
      overrides={
        overrideList.length === 0 && !gated
          ? null
          : {
              rows: overrideList,
              drafts,
              changedCount:
                (overrides ? Object.keys(overrides).length : 0) + (autopilot ? 1 : 0) + (budgetUsd !== null ? 1 : 0),
              expanded: overridesOpen,
              invalidStep: resolved?.invalidStep ?? null,
              autopilot: gated ? { checked: autopilot, blocked: autopilotBlocked } : null,
              budget: budgetShown
                ? { text: budgetText, error: budget.kind === 'invalid' ? budget.message : null, notice: budgetNotice }
                : null
            }
      }
      blockReason={blockReason}
      submitting={submitting}
      error={error}
      onSelect={handleSelect}
      onRepoChange={(root) => {
        setRepoChoice(root)
        setExistingChoice(null)
        setError(null)
      }}
      onModeChange={(next) => {
        setMode(next)
        setError(null)
      }}
      onBranchChange={(value) => setBranchDraft(sanitizeBranchInput(value))}
      onExistingChange={setExistingChoice}
      onInputChange={handleInputChange}
      onInstallHooks={() => void handleInstallHooks()}
      onAllowFullChange={(checked) => setAllowFullFor(checked ? confirmKey : null)}
      onTrust={() => void handleTrust()}
      onToggleOverrides={() => setOverridesOpen((open) => !open)}
      onOverrideAgentChange={handleOverrideAgent}
      onOverrideModelChange={handleOverrideModel}
      onAutopilotChange={(checked) => setAutopilotFor(checked ? confirmKey : null)}
      onBudgetChange={(text) => setBudgetDraft(confirmKey === null ? null : { key: confirmKey, text })}
      onStart={() => void handleStart()}
      onClose={onClose}
    />
  )
}
