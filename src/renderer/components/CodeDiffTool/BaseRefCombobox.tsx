import { useEffect, useMemo, useRef, useState } from 'react'
import { ChevronDown } from 'lucide-react'
import type { BranchForCompare } from '../../types'

interface BaseRefComboboxProps {
  value: string
  options: BranchForCompare[]
  error: string | null
  onSubmit: (ref: string) => void
}

const SOURCE_LABEL: Record<BranchForCompare['source'], string> = {
  local: 'local',
  remote: 'remote',
  tag: 'tag'
}

const MAX_OPTIONS = 50

export function BaseRefCombobox({ value, options, error, onSubmit }: BaseRefComboboxProps): JSX.Element {
  const [draft, setDraft] = useState(value)
  const [open, setOpen] = useState(false)
  const [highlight, setHighlight] = useState(0)
  const rootRef = useRef<HTMLDivElement>(null)

  useEffect(() => setDraft(value), [value])

  const filtered = useMemo(() => {
    const q = draft.trim().toLowerCase()
    const list = q && q !== value.toLowerCase() ? options.filter((o) => o.name.toLowerCase().includes(q)) : options
    return list.slice(0, MAX_OPTIONS)
  }, [draft, options, value])

  useEffect(() => setHighlight(0), [filtered])

  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent): void => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false)
    }
    window.addEventListener('mousedown', onDown)
    return () => window.removeEventListener('mousedown', onDown)
  }, [open])

  const submit = (ref: string): void => {
    setOpen(false)
    if (ref.trim()) onSubmit(ref.trim())
  }

  return (
    <div ref={rootRef} className="relative no-drag">
      <div
        className={`flex items-center gap-1 rounded border bg-bg px-1.5 py-0.5 ${
          error ? 'border-danger' : 'border-border'
        }`}
      >
        <input
          role="combobox"
          aria-expanded={open}
          aria-controls="code-diff-base-ref-list"
          aria-label="Base ref"
          value={draft}
          spellCheck={false}
          onChange={(e) => {
            setDraft(e.target.value)
            setOpen(true)
          }}
          onFocus={() => setOpen(true)}
          onKeyDown={(e) => {
            if (e.key === 'ArrowDown') {
              e.preventDefault()
              setOpen(true)
              setHighlight((h) => Math.min(filtered.length - 1, h + 1))
            } else if (e.key === 'ArrowUp') {
              e.preventDefault()
              setHighlight((h) => Math.max(0, h - 1))
            } else if (e.key === 'Enter') {
              e.preventDefault()
              const picked = open && draft !== value ? filtered[highlight] : undefined
              submit(picked && !options.some((o) => o.name === draft.trim()) ? picked.name : draft)
            } else if (e.key === 'Escape') {
              e.preventDefault()
              e.stopPropagation()
              setOpen(false)
              setDraft(value)
            }
          }}
          className="w-48 bg-transparent font-mono text-xs text-fg outline-none"
        />
        <button
          type="button"
          tabIndex={-1}
          onClick={() => setOpen((o) => !o)}
          className="text-faint hover:text-fg cursor-pointer"
          aria-label="Show refs"
        >
          <ChevronDown className="icon-xs" />
        </button>
      </div>
      {error && <div className="absolute left-0 top-full mt-1 text-xs text-danger whitespace-nowrap">{error}</div>}
      {open && filtered.length > 0 && (
        <ul
          id="code-diff-base-ref-list"
          role="listbox"
          className="absolute left-0 top-full z-30 mt-1 max-h-72 w-72 overflow-y-auto rounded border border-border bg-panel py-1 shadow-lg"
        >
          {filtered.map((o, i) => (
            <li
              key={`${o.source}:${o.name}`}
              role="option"
              aria-selected={i === highlight}
              onMouseDown={(e) => {
                e.preventDefault()
                submit(o.name)
              }}
              onMouseEnter={() => setHighlight(i)}
              className={`flex cursor-pointer items-center gap-2 px-2 py-1 text-xs ${
                i === highlight ? 'bg-accent/15 text-fg-bright' : 'text-fg'
              }`}
            >
              <span className="flex-1 truncate font-mono">{o.name}</span>
              <span className="shrink-0 text-faint">{SOURCE_LABEL[o.source]}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
