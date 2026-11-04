import { useEffect, useMemo, useRef, useState } from 'react'
import { useBackend } from '../../../backend'
import type { IssueSummary, PRSummary } from '../../../../shared/github-types'
import { Combobox } from './Combobox'
import { digitsOnly, fileOptions, isRepoRelativePath, issueOptions, prOptions } from './picker-options'
import type { PickerKind, PickerOption, PickerSource } from './types'

export const ISSUE_SEARCH_DEBOUNCE_MS = 250

export interface InputPickerProps {
  id: string
  label: string
  kind: PickerKind
  value: string
  disabled: boolean
  repoRoot: string | null
  filesRoot: string | null
  className: string
  onChange: (value: string) => void
}

type Loaded<T> = { root: string; items: T[] | null }

function useFileSource(enabled: boolean, root: string | null, search: string): PickerSource & { files: Set<string> | null } {
  const backend = useBackend()
  const [loaded, setLoaded] = useState<Loaded<string> | null>(null)

  useEffect(() => {
    if (!enabled || root === null) return
    let cancelled = false
    const settle = (items: string[]): void => {
      if (!cancelled) setLoaded({ root, items: items.filter(isRepoRelativePath) })
    }
    backend.listAllFiles(root).then(settle, () => settle([]))
    return () => {
      cancelled = true
    }
  }, [backend, enabled, root])

  const files = loaded?.root === root ? loaded.items : null
  const set = useMemo(() => (files ? new Set(files) : null), [files])
  const options = useMemo(() => (files ? fileOptions(files, search) : []), [files, search])
  return { mode: 'combobox', status: files ? 'ready' : 'loading', options, files: set }
}

function usePrSource(enabled: boolean, root: string | null, search: string): PickerSource {
  const backend = useBackend()
  const [loaded, setLoaded] = useState<Loaded<PRSummary> | null>(null)

  useEffect(() => {
    if (!enabled || root === null) return
    let cancelled = false
    const settle = (items: PRSummary[] | null): void => {
      if (!cancelled) setLoaded({ root, items })
    }
    backend.listRepoPRs(root, { requireToken: true }).then(settle, () => settle(null))
    return () => {
      cancelled = true
    }
  }, [backend, enabled, root])

  const current = loaded?.root === root ? loaded : null
  const prs = current?.items ?? null
  const options = useMemo(() => (prs ? prOptions(prs, search) : []), [prs, search])
  if (root === null || (current !== null && prs === null)) return { mode: 'number' }
  return { mode: 'combobox', status: current === null ? 'loading' : 'ready', options }
}

interface IssueState {
  root: string
  search: string
  issues: IssueSummary[] | null
  failed: boolean
}

function useIssueSource(enabled: boolean, root: string | null, search: string): PickerSource {
  const backend = useBackend()
  const [state, setState] = useState<IssueState | null>(null)
  const [fallback, setFallback] = useState<string | null>(null)
  const seq = useRef(0)
  const current = state?.root === root ? state : null
  const loadedSearch = current?.search ?? null

  useEffect(() => {
    if (!enabled || root === null || fallback === root || loadedSearch === search) return
    const ticket = ++seq.current
    const first = loadedSearch === null
    const fail = (): void => {
      if (ticket !== seq.current) return
      if (first) setFallback(root)
      else setState({ root, search, issues: null, failed: true })
    }
    const run = (): void => {
      backend.listRepoIssues(root, search).then((result) => {
        if (result.status !== 'ok') return fail()
        if (ticket === seq.current) setState({ root, search, issues: result.issues, failed: false })
      }, fail)
    }
    if (first) {
      run()
      return
    }
    const timer = setTimeout(run, ISSUE_SEARCH_DEBOUNCE_MS)
    return () => clearTimeout(timer)
  }, [backend, enabled, root, search, fallback, loadedSearch])

  const issues = current?.issues ?? null
  const options = useMemo(() => (issues ? issueOptions(issues, search) : []), [issues, search])
  if (root === null || fallback === root) return { mode: 'number' }
  if (current === null) return { mode: 'combobox', status: 'loading', options: [] }
  if (current.failed) return { mode: 'combobox', status: 'error', options: issueOptions([], search) }
  return { mode: 'combobox', status: current.search === search ? 'ready' : 'loading', options }
}

const NOUN: Record<PickerKind, string> = { issue: 'issue', pr: 'pull request', file: 'file' }

export function InputPicker({
  id,
  label,
  kind,
  value,
  disabled,
  repoRoot,
  filesRoot,
  className,
  onChange
}: InputPickerProps): JSX.Element {
  const [text, setText] = useState(value)
  const [search, setSearch] = useState('')
  const files = useFileSource(kind === 'file', filesRoot, search)
  const prs = usePrSource(kind === 'pr', repoRoot, search)
  const issues = useIssueSource(kind === 'issue', repoRoot, search)
  const source = kind === 'file' ? files : kind === 'pr' ? prs : issues
  const listed = files.files

  useEffect(() => {
    if (kind === 'file' && listed !== null && value !== '' && !listed.has(value)) {
      setText('')
      onChange('')
    }
  }, [kind, listed, value, onChange])

  if (source.mode === 'number') {
    const hintId = `${id}-hint`
    return (
      <div className="space-y-1">
        <input
          id={id}
          type="text"
          inputMode="numeric"
          pattern="[0-9]*"
          value={value}
          placeholder={`${NOUN[kind]} number`}
          disabled={disabled}
          required
          autoComplete="off"
          aria-describedby={hintId}
          onChange={(e) => onChange(digitsOnly(e.target.value))}
          className={className}
        />
        <p id={hintId} className="text-xs text-faint">
          GitHub isn't available here. Enter the {NOUN[kind]} number.
        </p>
      </div>
    )
  }

  const select = (option: PickerOption): void => {
    if (kind === 'file' && !listed?.has(option.value)) return
    setText(option.label)
    onChange(option.value)
  }

  return (
    <Combobox
      id={id}
      label={label}
      text={text}
      options={source.options}
      status={source.status}
      placeholder={kind === 'file' ? 'Search files' : `Search ${NOUN[kind]}s or type a number`}
      emptyText={kind === 'file' ? 'No matching files' : `No matching ${NOUN[kind]}s`}
      errorText={`Couldn't search ${NOUN[kind]}s`}
      disabled={disabled}
      className={className}
      onTextChange={(next) => {
        setText(next)
        setSearch(next)
        if (value !== '') onChange('')
      }}
      onSelect={select}
    />
  )
}
