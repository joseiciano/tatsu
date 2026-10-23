import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { ArrowLeft, FolderOpen, Plus, X } from 'lucide-react'
import { useBackend } from '../../backend'
import { useActiveBackend, useHarnessConfig } from '../../store'
import { MonacoDiffEditor } from '../MonacoDiffEditor'
import { TEMPLATE_HARNESSES } from '../../../shared/harness-templates'
import { getAgentInfo } from '../../../shared/agent-registry'
import type {
  HarnessTemplateImportApplyResult,
  HarnessTemplateImportChoices,
  HarnessTemplateImportConflictChoice,
  HarnessTemplateImportFolders,
  HarnessTemplateImportItem,
  HarnessTemplateImportPreview,
  ManagedHarnessKind
} from '../../../shared/state/harness-config'
import {
  defaultImportChoices,
  emptyImportFolders,
  IMPORT_ACTION_LABEL,
  IMPORT_FOLDER_ROWS,
  importConfirmMessage,
  importCutoverScopes,
  importFoldersDirty,
  importFoldersProblem,
  importFoldersRequest,
  importSummary,
  type ImportCutoverScope,
  type ImportFolderDrafts,
  type ImportSingleFolderKey
} from './template-import-model'
import type { ConfigImportWizardProps } from './types'

type Step = 'folders' | 'preview' | 'done'

const BUTTON =
  'px-3 py-1.5 text-xs font-medium rounded bg-accent/20 hover:bg-accent/30 text-fg-bright border border-accent/40 cursor-pointer disabled:cursor-not-allowed disabled:opacity-50'
const SECONDARY =
  'flex items-center gap-1 px-2.5 py-1.5 text-xs text-dim hover:text-fg border border-border rounded transition-colors cursor-pointer disabled:opacity-40 disabled:cursor-default shrink-0'
const INPUT =
  'flex-1 min-w-0 bg-panel border border-border-strong rounded px-3 py-1.5 text-xs text-fg-bright placeholder-faint outline-none focus:border-fg font-mono'

function failureMessage(err: unknown): string {
  return err instanceof Error && err.message ? err.message : 'The request failed'
}

function Section({ title, children }: { title: string; children: ReactNode }): JSX.Element {
  return (
    <section className="flex flex-col gap-1.5">
      <h3 className="text-xs font-medium text-fg-bright">{title}</h3>
      {children}
    </section>
  )
}

function PathRow({
  id,
  value,
  placeholder,
  canPick,
  onChange,
  onPick,
  onRemove
}: {
  id: string
  value: string
  placeholder: string
  canPick: boolean
  onChange: (value: string) => void
  onPick: () => void
  onRemove?: () => void
}): JSX.Element {
  return (
    <div className="flex items-center gap-2">
      <input
        id={id}
        type="text"
        spellCheck={false}
        value={value}
        placeholder={placeholder}
        onChange={(e) => onChange(e.target.value)}
        className={INPUT}
      />
      {canPick && (
        <button type="button" onClick={onPick} className={SECONDARY}>
          <FolderOpen className="icon-xs" />
          Choose…
        </button>
      )}
      {onRemove && (
        <button type="button" onClick={onRemove} aria-label="Remove folder" className={SECONDARY}>
          <X className="icon-xs" />
        </button>
      )}
    </div>
  )
}

function FoldersStep({
  drafts,
  harnesses,
  canPick,
  problem,
  busy,
  error,
  onChangeFolder,
  onChangeSkill,
  onAddSkill,
  onRemoveSkill,
  onPick,
  onToggleHarness,
  onPreview
}: {
  drafts: ImportFolderDrafts
  harnesses: readonly ManagedHarnessKind[]
  canPick: boolean
  problem: string | null
  busy: boolean
  error: string | null
  onChangeFolder: (key: ImportSingleFolderKey, value: string) => void
  onChangeSkill: (index: number, value: string) => void
  onAddSkill: () => void
  onRemoveSkill: (index: number) => void
  onPick: (target: ImportSingleFolderKey | number) => void
  onToggleHarness: (harness: ManagedHarnessKind) => void
  onPreview: () => void
}): JSX.Element {
  return (
    <div className="flex flex-col gap-4 max-w-2xl">
      <p className="text-xs text-dim">
        Pick the folders of your existing setup. Tatsu reads them, shows what it would import, and writes nothing
        until you confirm. The source folders are never changed, and no build script runs.
      </p>
      {IMPORT_FOLDER_ROWS.map((row) => (
        <div key={row.key} className="flex flex-col gap-1">
          <label htmlFor={`import-folder-${row.key}`} className="text-xs text-muted">
            {row.label} <span className="text-faint">· {row.hint}</span>
          </label>
          {row.key === 'skills' ? (
            <>
              {drafts.skills.map((value, index) => (
                <PathRow
                  key={index}
                  id={index === 0 ? 'import-folder-skills' : `import-folder-skills-${index}`}
                  value={value}
                  placeholder="/path/to/skills"
                  canPick={canPick}
                  onChange={(next) => onChangeSkill(index, next)}
                  onPick={() => onPick(index)}
                  onRemove={drafts.skills.length > 1 ? () => onRemoveSkill(index) : undefined}
                />
              ))}
              <button
                type="button"
                onClick={onAddSkill}
                className="self-start flex items-center gap-1 text-xs text-accent hover:underline cursor-pointer"
              >
                <Plus className="icon-xs" />
                Add skill folder
              </button>
            </>
          ) : (
            <PathRow
              id={`import-folder-${row.key}`}
              value={drafts[row.key]}
              placeholder={`/path/to/${row.key === 'agentFragments' ? 'agents-shared' : row.key}`}
              canPick={canPick}
              onChange={(next) => onChangeFolder(row.key as ImportSingleFolderKey, next)}
              onPick={() => onPick(row.key as ImportSingleFolderKey)}
            />
          )}
        </div>
      ))}
      <fieldset className="flex flex-col gap-1">
        <legend className="text-xs text-muted mb-1">
          Harnesses for skills and commands that have no per-harness blocks
        </legend>
        <div className="flex flex-wrap gap-4">
          {TEMPLATE_HARNESSES.map((harness) => (
            <label key={harness} className="flex items-center gap-1.5 text-xs text-fg cursor-pointer">
              <input
                type="checkbox"
                className="icon-base"
                checked={harnesses.includes(harness)}
                onChange={() => onToggleHarness(harness)}
              />
              {getAgentInfo(harness).displayName}
            </label>
          ))}
        </div>
      </fieldset>
      {!canPick && <p className="text-xs text-faint">Type full paths on the machine this backend runs on.</p>}
      {(problem || error) && <p className="text-xs text-danger">{error ?? problem}</p>}
      <div>
        <button type="button" className={BUTTON} disabled={!!problem || busy} onClick={onPreview}>
          {busy ? 'Reading…' : 'Preview import'}
        </button>
      </div>
    </div>
  )
}

function ItemRow({
  item,
  onConflictChoice
}: {
  item: HarnessTemplateImportItem
  onConflictChoice: (key: string, choice: HarnessTemplateImportConflictChoice) => void
}): JSX.Element {
  const tone =
    item.action === 'invalid' ? 'text-danger' : item.action === 'undecided' ? 'text-warning' : 'text-faint'
  return (
    <div className="flex flex-col gap-0.5 rounded border border-border/60 bg-app/30 px-2.5 py-2 min-w-0">
      <div className="flex items-center justify-between gap-2">
        <span className="text-xs font-medium text-fg-bright truncate">{item.key}</span>
        <span className={`text-xs shrink-0 ${tone}`}>{IMPORT_ACTION_LABEL[item.action]}</span>
      </div>
      <span className="text-xs text-faint break-all">{item.sourcePath}</span>
      {item.type === 'template' && item.action !== 'invalid' && (
        <span className="text-xs text-dim">
          Targets: {item.targets.length > 0 ? item.targets.join(', ') : 'none'}
          {item.fragments.length > 0 && ` · Fragments: ${item.fragments.join(', ')}`}
          {item.references.length > 0 && ` · References: ${item.references.join(', ')}`}
        </span>
      )}
      {item.error && <span className="text-xs text-danger">{item.error}</span>}
      {item.droppedBlocks.map((block) => (
        <span key={block} className="text-xs text-warning">
          Dropped {block}
        </span>
      ))}
      {item.unsupportedSettings.length > 0 && (
        <div className="flex flex-col text-xs text-warning">
          <span>Not imported, because these lived outside the resource file:</span>
          {item.unsupportedSettings.map((setting) => (
            <span key={`${setting.harness}.${setting.key}`} className="font-mono break-all text-dim">
              {setting.harness}.{setting.key}: {setting.value}
            </span>
          ))}
        </div>
      )}
      {item.notes.map((note) => (
        <span key={note} className="text-xs text-dim">
          {note}
        </span>
      ))}
      {item.conflict && (
        <div className="flex items-center gap-3 text-xs text-fg pt-0.5">
          <span className="text-warning">Already in the template source folder:</span>
          {(['skip', 'replace'] as const).map((choice) => (
            <label key={choice} className="flex items-center gap-1 cursor-pointer">
              <input
                type="radio"
                className="icon-base"
                name={`conflict-${item.key}`}
                checked={item.action === choice}
                onChange={() => onConflictChoice(item.key, choice)}
              />
              {choice === 'skip' ? 'Skip' : 'Replace (with backup)'}
            </label>
          ))}
        </div>
      )}
    </div>
  )
}

function PreviewStep({
  preview,
  busy,
  error,
  selectedFile,
  fontFamily,
  fontSize,
  onSelectFile,
  onDuplicateChoice,
  onConflictChoice,
  onBack,
  onImport
}: {
  preview: HarnessTemplateImportPreview
  busy: boolean
  error: string | null
  selectedFile: number
  fontFamily?: string
  fontSize?: number
  onSelectFile: (index: number) => void
  onDuplicateChoice: (name: string, choice: string) => void
  onConflictChoice: (key: string, choice: HarnessTemplateImportConflictChoice) => void
  onBack: () => void
  onImport: () => void
}): JSX.Element {
  const summary = importSummary(preview.items)
  const file = preview.files[selectedFile] ?? null
  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-3 text-xs text-dim">
        <span>
          {summary.create} new · {summary.replace} replace · {summary.skip} skip · {summary.invalid} not imported
        </span>
        {busy && <span className="text-faint">Updating preview…</span>}
      </div>
      {preview.blockingReasons.length > 0 && (
        <div role="alert" className="rounded border border-warning/30 bg-warning/10 px-3 py-2 flex flex-col gap-0.5">
          {preview.blockingReasons.map((reason) => (
            <span key={reason} className="text-xs text-warning">
              {reason}
            </span>
          ))}
        </div>
      )}
      {preview.duplicates.length > 0 && (
        <Section title="Skills in more than one source folder">
          {preview.duplicates.map((duplicate) => (
            <fieldset key={duplicate.name} className="flex flex-col gap-1 rounded border border-border/60 px-2.5 py-2">
              <legend className="text-xs text-fg-bright px-1">{duplicate.name}</legend>
              {[...duplicate.sources, 'skip'].map((source) => (
                <label key={source} className="flex items-center gap-1.5 text-xs text-fg cursor-pointer break-all">
                  <input
                    type="radio"
                    className="icon-base shrink-0"
                    name={`duplicate-${duplicate.name}`}
                    checked={duplicate.choice === source}
                    onChange={() => onDuplicateChoice(duplicate.name, source)}
                  />
                  {source === 'skip' ? 'Do not import this skill' : source}
                </label>
              ))}
            </fieldset>
          ))}
        </Section>
      )}
      <Section title="Templates and fragments">
        {preview.items.length === 0 && <span className="text-xs text-faint">Nothing found in the chosen folders.</span>}
        {preview.items.map((item) => (
          <ItemRow key={`${item.key}:${item.sourcePath}`} item={item} onConflictChoice={onConflictChoice} />
        ))}
      </Section>
      {preview.coveredCommands.length > 0 && (
        <Section title="Commands covered by a skill">
          <span className="text-xs text-dim">
            These match an imported skill, so they are not imported. Claude shows each skill as a command too.
          </span>
          {preview.coveredCommands.map((command) => (
            <span key={command.sourcePath} className="text-xs text-faint break-all">
              {command.name} · {command.sourcePath}
            </span>
          ))}
        </Section>
      )}
      {preview.shadows.length > 0 && (
        <Section title="Stored config the import will hide">
          {preview.shadows.map((shadow) => (
            <span key={shadow} className="text-xs text-warning break-all">
              {shadow}
            </span>
          ))}
        </Section>
      )}
      {preview.renderErrors.length > 0 && (
        <Section title="Templates that will not render yet">
          {preview.renderErrors.map((issue, index) => (
            <span key={`${issue.sourcePath}-${index}`} className="text-xs text-danger break-all">
              {issue.sourcePath}: {issue.message}
            </span>
          ))}
        </Section>
      )}
      {preview.unknownFiles.length > 0 && (
        <Section title="Files not imported">
          {preview.unknownFiles.map((issue) => (
            <span key={issue.sourcePath} className="text-xs text-faint break-all">
              {issue.sourcePath}: {issue.message}
            </span>
          ))}
        </Section>
      )}
      {preview.files.length > 0 && (
        <Section title="Rendered files compared with the harness folders">
          <span className="text-xs text-dim">
            Output can differ slightly from the old build, for example in spacing or inlined reference headings.
          </span>
          <div className="flex flex-wrap gap-1">
            {preview.files.map((entry, index) => (
              <button
                key={`${entry.agentKind}:${entry.resourceType}:${entry.relativePath}`}
                type="button"
                aria-pressed={index === selectedFile}
                onClick={() => onSelectFile(index)}
                className={`px-2 py-1 rounded text-xs border cursor-pointer ${
                  index === selectedFile
                    ? 'border-accent/40 bg-accent/20 text-fg-bright'
                    : 'border-border text-dim hover:text-fg'
                }`}
              >
                {entry.agentKind} · {entry.relativePath}
                {entry.current === null ? ' (new)' : entry.current === entry.rendered ? ' (same)' : ''}
              </button>
            ))}
          </div>
          {file && (
            <div className="h-80 border border-border rounded overflow-hidden">
              <MonacoDiffEditor
                key={`${file.agentKind}:${file.resourceType}:${file.relativePath}:${preview.fingerprint}`}
                original={file.current ?? ''}
                modified={file.rendered}
                filePath={file.relativePath}
                fontFamily={fontFamily}
                fontSize={fontSize}
              />
            </div>
          )}
        </Section>
      )}
      {error && <p className="text-xs text-danger">{error}</p>}
      <div className="flex items-center gap-2">
        <button type="button" className={SECONDARY} onClick={onBack} disabled={busy}>
          <ArrowLeft className="icon-xs" />
          Back
        </button>
        <button
          type="button"
          className={BUTTON}
          disabled={busy || preview.blockingReasons.length > 0}
          onClick={onImport}
        >
          Import
        </button>
      </div>
    </div>
  )
}

function DoneStep({
  result,
  scopes,
  onReviewScope,
  onClose
}: {
  result: HarnessTemplateImportApplyResult
  scopes: ImportCutoverScope[]
  onReviewScope: (entry: ImportCutoverScope) => void
  onClose: () => void
}): JSX.Element {
  const outOfSync = scopes.filter((entry) => entry.status !== 'synced')
  return (
    <div className="flex flex-col gap-4 max-w-2xl">
      <p className="text-xs text-success">
        Imported {result.written.length} into the template source folder
        {result.skipped.length > 0 ? `, skipped ${result.skipped.length}` : ''}.
      </p>
      <Section title="Scopes that now differ from disk">
        {outOfSync.length === 0 && <span className="text-xs text-faint">Every touched scope matches disk.</span>}
        {outOfSync.map((entry) => (
          <div key={entry.key} className="flex flex-col gap-0.5 rounded border border-border/60 bg-app/30 px-2.5 py-2">
            <div className="flex items-center justify-between gap-2">
              <span className="text-xs text-fg-bright">{entry.label}</span>
              <button
                type="button"
                onClick={() => onReviewScope(entry)}
                className="text-xs text-accent hover:underline cursor-pointer"
              >
                Review sync
              </button>
            </div>
            <span className="text-xs text-faint">{entry.status ?? 'Comparing…'}</span>
            {entry.linked.length > 0 && (
              <div className="flex flex-col text-xs text-warning">
                <span>Still links into another build, so Tatsu leaves them alone:</span>
                {entry.linked.map((ref) => (
                  <span key={ref.id} className="text-dim break-all">
                    {ref.relativePath} → {ref.linkedFrom}
                  </span>
                ))}
              </div>
            )}
          </div>
        ))}
      </Section>
      <Section title="Cutting over from the old build">
        <ol className="list-decimal pl-5 flex flex-col gap-1 text-xs text-dim">
          <li>Stop running the old build, so it and Tatsu do not overwrite each other in the harness folders.</li>
          <li>
            Harness files that are symbolic links into the old build stay managed elsewhere. Remove those links when
            you are ready.
          </li>
          <li>Then sync each scope to disk. Tatsu writes real files in place of the removed links.</li>
        </ol>
      </Section>
      <div>
        <button type="button" className={BUTTON} onClick={onClose}>
          Done
        </button>
      </div>
    </div>
  )
}

export function ConfigImportWizard({
  onClose,
  onReviewScope,
  onDirtyChange,
  fontFamily,
  fontSize
}: ConfigImportWizardProps): JSX.Element {
  const backend = useBackend()
  const activeBackend = useActiveBackend()
  const harnessConfig = useHarnessConfig()

  const [step, setStep] = useState<Step>('folders')
  const [drafts, setDrafts] = useState<ImportFolderDrafts>(emptyImportFolders)
  const [choices, setChoices] = useState<HarnessTemplateImportChoices>(defaultImportChoices)
  const [folders, setFolders] = useState<HarnessTemplateImportFolders | null>(null)
  const [preview, setPreview] = useState<HarnessTemplateImportPreview | null>(null)
  const [result, setResult] = useState<HarnessTemplateImportApplyResult | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [selectedFile, setSelectedFile] = useState(0)

  const mountedRef = useRef(true)
  const requestRef = useRef(0)
  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
    }
  }, [])

  const dirty = step === 'preview' || (step === 'folders' && importFoldersDirty(drafts))
  useEffect(() => {
    onDirtyChange(dirty)
  }, [dirty, onDirtyChange])
  useEffect(() => () => onDirtyChange(false), [onDirtyChange])

  const requestFolders = useMemo(() => importFoldersRequest(drafts), [drafts])
  const problem = useMemo(() => importFoldersProblem(requestFolders), [requestFolders])
  const canPick = activeBackend.kind !== 'remote'

  const runPreview = useCallback(
    async (nextFolders: HarnessTemplateImportFolders, nextChoices: HarnessTemplateImportChoices): Promise<boolean> => {
      const id = ++requestRef.current
      setBusy(true)
      setError(null)
      try {
        const response = await backend.previewHarnessTemplateImport({ folders: nextFolders, choices: nextChoices })
        if (!mountedRef.current || id !== requestRef.current) return false
        if (!response.ok) {
          setError(response.error.message)
          return false
        }
        setPreview(response.value)
        setSelectedFile((index) => (index < response.value.files.length ? index : 0))
        return true
      } catch (err) {
        if (mountedRef.current && id === requestRef.current) setError(failureMessage(err))
        return false
      } finally {
        if (mountedRef.current && id === requestRef.current) setBusy(false)
      }
    },
    [backend]
  )

  const handlePreview = useCallback(async () => {
    if (problem) return
    const snapshot = requestFolders
    if (await runPreview(snapshot, choices)) {
      setFolders(snapshot)
      setSelectedFile(0)
      setStep('preview')
    }
  }, [problem, requestFolders, runPreview, choices])

  const updateChoices = useCallback(
    (next: HarnessTemplateImportChoices) => {
      setChoices(next)
      if (folders) void runPreview(folders, next)
    },
    [folders, runPreview]
  )

  const handlePick = useCallback(
    async (target: ImportSingleFolderKey | number) => {
      try {
        const current = typeof target === 'number' ? drafts.skills[target] : drafts[target]
        const picked = await backend.pickDirectory({ defaultPath: current || undefined, title: 'Choose folder' })
        if (!picked || !mountedRef.current) return
        setDrafts((prev) =>
          typeof target === 'number'
            ? { ...prev, skills: prev.skills.map((path, index) => (index === target ? picked : path)) }
            : { ...prev, [target]: picked }
        )
      } catch {
        if (mountedRef.current) setError('The folder picker is unavailable here; type the path instead')
      }
    },
    [backend, drafts]
  )

  const handleImport = useCallback(async () => {
    if (!preview || !folders || busy || preview.blockingReasons.length > 0) return
    if (!window.confirm(importConfirmMessage(preview))) return
    setBusy(true)
    setError(null)
    const request = { folders, choices, fingerprint: preview.fingerprint, confirmed: true }
    try {
      let response = await backend.applyHarnessTemplateImport(request)
      if (!mountedRef.current) return
      if (!response.ok && response.error.code === 'template-shadows') {
        if (!window.confirm(response.error.message)) return
        response = await backend.applyHarnessTemplateImport({ ...request, allowShadowing: true })
        if (!mountedRef.current) return
      }
      if (!response.ok) {
        setError(response.error.message)
        if (response.error.code === 'stale-plan') void runPreview(folders, choices)
        return
      }
      const applied = response.value
      setResult(applied)
      setStep('done')
      for (const scope of applied.scopes) void backend.scanHarnessConfig({ scope }).catch(() => undefined)
    } catch (err) {
      if (mountedRef.current) setError(failureMessage(err))
    } finally {
      if (mountedRef.current) setBusy(false)
    }
  }, [preview, folders, busy, choices, backend, runPreview])

  const cutover = useMemo(
    () => (result ? importCutoverScopes(result.scopes, harnessConfig.comparisons, harnessConfig.resources) : []),
    [result, harnessConfig.comparisons, harnessConfig.resources]
  )

  let content: JSX.Element
  if (step === 'done' && result) {
    content = (
      <DoneStep result={result} scopes={cutover} onReviewScope={(entry) => onReviewScope(entry.scope)} onClose={onClose} />
    )
  } else if (step === 'preview' && preview) {
    content = (
      <PreviewStep
        preview={preview}
        busy={busy}
        error={error}
        selectedFile={selectedFile}
        fontFamily={fontFamily}
        fontSize={fontSize}
        onSelectFile={setSelectedFile}
        onDuplicateChoice={(name, choice) =>
          updateChoices({ ...choices, duplicateChoices: { ...choices.duplicateChoices, [name]: choice } })
        }
        onConflictChoice={(key, choice) =>
          updateChoices({ ...choices, conflictChoices: { ...choices.conflictChoices, [key]: choice } })
        }
        onBack={() => {
          requestRef.current += 1
          setBusy(false)
          setError(null)
          setStep('folders')
        }}
        onImport={() => void handleImport()}
      />
    )
  } else {
    content = (
      <FoldersStep
        drafts={drafts}
        harnesses={choices.harnesses}
        canPick={canPick}
        problem={problem}
        busy={busy}
        error={error}
        onChangeFolder={(key, value) => setDrafts((prev) => ({ ...prev, [key]: value }))}
        onChangeSkill={(index, value) =>
          setDrafts((prev) => ({ ...prev, skills: prev.skills.map((path, i) => (i === index ? value : path)) }))
        }
        onAddSkill={() => setDrafts((prev) => ({ ...prev, skills: [...prev.skills, ''] }))}
        onRemoveSkill={(index) => setDrafts((prev) => ({ ...prev, skills: prev.skills.filter((_, i) => i !== index) }))}
        onPick={(target) => void handlePick(target)}
        onToggleHarness={(harness) =>
          setChoices((prev) => ({
            ...prev,
            harnesses: prev.harnesses.includes(harness)
              ? prev.harnesses.filter((entry) => entry !== harness)
              : [...prev.harnesses, harness]
          }))
        }
        onPreview={() => void handlePreview()}
      />
    )
  }

  const stepLabel = step === 'folders' ? 'Choose folders' : step === 'preview' ? 'Review' : 'Done'
  return (
    <div className="flex flex-col flex-1 min-h-0">
      <div className="flex items-center gap-2 px-4 py-2 border-b border-border">
        <span className="text-sm font-medium text-fg-bright">Import existing setup</span>
        <span className="text-xs text-faint">· {stepLabel}</span>
        <button
          type="button"
          onClick={() => {
            if (!dirty || window.confirm('Leave the import without importing?')) onClose()
          }}
          aria-label="Close import"
          className="ml-auto p-1 rounded text-dim hover:text-fg-bright hover:bg-surface-hover cursor-pointer"
        >
          <X className="icon-sm" />
        </button>
      </div>
      <div className="flex-1 min-h-0 overflow-y-auto px-4 py-4">{content}</div>
    </div>
  )
}
