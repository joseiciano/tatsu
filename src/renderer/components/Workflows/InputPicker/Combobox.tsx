import { useEffect, useState, type KeyboardEvent } from 'react'
import { Loader2 } from 'lucide-react'
import type { PickerOption, PickerStatus } from './types'

export interface ComboboxProps {
  id: string
  label: string
  text: string
  options: PickerOption[]
  status: PickerStatus
  placeholder: string
  emptyText: string
  errorText: string
  disabled: boolean
  className: string
  onTextChange: (text: string) => void
  onSelect: (option: PickerOption) => void
}

export function Combobox({
  id,
  label,
  text,
  options,
  status,
  placeholder,
  emptyText,
  errorText,
  disabled,
  className,
  onTextChange,
  onSelect
}: ComboboxProps): JSX.Element {
  const [open, setOpen] = useState(false)
  const [active, setActive] = useState(-1)
  const listboxId = `${id}-listbox`
  const optionId = (index: number): string => `${id}-option-${index}`
  const activeIndex = active < options.length ? active : options.length - 1
  const message =
    options.length > 0 ? null : status === 'loading' ? 'Loading…' : status === 'error' ? errorText : emptyText

  useEffect(() => {
    if (!open || activeIndex < 0) return
    document.getElementById(optionId(activeIndex))?.scrollIntoView?.({ block: 'nearest' })
  })

  const choose = (option: PickerOption): void => {
    onSelect(option)
    setOpen(false)
    setActive(-1)
  }

  const move = (delta: number): void => {
    if (!open) {
      setOpen(true)
      setActive(options.length > 0 ? 0 : -1)
      return
    }
    if (options.length === 0) return
    setActive(Math.min(options.length - 1, Math.max(0, activeIndex + delta)))
  }

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>): void => {
    switch (e.key) {
      case 'ArrowDown':
        e.preventDefault()
        move(1)
        return
      case 'ArrowUp':
        e.preventDefault()
        move(-1)
        return
      case 'Enter':
        if (!open) return
        e.preventDefault()
        if (activeIndex >= 0) choose(options[activeIndex])
        return
      case 'Escape':
        if (!open) return
        e.preventDefault()
        e.stopPropagation()
        setOpen(false)
        setActive(-1)
        return
    }
  }

  return (
    <div className="relative">
      <div className="relative">
        <input
          id={id}
          type="text"
          role="combobox"
          aria-autocomplete="list"
          aria-expanded={open}
          aria-controls={listboxId}
          aria-activedescendant={open && activeIndex >= 0 ? optionId(activeIndex) : undefined}
          value={text}
          placeholder={placeholder}
          disabled={disabled}
          required
          spellCheck={false}
          autoComplete="off"
          onChange={(e) => {
            onTextChange(e.target.value)
            setOpen(true)
            setActive(0)
          }}
          onClick={() => setOpen(true)}
          onBlur={() => {
            setOpen(false)
            setActive(-1)
          }}
          onKeyDown={onKeyDown}
          className={className}
        />
        {status === 'loading' && (
          <Loader2 aria-hidden="true" className="icon-xs animate-spin text-dim absolute right-2 top-1/2 -translate-y-1/2" />
        )}
      </div>
      <ul
        id={listboxId}
        role="listbox"
        aria-label={`${label} options`}
        hidden={!open || options.length === 0}
        className="absolute z-10 mt-1 w-full max-h-48 overflow-y-auto rounded border border-border bg-panel shadow-lg py-1"
      >
        {options.map((option, index) => (
          <li
            key={option.value}
            id={optionId(index)}
            role="option"
            aria-selected={index === activeIndex}
            onMouseDown={(e) => e.preventDefault()}
            onMouseEnter={() => setActive(index)}
            onClick={() => choose(option)}
            className={`px-2.5 py-1 text-xs cursor-pointer flex items-baseline gap-2 ${
              index === activeIndex ? 'bg-accent/20 text-fg-bright' : 'text-fg'
            }`}
          >
            <span className="font-mono truncate">{option.label}</span>
            {option.detail !== undefined && <span className="ml-auto shrink-0 text-faint truncate">{option.detail}</span>}
          </li>
        ))}
      </ul>
      {open && message !== null && (
        <div role="status" className="absolute z-10 mt-1 w-full rounded border border-border bg-panel px-2.5 py-1.5 text-xs text-dim">
          {message}
        </div>
      )}
    </div>
  )
}
