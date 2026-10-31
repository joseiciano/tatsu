import type { RenderedTemplate, TemplateRef, TemplateRunField, TemplateScope, TemplateToken } from './types'

const OPEN = '{{'
const CLOSE = '}}'
const SEGMENT = /^[A-Za-z][A-Za-z0-9_-]*$/
const ROOTS = ['inputs', 'steps', 'run', 'item'] as const
const RUN_FIELDS: readonly TemplateRunField[] = ['id', 'worktree', 'contextPath']
const STEP_PROPERTIES = ['summary', 'status', 'data'] as const
const LITERAL_NOTE = 'a literal "{{" is not supported in v1'

type Parsed = { ref: TemplateRef } | { message: string }

function includes<T extends string>(values: readonly T[], value: string): value is T {
  return (values as readonly string[]).includes(value)
}

function parseReference(raw: string): Parsed {
  const inner = raw.slice(OPEN.length, -CLOSE.length).trim()
  if (inner === '') return { message: `Empty template token "${raw}"; ${LITERAL_NOTE}` }
  const segments = inner.split('.')
  if (!segments.every((s) => SEGMENT.test(s))) {
    return {
      message: `Malformed template token "${raw}": use dotted names of letters, digits, "_" or "-" like {{steps.plan.summary}}; expressions, filters and wildcards are not supported, and ${LITERAL_NOTE}`
    }
  }
  const [root, ...rest] = segments
  if (!includes(ROOTS, root)) return { message: `Unknown template root "${root}"; use one of "inputs", "steps", "run" or "item"` }
  if (rest.length === 0) return { message: `"${root}" needs a name after it, like {{${root === 'steps' ? 'steps.<id>.summary' : `${root}.<name>`}}}` }
  if (root === 'inputs' || root === 'item') {
    if (rest.length > 1) return { message: `"${root}.${rest[0]}" is one level deep; "${inner}" has too many parts` }
    return { ref: root === 'inputs' ? { root, name: rest[0] } : { root, field: rest[0] } }
  }
  if (root === 'run') {
    const field = rest[0]
    if (rest.length > 1 || !includes(RUN_FIELDS, field)) return { message: `Unknown run property "${rest.join('.')}"; use "id", "worktree" or "contextPath"` }
    return { ref: { root, field } }
  }
  const [step, property, field, ...extra] = rest
  if (property === undefined) return { message: `"steps.${step}" needs a property: "summary", "status" or "data.<field>"` }
  if (!includes(STEP_PROPERTIES, property)) {
    return { message: `Unknown step property "${property}" in "${inner}"; use "summary", "status" or "data.<field>"` }
  }
  if (property !== 'data') {
    if (field !== undefined) return { message: `"steps.${step}.${property}" has too many parts in "${inner}"` }
    return { ref: { root, step, property } }
  }
  if (field === undefined) return { message: `"steps.${step}.data" needs a field, like {{steps.${step}.data.<field>}}` }
  if (extra.length > 0) return { message: `"steps.${step}.data.${field}" is one level deep; "${inner}" has too many parts` }
  return { ref: { root, step, property, field } }
}

export function tokenizeTemplate(text: string): TemplateToken[] {
  const tokens: TemplateToken[] = []
  let pos = 0
  while (pos < text.length) {
    const open = text.indexOf(OPEN, pos)
    if (open < 0) {
      tokens.push({ kind: 'text', start: pos, text: text.slice(pos) })
      break
    }
    if (open > pos) tokens.push({ kind: 'text', start: pos, text: text.slice(pos, open) })
    const close = text.indexOf(CLOSE, open + OPEN.length)
    if (close < 0) {
      tokens.push({
        kind: 'error',
        start: open,
        raw: text.slice(open),
        message: `Unclosed "{{": every "{{" needs a matching "}}"; ${LITERAL_NOTE}`
      })
      break
    }
    const end = close + CLOSE.length
    const raw = text.slice(open, end)
    const parsed = parseReference(raw)
    tokens.push('ref' in parsed ? { kind: 'ref', start: open, raw, ref: parsed.ref } : { kind: 'error', start: open, raw, message: parsed.message })
    pos = end
  }
  return tokens
}

export function formatTemplateRef(ref: TemplateRef): string {
  switch (ref.root) {
    case 'inputs':
      return `inputs.${ref.name}`
    case 'run':
      return `run.${ref.field}`
    case 'item':
      return `item.${ref.field}`
    case 'steps':
      return ref.property === 'data' ? `steps.${ref.step}.data.${ref.field}` : `steps.${ref.step}.${ref.property}`
    default: {
      const _exhaustive: never = ref
      return _exhaustive
    }
  }
}

function own(record: object | undefined, key: string): unknown {
  return record !== undefined && Object.hasOwn(record, key) ? (record as Record<string, unknown>)[key] : undefined
}

function lookup(ref: TemplateRef, scope: TemplateScope): unknown {
  switch (ref.root) {
    case 'inputs':
      return own(scope.inputs, ref.name)
    case 'run':
      return own(scope.run, ref.field)
    case 'item':
      return own(scope.item, ref.field)
    case 'steps': {
      const step = own(scope.steps, ref.step)
      if (typeof step !== 'object' || step === null) return undefined
      if (ref.property !== 'data') return own(step, ref.property)
      const data = own(step, 'data')
      return typeof data === 'object' && data !== null ? own(data, ref.field) : undefined
    }
    default: {
      const _exhaustive: never = ref
      return _exhaustive
    }
  }
}

function stringify(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined
  if (typeof value === 'string') return value
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  return JSON.stringify(value)
}

export function renderTemplate(text: string, scope: TemplateScope): RenderedTemplate {
  const missing = new Set<string>()
  let out = ''
  for (const token of tokenizeTemplate(text)) {
    if (token.kind === 'text') out += token.text
    else if (token.kind === 'error') out += token.raw
    else {
      const value = stringify(lookup(token.ref, scope))
      if (value === undefined) missing.add(formatTemplateRef(token.ref))
      else out += value
    }
  }
  return { text: out, missing: [...missing] }
}
