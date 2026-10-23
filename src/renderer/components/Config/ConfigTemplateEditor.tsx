import { useState } from 'react'
import { ArrowDown, ArrowUp, ChevronDown, ChevronRight, Plus, Trash2, TriangleAlert, X } from 'lucide-react'
import { AgentIcon } from '../AgentIcon'
import { MonacoEditor } from '../MonacoEditor'
import { TEMPLATE_HARNESSES } from '../../../shared/harness-templates'
import type { HarnessTemplateKind, ManagedHarnessKind } from '../../../shared/state/harness-config'
import { TEMPLATE_KINDS } from './template-editor-model'
import type { ConfigTemplateDraft, ConfigTemplateEditorProps, ConfigTemplateHarnessDraft } from './types'

const KIND_OPTION_LABEL: Record<HarnessTemplateKind, string> = {
  agent: 'Agent',
  skill: 'Skill',
  command: 'Command'
}

const INPUT_CLASS =
  'w-full bg-app border border-border rounded px-2 py-1 text-xs text-fg-bright placeholder-faint outline-none focus:border-accent'

const ICON_BUTTON_CLASS =
  'p-1 rounded text-dim hover:text-fg-bright hover:bg-surface-hover cursor-pointer disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-transparent'

function FieldLabel({ htmlFor, children }: { htmlFor?: string; children: string }): JSX.Element {
  return (
    <label htmlFor={htmlFor} className="block text-xs text-dim mb-1">
      {children}
    </label>
  )
}

function FragmentPicker({
  fragments,
  available,
  disabled,
  onChange
}: {
  fragments: readonly string[]
  available: readonly string[]
  disabled: boolean
  onChange: (fragments: string[]) => void
}): JSX.Element {
  const [pick, setPick] = useState('')
  const addable = available.filter((name) => !fragments.includes(name))
  const move = (index: number, delta: number): void => {
    const next = [...fragments]
    const [entry] = next.splice(index, 1)
    next.splice(index + delta, 0, entry)
    onChange(next)
  }
  return (
    <div className="flex flex-col gap-1" data-testid="template-fragment-picker">
      {fragments.length === 0 && <span className="text-xs text-faint">No fragments</span>}
      {fragments.map((name, index) => {
        const missing = !available.includes(name)
        return (
          <div key={name} className="flex items-center gap-1 bg-app border border-border rounded px-2 py-0.5">
            <span className="text-xs text-faint w-4 shrink-0">{index + 1}</span>
            <span className={`text-xs flex-1 min-w-0 truncate ${missing ? 'text-danger' : 'text-fg'}`}>
              {name}
              {missing ? ' (missing)' : ''}
            </span>
            <button
              type="button"
              aria-label={`Move ${name} up`}
              disabled={disabled || index === 0}
              onClick={() => move(index, -1)}
              className={ICON_BUTTON_CLASS}
            >
              <ArrowUp className="icon-xs" />
            </button>
            <button
              type="button"
              aria-label={`Move ${name} down`}
              disabled={disabled || index === fragments.length - 1}
              onClick={() => move(index, 1)}
              className={ICON_BUTTON_CLASS}
            >
              <ArrowDown className="icon-xs" />
            </button>
            <button
              type="button"
              aria-label={`Remove ${name}`}
              disabled={disabled}
              onClick={() => onChange(fragments.filter((entry) => entry !== name))}
              className={ICON_BUTTON_CLASS}
            >
              <X className="icon-xs" />
            </button>
          </div>
        )
      })}
      <div className="flex items-center gap-1">
        <select
          aria-label="Fragment to add"
          value={pick}
          disabled={disabled || addable.length === 0}
          onChange={(e) => setPick(e.target.value)}
          className="flex-1 min-w-0 bg-app border border-border rounded px-2 py-1 text-xs text-fg-bright outline-none focus:border-accent cursor-pointer disabled:cursor-not-allowed disabled:opacity-50"
        >
          <option value="">{addable.length === 0 ? 'No more fragments' : 'Choose a fragment…'}</option>
          {addable.map((name) => (
            <option key={name} value={name}>
              {name}
            </option>
          ))}
        </select>
        <button
          type="button"
          disabled={disabled || !pick}
          onClick={() => {
            onChange([...fragments, pick])
            setPick('')
          }}
          className="px-2 py-1 text-xs rounded text-dim hover:text-fg-bright hover:bg-surface-hover flex items-center gap-1 cursor-pointer disabled:cursor-not-allowed disabled:opacity-50"
        >
          <Plus className="icon-xs" />
          Add
        </button>
      </div>
      <span className="text-xs text-faint">Fragments are added after the body, in this order.</span>
    </div>
  )
}

function HarnessBlock({
  harness,
  entry,
  displayName,
  valid,
  reason,
  error,
  busy,
  expanded,
  onToggleExpanded,
  onChange,
  fontFamily,
  fontSize
}: {
  harness: ManagedHarnessKind
  entry: ConfigTemplateHarnessDraft
  displayName: string
  valid: boolean
  reason: string | null
  error: string | undefined
  busy: boolean
  expanded: boolean
  onToggleExpanded: () => void
  onChange: (entry: ConfigTemplateHarnessDraft) => void
  fontFamily?: string
  fontSize?: number
}): JSX.Element {
  const toggleId = `template-harness-${harness}`
  const canToggle = !busy && (valid || entry.enabled)
  return (
    <div className="border border-border rounded" data-testid={`template-harness-${harness}`}>
      <div className="flex items-center gap-2 px-2 py-1.5">
        <button
          type="button"
          aria-label={expanded ? `Collapse ${displayName}` : `Expand ${displayName}`}
          aria-expanded={expanded}
          onClick={onToggleExpanded}
          className={ICON_BUTTON_CLASS}
        >
          {expanded ? <ChevronDown className="icon-xs" /> : <ChevronRight className="icon-xs" />}
        </button>
        <AgentIcon kind={harness} className="icon-sm" />
        <label htmlFor={toggleId} className="text-xs text-fg-bright flex-1 min-w-0 truncate">
          {displayName}
        </label>
        {error && <span className="text-xs text-danger shrink-0">Invalid YAML</span>}
        <input
          id={toggleId}
          type="checkbox"
          checked={entry.enabled}
          disabled={!canToggle}
          title={!valid ? (reason ?? undefined) : undefined}
          onChange={(e) => onChange({ ...entry, enabled: e.target.checked, excluded: e.target.checked ? false : entry.excluded })}
          className="icon-base cursor-pointer disabled:cursor-not-allowed"
        />
      </div>
      {!valid && reason && (
        <div className={`px-2 pb-1.5 text-xs ${entry.enabled ? 'text-danger' : 'text-faint'}`}>{reason}</div>
      )}
      {expanded && (
        <div className="px-2 pb-2 flex flex-col gap-1">
          <span className="text-xs text-faint">
            {displayName} frontmatter, written as {displayName} reads it. A name or fragments key here overrides the
            template&apos;s for {displayName} only.
          </span>
          <div className="h-32 border border-border rounded overflow-hidden">
            <MonacoEditor
              value={entry.frontmatterText}
              filePath={`${harness}-frontmatter.yaml`}
              readOnly={busy}
              onChange={(value) => onChange({ ...entry, frontmatterText: value })}
              fontFamily={fontFamily}
              fontSize={fontSize}
            />
          </div>
          {error && <span className="text-xs text-danger">{error}</span>}
        </div>
      )}
    </div>
  )
}

export function ConfigTemplateEditor({
  mode,
  draft,
  onDraftChange,
  availability,
  blockErrors,
  problems,
  fragmentNames,
  previewHarness,
  onPreviewHarnessChange,
  preview,
  dirty,
  busy,
  error,
  notice,
  outsideChange,
  fontFamily,
  fontSize,
  onSave,
  onDelete,
  onReset,
  onCancel
}: ConfigTemplateEditorProps): JSX.Element {
  const [expanded, setExpanded] = useState<ReadonlySet<ManagedHarnessKind>>(
    () => new Set(TEMPLATE_HARNESSES.filter((harness) => draft.harnesses[harness].enabled))
  )
  const update = (patch: Partial<ConfigTemplateDraft>): void => onDraftChange({ ...draft, ...patch })
  const targets = TEMPLATE_HARNESSES.filter((harness) => draft.harnesses[harness].enabled)

  return (
    <div className="flex-1 flex flex-col min-h-0">
      <div className="flex items-center gap-2 px-3 py-2 border-b border-border">
        <span className="text-sm text-fg-bright truncate">
          {mode === 'create' ? 'New template' : `${KIND_OPTION_LABEL[draft.kind]} template ${draft.name}`}
        </span>
        {dirty && <span className="text-xs text-warning shrink-0">Unsaved</span>}
      </div>
      {outsideChange && (
        <div role="alert" className="flex items-start gap-1.5 px-3 py-1.5 text-xs text-warning border-b border-border">
          <TriangleAlert className="icon-xs shrink-0 mt-0.5" />
          {outsideChange === 'changed'
            ? 'This template changed in the source folder after you opened it. Saving asks before overwriting; Reset loads the new version.'
            : 'This template was removed from the source folder. Saving writes it again.'}
        </div>
      )}
      {error && <div className="px-3 py-1.5 text-xs text-danger border-b border-border whitespace-pre-wrap">{error}</div>}
      {notice && <div className="px-3 py-1.5 text-xs text-success border-b border-border">{notice}</div>}
      <div className="flex-1 min-h-0 flex">
        <div className="flex-1 min-w-0 overflow-y-auto px-3 py-3 flex flex-col gap-3">
          <div className="flex gap-2">
            <div className="flex-1 min-w-0">
              <FieldLabel htmlFor="template-name">Name</FieldLabel>
              <input
                id="template-name"
                type="text"
                value={draft.name}
                readOnly={mode === 'edit'}
                disabled={busy}
                onChange={(e) => update({ name: e.target.value })}
                placeholder="my-template"
                className={INPUT_CLASS}
              />
            </div>
            <div className="w-32 shrink-0">
              <FieldLabel htmlFor="template-kind">Kind</FieldLabel>
              <select
                id="template-kind"
                value={draft.kind}
                disabled={mode === 'edit' || busy}
                onChange={(e) => update({ kind: e.target.value as HarnessTemplateKind })}
                className={`${INPUT_CLASS} cursor-pointer disabled:cursor-not-allowed`}
              >
                {TEMPLATE_KINDS.map((kind) => (
                  <option key={kind} value={kind}>
                    {KIND_OPTION_LABEL[kind]}
                  </option>
                ))}
              </select>
            </div>
          </div>
          <div>
            <FieldLabel htmlFor="template-description">Description</FieldLabel>
            <input
              id="template-description"
              type="text"
              value={draft.description}
              disabled={busy}
              onChange={(e) => update({ description: e.target.value })}
              className={INPUT_CLASS}
            />
          </div>
          <div>
            <FieldLabel>Fragments</FieldLabel>
            <FragmentPicker
              fragments={draft.fragments}
              available={fragmentNames}
              disabled={busy}
              onChange={(fragments) => update({ fragments })}
            />
          </div>
          <div>
            <FieldLabel>Body</FieldLabel>
            <div className="h-64 border border-border rounded overflow-hidden">
              <MonacoEditor
                value={draft.body}
                filePath="template-body.md"
                readOnly={busy}
                onChange={(body) => update({ body })}
                onSave={onSave}
                fontFamily={fontFamily}
                fontSize={fontSize}
              />
            </div>
          </div>
          {draft.kind === 'skill' && draft.references.length > 0 && (
            <div className="text-xs text-faint">
              Reference files kept as they are: {draft.references.map((reference) => reference.fileName).join(', ')}
            </div>
          )}
          <div className="flex flex-col gap-2">
            <FieldLabel>Harnesses</FieldLabel>
            {TEMPLATE_HARNESSES.map((harness) => (
              <HarnessBlock
                key={harness}
                harness={harness}
                entry={draft.harnesses[harness]}
                displayName={availability[harness].displayName}
                valid={availability[harness].valid}
                reason={availability[harness].reason}
                error={blockErrors[harness]}
                busy={busy}
                expanded={expanded.has(harness)}
                onToggleExpanded={() =>
                  setExpanded((current) => {
                    const next = new Set(current)
                    if (next.has(harness)) next.delete(harness)
                    else next.add(harness)
                    return next
                  })
                }
                onChange={(entry) => update({ harnesses: { ...draft.harnesses, [harness]: entry } })}
                fontFamily={fontFamily}
                fontSize={fontSize}
              />
            ))}
          </div>
          {problems.length > 0 && (
            <ul className="flex flex-col gap-0.5 text-xs text-danger" aria-label="Problems to fix before saving">
              {problems.map((problem) => (
                <li key={problem}>{problem}</li>
              ))}
            </ul>
          )}
        </div>
        <div className="w-[45%] shrink-0 border-l border-border flex flex-col min-h-0" data-testid="template-preview">
          <div className="flex items-center gap-1 px-2 py-1.5 border-b border-border flex-wrap">
            <span className="text-xs text-dim mr-1">Preview</span>
            {targets.map((harness) => (
              <button
                key={harness}
                type="button"
                aria-pressed={previewHarness === harness}
                onClick={() => onPreviewHarnessChange(harness)}
                className={`px-2 py-0.5 text-xs rounded cursor-pointer ${
                  previewHarness === harness ? 'bg-surface text-fg-bright' : 'text-dim hover:text-fg-bright'
                }`}
              >
                {availability[harness].displayName}
              </button>
            ))}
          </div>
          {preview.errors.length > 0 && (
            <ul className="px-3 py-1.5 border-b border-border flex flex-col gap-0.5 text-xs text-danger" aria-label="Render errors">
              {preview.errors.map((message) => (
                <li key={message}>{message}</li>
              ))}
            </ul>
          )}
          <div className="flex-1 min-h-0 overflow-auto">
            {targets.length === 0 ? (
              <div className="px-3 py-3 text-xs text-faint">Turn on a harness to preview what it gets.</div>
            ) : preview.resource ? (
              <>
                <div className="px-3 pt-2 text-xs text-faint break-all">{preview.resource.relativePath}</div>
                <pre className="px-3 py-2 text-xs font-mono text-fg whitespace-pre-wrap break-words">
                  {preview.resource.content}
                </pre>
              </>
            ) : (
              <div className="px-3 py-3 text-xs text-faint">No output for this harness until the errors are fixed.</div>
            )}
          </div>
        </div>
      </div>
      <div className="flex items-center justify-end gap-2 px-3 py-2 border-t border-border">
        {mode === 'edit' && (
          <button
            type="button"
            disabled={busy}
            onClick={onDelete}
            aria-label="Delete template"
            className="mr-auto px-2 py-1.5 text-xs text-danger hover:bg-surface-hover rounded cursor-pointer disabled:cursor-not-allowed disabled:opacity-50 flex items-center gap-1"
          >
            <Trash2 className="icon-xs" />
            Delete
          </button>
        )}
        {mode === 'create' ? (
          <button type="button" onClick={onCancel} className="px-3 py-1.5 text-xs text-dim hover:text-fg cursor-pointer">
            Cancel
          </button>
        ) : (
          <button
            type="button"
            disabled={(!dirty && !outsideChange) || busy}
            onClick={onReset}
            className="px-3 py-1.5 text-xs text-dim hover:text-fg cursor-pointer disabled:cursor-not-allowed disabled:opacity-50"
          >
            Reset
          </button>
        )}
        <button
          type="button"
          disabled={problems.length > 0 || busy || (mode === 'edit' && !dirty && outsideChange !== 'removed')}
          onClick={onSave}
          className="px-3 py-1.5 text-xs font-medium rounded bg-accent/20 hover:bg-accent/30 text-fg-bright border border-accent/40 cursor-pointer disabled:cursor-not-allowed disabled:opacity-50"
        >
          {mode === 'create' ? 'Create' : 'Save'}
        </button>
      </div>
    </div>
  )
}
