import { useCallback, useDeferredValue, useEffect, useMemo, useRef, useState } from 'react'
import { useBackend } from '../../backend'
import { useHarnessFragment, useHarnessTemplate, useHarnessTemplateSource } from '../../store'
import { getAgentInfo } from '../../../shared/agent-registry'
import { TEMPLATE_HARNESSES, templateNameError } from '../../../shared/harness-templates'
import type { HarnessTemplate, HarnessTemplateKind, ManagedHarnessKind } from '../../../shared/state/harness-config'
import { ConfigTemplateList } from './ConfigTemplateList'
import { ConfigTemplateEditor } from './ConfigTemplateEditor'
import { ConfigFragmentEditor } from './ConfigFragmentEditor'
import {
  compileTemplateDraft,
  emptyTemplateDraft,
  fragmentUsage,
  parseTemplateRef,
  renderTemplatePreview,
  templateDraftsEqual,
  templateHarnessAvailability,
  templateRefOf,
  templateToDraft
} from './template-editor-model'
import type {
  ConfigTemplateDraft,
  ConfigTemplateOutsideChange,
  ConfigTemplateSelection,
  ConfigTemplatesProps
} from './types'

type Editing =
  | { type: 'template'; mode: 'create' | 'edit'; kind: HarnessTemplateKind; name: string }
  | { type: 'fragment'; mode: 'create' | 'edit'; name: string }

interface InitialState {
  editing: Editing | null
  draft: ConfigTemplateDraft | null
  openedHash: string | null
  error: string | null
}

const BACKUP_NOTE = 'Tatsu backs up the existing file before overwriting it.'

function requestFailureMessage(err: unknown): string {
  return err instanceof Error && err.message ? err.message : 'The request failed'
}

function initialStateFor(ref: string | null, templates: readonly HarnessTemplate[]): InitialState {
  const empty: InitialState = { editing: null, draft: null, openedHash: null, error: null }
  if (!ref) return empty
  const parsed = parseTemplateRef(ref)
  const template = parsed ? templates.find((entry) => entry.kind === parsed.kind && entry.name === parsed.name) : undefined
  if (!template) return { ...empty, error: `Template ${ref} is not in the template source folder.` }
  return {
    editing: { type: 'template', mode: 'edit', kind: template.kind, name: template.name },
    draft: templateToDraft(template),
    openedHash: template.hash,
    error: null
  }
}

export function ConfigTemplates({
  initialTemplateRef,
  searchQuery,
  onDirtyChange,
  onImport,
  fontFamily,
  fontSize
}: ConfigTemplatesProps): JSX.Element {
  const backend = useBackend()
  const source = useHarnessTemplateSource()

  const [initial] = useState(() => initialStateFor(initialTemplateRef, source.templates))
  const [editing, setEditing] = useState<Editing | null>(initial.editing)
  const [templateDraft, setTemplateDraft] = useState<ConfigTemplateDraft | null>(initial.draft)
  const [templateBaseline, setTemplateBaseline] = useState<ConfigTemplateDraft | null>(initial.draft)
  const [fragmentName, setFragmentName] = useState('')
  const [fragmentDraft, setFragmentDraft] = useState('')
  const [fragmentBaseline, setFragmentBaseline] = useState('')
  const [openedHash, setOpenedHash] = useState<string | null>(initial.openedHash)
  // The store's hash just before our own save, and whether that save's
  // store echo is still on its way; neither counts as an outside change.
  const [supersededHash, setSupersededHash] = useState<string | null>(null)
  const [awaitingEcho, setAwaitingEcho] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(initial.error)
  const [notice, setNotice] = useState<string | null>(null)
  const [previewHarness, setPreviewHarness] = useState<ManagedHarnessKind | null>(null)

  const mountedRef = useRef(true)
  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
    }
  }, [])

  const currentTemplate = useHarnessTemplate(
    editing?.type === 'template' && editing.mode === 'edit' ? editing.kind : null,
    editing?.type === 'template' && editing.mode === 'edit' ? editing.name : null
  )
  const currentFragment = useHarnessFragment(
    editing?.type === 'fragment' && editing.mode === 'edit' ? editing.name : null
  )
  const current = editing?.type === 'template' ? currentTemplate : currentFragment

  const dirty = useMemo(() => {
    if (!editing) return false
    if (editing.type === 'template') {
      return !!templateDraft && !!templateBaseline && !templateDraftsEqual(templateDraft, templateBaseline)
    }
    if (editing.mode === 'create') return fragmentName.length > 0 || fragmentDraft.length > 0
    return fragmentDraft !== fragmentBaseline
  }, [editing, templateDraft, templateBaseline, fragmentName, fragmentDraft, fragmentBaseline])

  useEffect(() => {
    onDirtyChange(dirty)
  }, [dirty, onDirtyChange])
  useEffect(() => () => onDirtyChange(false), [onDirtyChange])

  const outsideChange: ConfigTemplateOutsideChange = useMemo(() => {
    if (!editing || editing.mode !== 'edit') return null
    if (!current) return awaitingEcho ? null : 'removed'
    if (current.hash === openedHash || current.hash === supersededHash) return null
    return 'changed'
  }, [editing, current, openedHash, supersededHash, awaitingEcho])

  useEffect(() => {
    if (awaitingEcho && current && current.hash === openedHash) setAwaitingEcho(false)
  }, [awaitingEcho, current, openedHash])

  const loadTemplate = useCallback((template: HarnessTemplate) => {
    const draft = templateToDraft(template)
    setEditing({ type: 'template', mode: 'edit', kind: template.kind, name: template.name })
    setTemplateDraft(draft)
    setTemplateBaseline(draft)
    setOpenedHash(template.hash)
    setSupersededHash(null)
    setAwaitingEcho(false)
  }, [])

  const loadFragment = useCallback((name: string, content: string, hash: string) => {
    setEditing({ type: 'fragment', mode: 'edit', name })
    setFragmentName(name)
    setFragmentDraft(content)
    setFragmentBaseline(content)
    setOpenedHash(hash)
    setSupersededHash(null)
    setAwaitingEcho(false)
  }, [])

  // A clean draft follows outside edits; a dirty one keeps the banner
  // and asks on save instead.
  useEffect(() => {
    if (outsideChange !== 'changed' || dirty || !current) return
    if (editing?.type === 'template' && currentTemplate) loadTemplate(currentTemplate)
    else if (editing?.type === 'fragment' && currentFragment) {
      loadFragment(currentFragment.name, currentFragment.content, currentFragment.hash)
    }
  }, [outsideChange, dirty, current, editing, currentTemplate, currentFragment, loadTemplate, loadFragment])

  const confirmDiscard = useCallback((): boolean => {
    if (!dirty) return true
    return window.confirm('Discard unsaved changes in the Config editor?')
  }, [dirty])

  const resetMessages = (): void => {
    setError(null)
    setNotice(null)
  }

  // ---- Selection ----

  const handleSelectTemplate = useCallback(
    (kind: HarnessTemplateKind, name: string) => {
      if (editing?.type === 'template' && editing.mode === 'edit' && editing.kind === kind && editing.name === name) return
      const template = source.templates.find((entry) => entry.kind === kind && entry.name === name)
      if (!template || !confirmDiscard()) return
      resetMessages()
      setPreviewHarness(null)
      loadTemplate(template)
    },
    [editing, source.templates, confirmDiscard, loadTemplate]
  )

  const handleSelectFragment = useCallback(
    (name: string) => {
      if (editing?.type === 'fragment' && editing.mode === 'edit' && editing.name === name) return
      const fragment = source.fragments.find((entry) => entry.name === name)
      if (!fragment || !confirmDiscard()) return
      resetMessages()
      loadFragment(fragment.name, fragment.content, fragment.hash)
    },
    [editing, source.fragments, confirmDiscard, loadFragment]
  )

  const handleCreateTemplate = useCallback(
    (kind: HarnessTemplateKind) => {
      if (!confirmDiscard()) return
      resetMessages()
      const draft = emptyTemplateDraft(kind)
      setEditing({ type: 'template', mode: 'create', kind, name: '' })
      setTemplateDraft(draft)
      setTemplateBaseline(draft)
      setOpenedHash(null)
      setPreviewHarness(null)
    },
    [confirmDiscard]
  )

  const handleCreateFragment = useCallback(() => {
    if (!confirmDiscard()) return
    resetMessages()
    setEditing({ type: 'fragment', mode: 'create', name: '' })
    setFragmentName('')
    setFragmentDraft('')
    setFragmentBaseline('')
    setOpenedHash(null)
  }, [confirmDiscard])

  const handleCancelCreate = useCallback(() => {
    if (!confirmDiscard()) return
    resetMessages()
    setEditing(null)
    setTemplateDraft(null)
    setTemplateBaseline(null)
  }, [confirmDiscard])

  // ---- Template editing ----

  const compiled = useMemo(() => (templateDraft ? compileTemplateDraft(templateDraft) : null), [templateDraft])
  const deferredDraft = useDeferredValue(templateDraft)
  const availability = useMemo(
    () => templateHarnessAvailability(templateDraft?.kind ?? 'agent'),
    [templateDraft?.kind]
  )
  const targets = templateDraft ? TEMPLATE_HARNESSES.filter((harness) => templateDraft.harnesses[harness].enabled) : []
  const effectivePreviewHarness =
    previewHarness && targets.includes(previewHarness) ? previewHarness : (targets[0] ?? null)
  const original = useMemo(
    () => (editing?.type === 'template' && editing.mode === 'edit' ? { kind: editing.kind, name: editing.name } : null),
    [editing]
  )
  const preview = useMemo(() => {
    if (!deferredDraft) return { resource: null, errors: [] }
    return renderTemplatePreview(
      compileTemplateDraft(deferredDraft),
      effectivePreviewHarness,
      source.templates,
      source.fragments,
      original
    )
  }, [deferredDraft, effectivePreviewHarness, source.templates, source.fragments, original])

  const handleSaveTemplate = useCallback(async () => {
    if (!editing || editing.type !== 'template' || !templateDraft || busy) return
    const result = compileTemplateDraft(templateDraft)
    if (!result.saveTemplate) return
    const request = result.saveTemplate
    const ref = templateRefOf(request.kind, request.name)
    const existing = source.templates.find((entry) => entry.kind === request.kind && entry.name === request.name)

    if (editing.mode === 'create') {
      if (existing && !window.confirm(`Template ${ref} already exists. Replace it with this one?\n\n${BACKUP_NOTE}`)) return
    } else if (outsideChange === 'changed') {
      if (!window.confirm(`Template ${ref} changed in the source folder since you opened it. Overwrite those changes?\n\n${BACKUP_NOTE}`)) return
    } else if (!window.confirm(`Save template ${ref}?\n\n${BACKUP_NOTE}`)) {
      return
    }

    setBusy(true)
    resetMessages()
    const savedDraft = templateDraft
    try {
      let response = await backend.saveHarnessTemplate({ template: request, confirmed: true })
      if (!mountedRef.current) return
      if (!response.ok && response.error.code === 'template-shadows') {
        if (!window.confirm(response.error.message)) return
        response = await backend.saveHarnessTemplate({ template: request, confirmed: true, allowShadowing: true })
        if (!mountedRef.current) return
      }
      if (!response.ok) {
        setError(response.error.message)
        return
      }
      setEditing({ type: 'template', mode: 'edit', kind: response.value.kind, name: response.value.name })
      setTemplateBaseline(savedDraft)
      setOpenedHash(response.value.hash)
      setSupersededHash(existing?.hash ?? null)
      setAwaitingEcho(true)
      setNotice(`Saved ${response.value.relativePath}. Sync each harness scope to write its files.`)
    } catch (err) {
      if (mountedRef.current) setError(requestFailureMessage(err))
    } finally {
      if (mountedRef.current) setBusy(false)
    }
  }, [editing, templateDraft, busy, source.templates, outsideChange, backend])

  const handleDeleteTemplate = useCallback(async () => {
    if (!editing || editing.type !== 'template' || editing.mode !== 'edit' || busy) return
    const ref = templateRefOf(editing.kind, editing.name)
    if (
      !window.confirm(
        `Delete template ${ref}?\n\nTatsu backs up the file first. Files it built stay on disk until you sync each scope.`
      )
    ) {
      return
    }
    setBusy(true)
    resetMessages()
    try {
      const response = await backend.deleteHarnessTemplate({ kind: editing.kind, name: editing.name, confirmed: true })
      if (!mountedRef.current) return
      if (!response.ok) {
        setError(response.error.message)
        return
      }
      setEditing(null)
      setTemplateDraft(null)
      setTemplateBaseline(null)
      setNotice(null)
    } catch (err) {
      if (mountedRef.current) setError(requestFailureMessage(err))
    } finally {
      if (mountedRef.current) setBusy(false)
    }
  }, [editing, busy, backend])

  const handleResetTemplate = useCallback(() => {
    if (currentTemplate) loadTemplate(currentTemplate)
    else if (templateBaseline) setTemplateDraft(templateBaseline)
    resetMessages()
  }, [currentTemplate, templateBaseline, loadTemplate])

  // ---- Fragment editing ----

  const usedBy = useMemo(() => {
    const name = editing?.type === 'fragment' ? (editing.mode === 'edit' ? editing.name : fragmentName.trim()) : ''
    return name ? fragmentUsage(source.templates, name).map((template) => templateRefOf(template.kind, template.name)) : []
  }, [editing, fragmentName, source.templates])

  const editedFragmentName = editing?.type === 'fragment' && editing.mode === 'edit' ? editing.name : null
  const [fileUsage, setFileUsage] = useState<{ name: string; files: readonly string[] } | null>(null)
  useEffect(() => {
    if (!editedFragmentName) return
    let cancelled = false
    void backend
      .harnessFragmentUsage({ name: editedFragmentName })
      .then((response) => {
        if (cancelled || !response.ok) return
        const files = response.value.files.map(
          (file) => `${getAgentInfo(file.agentKind).displayName} ${file.relativePath}`
        )
        setFileUsage({ name: editedFragmentName, files })
      })
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [backend, editedFragmentName, current?.hash])
  const usedByFiles = fileUsage && fileUsage.name === editedFragmentName ? fileUsage.files : []

  const handleSaveFragment = useCallback(async () => {
    if (!editing || editing.type !== 'fragment' || busy) return
    const name = editing.mode === 'edit' ? editing.name : fragmentName.trim()
    const nameError = templateNameError(name)
    if (nameError) {
      setError(`Name: ${nameError}`)
      return
    }
    const existing = source.fragments.find((entry) => entry.name === name)
    const users = [
      ...fragmentUsage(source.templates, name).map((template) => templateRefOf(template.kind, template.name)),
      ...usedByFiles
    ]

    if (editing.mode === 'create' && existing) {
      if (!window.confirm(`Fragment ${name} already exists. Replace it with this one?\n\n${BACKUP_NOTE}`)) return
    } else if (outsideChange === 'changed') {
      if (!window.confirm(`Fragment ${name} changed in the source folder since you opened it. Overwrite those changes?\n\n${BACKUP_NOTE}`)) return
    }
    if (users.length > 1) {
      const list = users.map((ref) => `- ${ref}`).join('\n')
      if (
        !window.confirm(
          `Fragment ${name} is used in ${users.length} places:\n${list}\n\nSaving changes every one of them. Save?`
        )
      ) {
        return
      }
    } else if (editing.mode === 'edit' && outsideChange !== 'changed' && !window.confirm(`Save fragment ${name}?\n\n${BACKUP_NOTE}`)) {
      return
    }

    setBusy(true)
    resetMessages()
    const content = fragmentDraft
    try {
      const response = await backend.saveHarnessFragment({ name, content, confirmed: true })
      if (!mountedRef.current) return
      if (!response.ok) {
        setError(response.error.message)
        return
      }
      setEditing({ type: 'fragment', mode: 'edit', name: response.value.name })
      setFragmentName(response.value.name)
      setFragmentBaseline(content)
      setOpenedHash(response.value.hash)
      setSupersededHash(existing?.hash ?? null)
      setAwaitingEcho(true)
      setNotice(
        users.length > 0
          ? `Saved ${response.value.relativePath}. Sync each harness scope to write the templates and files that use it.`
          : `Saved ${response.value.relativePath}.`
      )
    } catch (err) {
      if (mountedRef.current) setError(requestFailureMessage(err))
    } finally {
      if (mountedRef.current) setBusy(false)
    }
  }, [editing, busy, fragmentName, fragmentDraft, source.fragments, source.templates, usedByFiles, outsideChange, backend])

  const handleDeleteFragment = useCallback(async () => {
    if (!editing || editing.type !== 'fragment' || editing.mode !== 'edit' || busy) return
    const name = editing.name
    const users = [
      ...fragmentUsage(source.templates, name).map((template) => templateRefOf(template.kind, template.name)),
      ...usedByFiles
    ]
    const warning =
      users.length > 0
        ? `\n\nThese templates and files use it and are left out of sync until you remove it from them:\n${users.map((ref) => `- ${ref}`).join('\n')}`
        : ''
    if (!window.confirm(`Delete fragment ${name}?${warning}\n\nTatsu backs up the file first.`)) return
    setBusy(true)
    resetMessages()
    try {
      const response = await backend.deleteHarnessFragment({ name, confirmed: true })
      if (!mountedRef.current) return
      if (!response.ok) {
        setError(response.error.message)
        return
      }
      setEditing(null)
      setFragmentName('')
      setFragmentDraft('')
      setFragmentBaseline('')
    } catch (err) {
      if (mountedRef.current) setError(requestFailureMessage(err))
    } finally {
      if (mountedRef.current) setBusy(false)
    }
  }, [editing, busy, source.templates, usedByFiles, backend])

  const handleResetFragment = useCallback(() => {
    if (currentFragment) loadFragment(currentFragment.name, currentFragment.content, currentFragment.hash)
    else setFragmentDraft(fragmentBaseline)
    resetMessages()
  }, [currentFragment, fragmentBaseline, loadFragment])

  // ---- List ----

  const query = searchQuery.trim().toLowerCase()
  const listTemplates = useMemo(
    () => (query ? source.templates.filter((t) => t.name.toLowerCase().includes(query)) : source.templates),
    [query, source.templates]
  )
  const listFragments = useMemo(
    () => (query ? source.fragments.filter((f) => f.name.toLowerCase().includes(query)) : source.fragments),
    [query, source.fragments]
  )
  const fragmentNames = useMemo(() => source.fragments.map((fragment) => fragment.name), [source.fragments])
  const selection: ConfigTemplateSelection | null =
    editing && editing.mode === 'edit'
      ? editing.type === 'template'
        ? { type: 'template', kind: editing.kind, name: editing.name }
        : { type: 'fragment', name: editing.name }
      : null

  let editor: JSX.Element
  if (editing?.type === 'template' && templateDraft && compiled) {
    editor = (
      <ConfigTemplateEditor
        key={editing.mode === 'edit' ? templateRefOf(editing.kind, editing.name) : 'new-template'}
        mode={editing.mode}
        draft={templateDraft}
        onDraftChange={setTemplateDraft}
        availability={availability}
        blockErrors={compiled.blockErrors}
        problems={compiled.problems}
        fragmentNames={fragmentNames}
        previewHarness={effectivePreviewHarness}
        onPreviewHarnessChange={setPreviewHarness}
        preview={preview}
        dirty={dirty}
        busy={busy}
        error={error}
        notice={notice}
        outsideChange={outsideChange}
        fontFamily={fontFamily}
        fontSize={fontSize}
        onSave={() => void handleSaveTemplate()}
        onDelete={() => void handleDeleteTemplate()}
        onReset={handleResetTemplate}
        onCancel={handleCancelCreate}
      />
    )
  } else if (editing?.type === 'fragment') {
    editor = (
      <ConfigFragmentEditor
        key={editing.mode === 'edit' ? `fragment/${editing.name}` : 'new-fragment'}
        mode={editing.mode}
        name={editing.mode === 'edit' ? editing.name : fragmentName}
        onNameChange={setFragmentName}
        content={fragmentDraft}
        onContentChange={setFragmentDraft}
        usedBy={usedBy}
        usedByFiles={usedByFiles}
        dirty={dirty}
        busy={busy}
        error={error}
        notice={notice}
        outsideChange={outsideChange}
        fontFamily={fontFamily}
        fontSize={fontSize}
        onSave={() => void handleSaveFragment()}
        onDelete={() => void handleDeleteFragment()}
        onReset={handleResetFragment}
        onCancel={handleCancelCreate}
      />
    )
  } else {
    editor = (
      <div className="flex-1 flex flex-col items-center justify-center gap-1.5 text-center px-6">
        {error && <span className="text-xs text-danger">{error}</span>}
        <span className="text-xs text-faint max-w-sm">
          Select a template or fragment, or use + to create one. A template builds one file for each harness you turn
          on, from settings you write for that harness.
        </span>
      </div>
    )
  }

  return (
    <div className="flex flex-1 min-h-0">
      <div className="w-72 shrink-0 border-r border-border min-h-0 overflow-hidden">
        <ConfigTemplateList
          templates={listTemplates}
          fragments={listFragments}
          parseErrors={source.errors}
          searchActive={query.length > 0}
          selection={selection}
          onSelectTemplate={handleSelectTemplate}
          onSelectFragment={handleSelectFragment}
          onCreateTemplate={handleCreateTemplate}
          onCreateFragment={handleCreateFragment}
          onImport={onImport}
        />
      </div>
      <div className="flex-1 min-w-0 min-h-0 flex flex-col">{editor}</div>
    </div>
  )
}
