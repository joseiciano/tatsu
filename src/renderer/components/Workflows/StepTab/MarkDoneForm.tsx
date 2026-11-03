import { useId, useMemo, useRef, useState } from 'react'
import { STEP_OUTPUT_STRING_MAX_CHARS, STEP_SUMMARY_MAX_CHARS, type ResolvedWorkflowStep } from '../../../../shared/workflow-def'
import type { WorkflowActionResponse, WorkflowMarkDonePayload } from '../../../../shared/state/workflows'
import { useFocusTrap } from '../../../hooks/useFocusTrap'
import {
  buildMarkDoneFields,
  initialMarkDoneValues,
  markDonePayload,
  type MarkDoneErrors,
  type MarkDoneField,
  type MarkDoneValues
} from './StepTab'

interface MarkDoneFormProps {
  step: ResolvedWorkflowStep | undefined
  active: boolean
  onSubmit: (payload: WorkflowMarkDonePayload) => Promise<WorkflowActionResponse>
}

const INPUT_CLASS =
  'w-full rounded border border-border bg-panel px-2 py-1 text-xs text-fg-bright outline-none focus:border-accent aria-[invalid=true]:border-danger'

function FieldError({ id, message }: { id: string; message: string | undefined }): JSX.Element | null {
  if (!message) return null
  return (
    <p id={id} className="text-xs text-danger break-words">
      {message}
    </p>
  )
}

interface FieldInputProps {
  field: MarkDoneField
  id: string
  value: string | boolean
  error: string | undefined
  onChange: (value: string | boolean) => void
}

function FieldInput({ field, id, value, error, onChange }: FieldInputProps): JSX.Element {
  const errorId = `${id}-error`
  const hintId = `${id}-hint`
  const describedBy = [field.kind === 'list' ? hintId : null, error ? errorId : null].filter(Boolean).join(' ') || undefined
  const common = {
    id,
    'aria-invalid': error ? true : undefined,
    'aria-describedby': describedBy,
    'aria-required': field.required || undefined
  }
  const text = typeof value === 'string' ? value : ''
  const label = (
    <label htmlFor={id} className="text-xs text-fg">
      {field.name}
      {field.required && <span className="text-dim"> (required)</span>}
    </label>
  )

  if (field.kind === 'boolean') {
    return (
      <div className="flex flex-col gap-1">
        <div className="flex items-center gap-2">
          <input
            {...common}
            type="checkbox"
            checked={value === true}
            onChange={(e) => onChange(e.target.checked)}
            className="icon-base accent-accent cursor-pointer"
          />
          {label}
        </div>
        <FieldError id={errorId} message={error} />
      </div>
    )
  }

  let control: JSX.Element
  switch (field.kind) {
    case 'enum':
      control = (
        <select {...common} value={text} onChange={(e) => onChange(e.target.value)} className={INPUT_CLASS}>
          <option value="">—</option>
          {field.options.map((option, i) => (
            <option key={i} value={String(i)}>
              {String(option)}
            </option>
          ))}
        </select>
      )
      break
    case 'list':
      control = (
        <textarea
          {...common}
          rows={3}
          value={text}
          onChange={(e) => onChange(e.target.value)}
          className={`${INPUT_CLASS} resize-y`}
        />
      )
      break
    case 'number':
      control = (
        <input
          {...common}
          type="text"
          inputMode="decimal"
          value={text}
          onChange={(e) => onChange(e.target.value)}
          className={INPUT_CLASS}
        />
      )
      break
    case 'text':
      control = (
        <input
          {...common}
          type="text"
          maxLength={STEP_OUTPUT_STRING_MAX_CHARS}
          value={text}
          onChange={(e) => onChange(e.target.value)}
          className={INPUT_CLASS}
        />
      )
      break
    default: {
      const _exhaustive: never = field
      return _exhaustive
    }
  }

  return (
    <div className="flex flex-col gap-1">
      {label}
      {control}
      {field.kind === 'list' && (
        <p id={hintId} className="text-xs text-dim">
          One item per line
        </p>
      )}
      <FieldError id={errorId} message={error} />
    </div>
  )
}

export function MarkDoneForm({ step, active, onSubmit }: MarkDoneFormProps): JSX.Element {
  const baseId = useId()
  const fields = useMemo(() => buildMarkDoneFields(step), [step])
  const [summary, setSummary] = useState('')
  const [values, setValues] = useState<MarkDoneValues>(() => initialMarkDoneValues(fields))
  const [errors, setErrors] = useState<MarkDoneErrors>({})
  const [serverError, setServerError] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)
  const [done, setDone] = useState(false)
  const formRef = useRef<HTMLFormElement | null>(null)
  const summaryRef = useRef<HTMLTextAreaElement | null>(null)

  useFocusTrap(formRef, { active, initialFocus: summaryRef })

  const fieldId = (name: string): string => `${baseId}-f-${name}`
  const summaryId = `${baseId}-summary`

  const focusFirstInvalid = (next: MarkDoneErrors): void => {
    const order = ['summary', ...fields.map((f) => f.name)]
    const first = order.find((name) => Object.hasOwn(next, name))
    if (!first) return
    document.getElementById(first === 'summary' ? summaryId : fieldId(first))?.focus()
  }

  const submit = async (e: React.FormEvent): Promise<void> => {
    e.preventDefault()
    if (submitting || done) return
    setServerError(null)
    const result = markDonePayload(step, summary, values)
    if (!result.ok) {
      setErrors(result.errors)
      focusFirstInvalid(result.errors)
      return
    }
    setErrors({})
    setSubmitting(true)
    try {
      const response = await onSubmit(result.payload)
      if ('error' in response) setServerError(response.error)
      else setDone(true)
    } catch {
      setServerError('Could not mark the step done')
    } finally {
      setSubmitting(false)
    }
  }

  const formError = errors[''] ?? serverError

  return (
    <form
      ref={formRef}
      noValidate
      aria-label="Mark step done"
      onSubmit={(e) => void submit(e)}
      className="flex flex-col gap-3 pt-3 border-t border-border"
    >
      <div className="flex flex-col gap-1">
        <label htmlFor={summaryId} className="text-xs text-fg">
          Summary <span className="text-dim">(required)</span>
        </label>
        <textarea
          ref={summaryRef}
          id={summaryId}
          rows={3}
          maxLength={STEP_SUMMARY_MAX_CHARS}
          value={summary}
          onChange={(e) => setSummary(e.target.value)}
          aria-required
          aria-invalid={errors.summary ? true : undefined}
          aria-describedby={errors.summary ? `${summaryId}-error` : undefined}
          className={`${INPUT_CLASS} resize-y`}
        />
        <FieldError id={`${summaryId}-error`} message={errors.summary} />
      </div>
      {fields.map((field) => (
        <FieldInput
          key={field.name}
          field={field}
          id={fieldId(field.name)}
          value={values[field.name] ?? ''}
          error={errors[field.name]}
          onChange={(value) => setValues((prev) => ({ ...prev, [field.name]: value }))}
        />
      ))}
      {formError && (
        <p role="alert" className="text-xs text-danger break-words">
          {formError}
        </p>
      )}
      <div className="flex justify-end">
        <button
          type="submit"
          disabled={submitting || done}
          className="text-xs px-3 py-1.5 rounded bg-accent text-app hover:opacity-90 cursor-pointer disabled:opacity-50 disabled:cursor-default focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
        >
          {submitting ? 'Marking done…' : 'Mark done'}
        </button>
      </div>
    </form>
  )
}
