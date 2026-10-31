import { LineCounter, isAlias, isMap, isScalar, isSeq, parseDocument, type Document, type Node, type YAMLMap, type YAMLSeq } from 'yaml'
import { PERMISSION_LEVELS, isPermissionLevel, normalizeAllowEntry, sanitizeBashAllow, type PermissionLevel } from '../permission-level'
import type {
  ConditionContext,
  ForeachMode,
  OutputFieldSchema,
  OutputItemSchema,
  OutputScalarType,
  ParsedWorkflowDefinition,
  ParsedWorkflowStep,
  ResolvedDefinition,
  ResolvedStepCommon,
  ResolvedWorkflowStep,
  ValidateWorkflowOptions,
  WorkflowAgent,
  WorkflowCondition,
  WorkflowDefaults,
  WorkflowDiagnostic,
  WorkflowDiagnosticCode,
  WorkflowGate,
  WorkflowInputDef,
  WorkflowInputType,
  WorkflowLoop,
  WorkflowOutputSchema,
  WorkflowScalar,
  WorkflowStepKind,
  WorkflowValidationResult
} from './types'

const MAX_SOURCE_LENGTH = 512 * 1024
const MAX_ALIAS_COUNT = 100
const IDENTIFIER = /^[A-Za-z][A-Za-z0-9_-]*$/

const ROOT_KEYS = ['name', 'inputs', 'item_input', 'defaults', 'steps'] as const
const DEFAULTS_KEYS = ['permissions', 'allow'] as const
const INPUT_KEYS = ['type'] as const
const STEP_KEYS = [
  'id',
  'kind',
  'agent',
  'model',
  'permissions',
  'allow',
  'prompt',
  'run',
  'needs',
  'gate',
  'output',
  'loop',
  'when',
  'on_loop',
  'parallel_safe',
  'timeout',
  'over',
  'mode'
] as const
const LOOP_KEYS = ['back_to', 'until', 'max', 'fresh'] as const
const CONDITION_KEYS = ['field', 'equals', 'in', 'not', 'exit'] as const
const CONDITION_OPERATORS = ['equals', 'in', 'not'] as const
const OUTPUT_FIELD_KEYS = ['type', 'enum', 'items'] as const
const OUTPUT_ITEM_KEYS = ['type', 'enum'] as const

const INPUT_TYPES: readonly WorkflowInputType[] = ['text', 'issue', 'pr', 'file']
const STEP_KINDS: readonly WorkflowStepKind[] = ['agent', 'shell', 'foreach', 'orchestrator']
const GATES: readonly WorkflowGate[] = ['approve']
const FOREACH_MODES: readonly ForeachMode[] = ['independent', 'stacked']
const OUTPUT_SCALAR_TYPES: readonly OutputScalarType[] = ['string', 'number', 'boolean']
const OUTPUT_FIELD_TYPES: readonly (OutputScalarType | 'array')[] = [...OUTPUT_SCALAR_TYPES, 'array']
const WORKFLOW_AGENTS: readonly WorkflowAgent[] = ['claude', 'codex', 'opencode']
const PI_MESSAGE = 'pi is a tab harness, not a workflow step harness in v1'
const SHELL_FORBIDDEN_KEYS = ['agent', 'model', 'prompt', 'permissions', 'allow', 'output'] as const
const DEFAULT_PERMISSION: PermissionLevel = 'edit'

type MaybeNode = Node | null | undefined

interface Entry {
  key: Node
  value: MaybeNode
}

type Entries = Map<string, Entry>

function joinKey(path: string, key: string): string {
  return path ? `${path}.${key}` : key
}

function describeNode(node: MaybeNode): string {
  if (node == null) return 'nothing'
  if (isMap(node)) return 'a mapping'
  if (isSeq(node)) return 'a list'
  if (isScalar(node)) {
    if (node.value === null) return 'nothing'
    if (typeof node.value === 'string') return 'a string'
    if (typeof node.value === 'number') return 'a number'
    if (typeof node.value === 'boolean') return 'a boolean'
  }
  return 'an unsupported value'
}

function quoteList(values: readonly string[]): string {
  return values.map((v) => `"${v}"`).join(', ')
}

function positionOf(lineCounter: LineCounter, offset: number): { line: number; col: number } {
  const { line, col } = lineCounter.linePos(offset)
  return { line: Math.max(1, line), col: Math.max(1, col) }
}

class ShapeWalker {
  readonly diagnostics: WorkflowDiagnostic[] = []

  constructor(
    private readonly doc: Document,
    private readonly lineCounter: LineCounter
  ) {}

  report(code: WorkflowDiagnosticCode, message: string, path: string, ...nodes: MaybeNode[]): void {
    const node = nodes.find((n) => n?.range)
    this.diagnostics.push({ ...positionOf(this.lineCounter, node?.range?.[0] ?? 0), severity: 'error', code, message, path })
  }

  deref(node: MaybeNode, path: string): MaybeNode {
    if (!isAlias(node)) return node
    const target = node.resolve(this.doc)
    if (!target) {
      this.report('alias-limit', `Alias *${node.source} does not refer to a known anchor`, path, node)
      return undefined
    }
    const offset = node.range?.[0] ?? 0
    if (target.range && target.range[0] <= offset && offset < target.range[2]) {
      this.report('alias-limit', `Alias *${node.source} refers to a node that contains it`, path, node)
      return undefined
    }
    return target
  }

  expectMap(raw: MaybeNode, path: string, what: string, fallback?: MaybeNode): YAMLMap | undefined {
    const node = this.deref(raw, path)
    if (isMap(node)) return node
    if (node !== undefined || raw === undefined) {
      this.report('wrong-type', `Expected ${what} to be a mapping, got ${describeNode(node)}`, path, node, fallback)
    }
    return undefined
  }

  expectSeq(raw: MaybeNode, path: string, what: string, fallback?: MaybeNode): YAMLSeq | undefined {
    const node = this.deref(raw, path)
    if (isSeq(node)) return node
    if (node !== undefined || raw === undefined) {
      this.report('wrong-type', `Expected ${what} to be a list, got ${describeNode(node)}`, path, node, fallback)
    }
    return undefined
  }

  entries(map: YAMLMap, path: string, allowed?: readonly string[], what?: string): Entries {
    const out: Entries = new Map()
    for (const pair of map.items) {
      const key = pair.key as MaybeNode
      if (!isScalar(key) || typeof key.value !== 'string') {
        this.report('wrong-type', `Keys must be plain strings, got ${describeNode(key)}`, path, key, map)
        continue
      }
      const name = key.value
      if (allowed && !allowed.includes(name)) {
        this.report('unknown-key', `Unknown key "${name}" in ${what}. Allowed keys: ${quoteList(allowed)}`, joinKey(path, name), key)
        continue
      }
      out.set(name, { key, value: pair.value as MaybeNode })
    }
    return out
  }

  require(entries: Entries, key: string, path: string, map: YAMLMap, what: string): Entry | undefined {
    const entry = entries.get(key)
    if (!entry) this.report('missing-field', `Missing required key "${key}" in ${what}`, joinKey(path, key), map)
    return entry
  }

  scalar(entry: Entry, path: string): { node: MaybeNode; value: unknown } | undefined {
    const node = this.deref(entry.value, path)
    if (node === undefined && isAlias(entry.value)) return undefined
    return { node, value: isScalar(node) ? node.value : undefined }
  }

  string(entry: Entry | undefined, path: string): string | undefined {
    if (!entry) return undefined
    const got = this.scalar(entry, path)
    if (!got) return undefined
    if (typeof got.value === 'string') return got.value
    this.report('wrong-type', `Expected a string, got ${describeNode(got.node)}`, path, got.node, entry.key)
    return undefined
  }

  identifier(entry: Entry | undefined, path: string, what: string): string | undefined {
    const value = this.string(entry, path)
    if (value === undefined) return undefined
    if (IDENTIFIER.test(value)) return value
    this.report('bad-value', `${what} "${value}" must start with a letter and contain only letters, digits, "_" or "-"`, path, entry?.value, entry?.key)
    return undefined
  }

  boolean(entry: Entry | undefined, path: string): boolean | undefined {
    if (!entry) return undefined
    const got = this.scalar(entry, path)
    if (!got) return undefined
    if (typeof got.value === 'boolean') return got.value
    this.report('wrong-type', `Expected a boolean (true or false), got ${describeNode(got.node)}`, path, got.node, entry.key)
    return undefined
  }

  positiveInteger(entry: Entry | undefined, path: string): number | undefined {
    if (!entry) return undefined
    const got = this.scalar(entry, path)
    if (!got) return undefined
    if (typeof got.value !== 'number') {
      this.report('wrong-type', `Expected a positive integer, got ${describeNode(got.node)}`, path, got.node, entry.key)
      return undefined
    }
    if (Number.isInteger(got.value) && got.value > 0) return got.value
    this.report('bad-value', `Expected a positive integer, got ${got.value}`, path, got.node, entry.key)
    return undefined
  }

  oneOf<T extends string>(entry: Entry | undefined, path: string, values: readonly T[]): T | undefined {
    const value = this.string(entry, path)
    if (value === undefined) return undefined
    if ((values as readonly string[]).includes(value)) return value as T
    this.report('bad-value', `"${value}" is not one of ${quoteList(values)}`, path, entry?.value, entry?.key)
    return undefined
  }

  permission(entry: Entry | undefined, path: string): PermissionLevel | undefined {
    const value = this.string(entry, path)
    if (value === undefined) return undefined
    if (isPermissionLevel(value)) return value
    this.report('bad-value', `"${value}" is not a permission level; use one of ${quoteList(PERMISSION_LEVELS)}`, path, entry?.value, entry?.key)
    return undefined
  }

  stringList(entry: Entry | undefined, path: string): string[] | undefined {
    if (!entry) return undefined
    const seq = this.expectSeq(entry.value, path, `"${path}"`, entry.key)
    if (!seq) return undefined
    const out: string[] = []
    let ok = true
    seq.items.forEach((item, i) => {
      const value = this.string({ key: entry.key, value: item as MaybeNode }, `${path}[${i}]`)
      if (value === undefined) ok = false
      else out.push(value)
    })
    return ok ? out : undefined
  }

  scalarValue(entry: Entry, path: string): WorkflowScalar | undefined {
    const got = this.scalar(entry, path)
    if (!got) return undefined
    const v = got.value
    if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') return v
    this.report('wrong-type', `Expected a string, number or boolean, got ${describeNode(got.node)}`, path, got.node, entry.key)
    return undefined
  }

  scalarList(entry: Entry, path: string): WorkflowScalar[] | undefined {
    const seq = this.expectSeq(entry.value, path, `"${path}"`, entry.key)
    if (!seq) return undefined
    if (seq.items.length === 0) {
      this.report('bad-value', 'Expected at least one value', path, seq, entry.key)
      return undefined
    }
    const out: WorkflowScalar[] = []
    let ok = true
    seq.items.forEach((item, i) => {
      const value = this.scalarValue({ key: entry.key, value: item as MaybeNode }, `${path}[${i}]`)
      if (value === undefined) ok = false
      else out.push(value)
    })
    return ok ? out : undefined
  }

  definition(root: MaybeNode): ParsedWorkflowDefinition | undefined {
    if (root == null) {
      this.report('wrong-type', 'The workflow definition is empty; expected a mapping with "name" and "steps"', '')
      return undefined
    }
    const map = this.expectMap(root, '', 'the workflow definition')
    if (!map) return undefined
    const entries = this.entries(map, '', ROOT_KEYS, 'the workflow definition')
    const nameEntry = this.require(entries, 'name', '', map, 'the workflow definition')
    const name = this.string(nameEntry, 'name')
    if (name !== undefined && name.trim() === '') this.report('bad-value', 'The workflow name must not be empty', 'name', nameEntry?.value)
    const inputs = this.inputs(entries.get('inputs'))
    const itemInput = this.identifier(entries.get('item_input'), 'item_input', 'Input name')
    const defaults = this.defaults(entries.get('defaults'))
    const steps = this.steps(this.require(entries, 'steps', '', map, 'the workflow definition'))
    if (name === undefined || inputs === undefined || steps === undefined) return undefined
    const def: ParsedWorkflowDefinition = { name, inputs, steps }
    if (itemInput !== undefined) def.item_input = itemInput
    if (defaults !== undefined) def.defaults = defaults
    return def
  }

  inputs(entry: Entry | undefined): Record<string, WorkflowInputDef> | undefined {
    const out: Record<string, WorkflowInputDef> = Object.create(null)
    if (!entry) return out
    const map = this.expectMap(entry.value, 'inputs', '"inputs"', entry.key)
    if (!map) return undefined
    for (const [name, input] of this.entries(map, 'inputs')) {
      const path = joinKey('inputs', name)
      if (!IDENTIFIER.test(name)) {
        this.report('bad-value', `Input name "${name}" must start with a letter and contain only letters, digits, "_" or "-"`, path, input.key)
        continue
      }
      const inputMap = this.expectMap(input.value, path, `input "${name}"`, input.key)
      if (!inputMap) continue
      const fields = this.entries(inputMap, path, INPUT_KEYS, `input "${name}"`)
      const type = this.oneOf(this.require(fields, 'type', path, inputMap, `input "${name}"`), joinKey(path, 'type'), INPUT_TYPES)
      if (type !== undefined) out[name] = { type }
    }
    return out
  }

  defaults(entry: Entry | undefined): WorkflowDefaults | undefined {
    if (!entry) return undefined
    const map = this.expectMap(entry.value, 'defaults', '"defaults"', entry.key)
    if (!map) return undefined
    const fields = this.entries(map, 'defaults', DEFAULTS_KEYS, '"defaults"')
    const out: WorkflowDefaults = {}
    const permissions = this.permission(fields.get('permissions'), 'defaults.permissions')
    const allow = this.stringList(fields.get('allow'), 'defaults.allow')
    if (permissions !== undefined) out.permissions = permissions
    if (allow !== undefined) out.allow = allow
    return out
  }

  steps(entry: Entry | undefined): ParsedWorkflowStep[] | undefined {
    if (!entry) return undefined
    const seq = this.expectSeq(entry.value, 'steps', '"steps"', entry.key)
    if (!seq) return undefined
    if (seq.items.length === 0) {
      this.report('missing-field', 'A workflow needs at least one step', 'steps', seq)
      return undefined
    }
    const out: ParsedWorkflowStep[] = []
    seq.items.forEach((item, i) => {
      const step = this.step(item as MaybeNode, `steps[${i}]`, seq)
      if (step) out.push(step)
    })
    return out
  }

  step(raw: MaybeNode, path: string, parent: YAMLSeq): ParsedWorkflowStep | undefined {
    const map = this.expectMap(raw, path, 'each step', parent)
    if (!map) return undefined
    const f = this.entries(map, path, STEP_KEYS, 'a step')
    const at = (key: string) => joinKey(path, key)
    const id = this.identifier(this.require(f, 'id', path, map, 'a step'), at('id'), 'Step id')
    const step: ParsedWorkflowStep = { id: id ?? '' }
    const set = <K extends keyof ParsedWorkflowStep>(key: K, value: ParsedWorkflowStep[K] | undefined) => {
      if (value !== undefined) step[key] = value
    }
    set('kind', this.oneOf(f.get('kind'), at('kind'), STEP_KINDS))
    set('agent', this.string(f.get('agent'), at('agent')))
    set('model', this.string(f.get('model'), at('model')))
    set('permissions', this.permission(f.get('permissions'), at('permissions')))
    set('allow', this.stringList(f.get('allow'), at('allow')))
    set('prompt', this.string(f.get('prompt'), at('prompt')))
    set('run', this.string(f.get('run'), at('run')))
    set('needs', this.stringList(f.get('needs'), at('needs')))
    set('gate', this.oneOf(f.get('gate'), at('gate'), GATES))
    set('output', this.output(f.get('output'), at('output')))
    set('loop', this.loop(f.get('loop'), at('loop')))
    set('when', this.condition(f.get('when'), at('when')))
    set('on_loop', this.string(f.get('on_loop'), at('on_loop')))
    set('parallel_safe', this.boolean(f.get('parallel_safe'), at('parallel_safe')))
    set('timeout', this.positiveInteger(f.get('timeout'), at('timeout')))
    set('over', this.string(f.get('over'), at('over')))
    set('mode', this.oneOf(f.get('mode'), at('mode'), FOREACH_MODES))
    return id === undefined ? undefined : step
  }

  loop(entry: Entry | undefined, path: string): WorkflowLoop | undefined {
    if (!entry) return undefined
    const map = this.expectMap(entry.value, path, '"loop"', entry.key)
    if (!map) return undefined
    const f = this.entries(map, path, LOOP_KEYS, '"loop"')
    const backTo = this.string(this.require(f, 'back_to', path, map, '"loop"'), joinKey(path, 'back_to'))
    const until = this.condition(this.require(f, 'until', path, map, '"loop"'), joinKey(path, 'until'))
    const max = this.positiveInteger(this.require(f, 'max', path, map, '"loop"'), joinKey(path, 'max'))
    const fresh = this.boolean(f.get('fresh'), joinKey(path, 'fresh'))
    if (backTo === undefined || until === undefined || max === undefined) return undefined
    const loop: WorkflowLoop = { back_to: backTo, until, max }
    if (fresh !== undefined) loop.fresh = fresh
    return loop
  }

  condition(entry: Entry | undefined, path: string): WorkflowCondition | undefined {
    if (!entry) return undefined
    const map = this.expectMap(entry.value, path, 'a condition', entry.key)
    if (!map) return undefined
    const f = this.entries(map, path, CONDITION_KEYS, 'a condition')
    const exit = f.get('exit')
    if (exit) {
      if (f.size > 1) {
        this.report('bad-condition', 'An "exit" condition cannot be combined with "field", "equals", "in" or "not"', path, map)
        return undefined
      }
      const got = this.scalar(exit, joinKey(path, 'exit'))
      if (!got) return undefined
      if (typeof got.value === 'number' && Number.isInteger(got.value)) return { exit: got.value }
      this.report('wrong-type', `Expected "exit" to be an integer exit code, got ${describeNode(got.node)}`, joinKey(path, 'exit'), got.node, exit.key)
      return undefined
    }
    const operators = CONDITION_OPERATORS.filter((op) => f.has(op))
    if (operators.length !== 1) {
      const found = operators.length === 0 ? 'none' : quoteList(operators)
      this.report('bad-condition', `A condition needs exactly one of "equals", "in" or "not" (found ${found}), or a single "exit"`, path, map)
      return undefined
    }
    const field = this.string(this.require(f, 'field', path, map, 'a condition'), joinKey(path, 'field'))
    const op = operators[0]
    const opEntry = f.get(op)!
    const opPath = joinKey(path, op)
    if (op === 'in') {
      const values = this.scalarList(opEntry, opPath)
      return field === undefined || values === undefined ? undefined : { field, in: values }
    }
    const value = this.scalarValue(opEntry, opPath)
    if (field === undefined || value === undefined) return undefined
    return op === 'equals' ? { field, equals: value } : { field, not: value }
  }

  output(entry: Entry | undefined, path: string): WorkflowOutputSchema | undefined {
    if (!entry) return undefined
    const map = this.expectMap(entry.value, path, '"output"', entry.key)
    if (!map) return undefined
    const fields: Record<string, OutputFieldSchema> = Object.create(null)
    const out: WorkflowOutputSchema = { fields }
    let ok = true
    for (const [name, field] of this.entries(map, path)) {
      const fieldPath = joinKey(path, name)
      if (name === 'required') {
        const required = this.stringList(field, fieldPath)
        if (required === undefined) ok = false
        else out.required = required
        continue
      }
      if (!IDENTIFIER.test(name)) {
        this.report('bad-value', `Output field name "${name}" must start with a letter and contain only letters, digits, "_" or "-"`, fieldPath, field.key)
        ok = false
        continue
      }
      const schema = this.outputField(field, fieldPath, name)
      if (schema === undefined) ok = false
      else fields[name] = schema
    }
    return ok ? out : undefined
  }

  outputField(entry: Entry, path: string, name: string): OutputFieldSchema | undefined {
    const map = this.expectMap(entry.value, path, `output field "${name}"`, entry.key)
    if (!map) return undefined
    const f = this.entries(map, path, OUTPUT_FIELD_KEYS, `output field "${name}"`)
    const base = this.outputBase(f, path, map, OUTPUT_FIELD_TYPES)
    if (!base) return undefined
    const schema: OutputFieldSchema = base
    const items = f.get('items')
    if (schema.type === 'array') {
      if (!items) {
        this.report('missing-field', `Output field "${name}" has type "array" and needs "items"`, joinKey(path, 'items'), map)
        return undefined
      }
      const itemSchema = this.outputItem(items, joinKey(path, 'items'))
      if (!itemSchema) return undefined
      schema.items = itemSchema
    } else if (items) {
      this.report('bad-value', '"items" is only allowed when "type" is "array"', joinKey(path, 'items'), items.key)
      return undefined
    }
    return schema
  }

  outputItem(entry: Entry, path: string): OutputItemSchema | undefined {
    const map = this.expectMap(entry.value, path, '"items"', entry.key)
    if (!map) return undefined
    const f = this.entries(map, path, OUTPUT_ITEM_KEYS, '"items"')
    return this.outputBase(f, path, map, OUTPUT_SCALAR_TYPES) as OutputItemSchema | undefined
  }

  outputBase<T extends string>(
    f: Entries,
    path: string,
    map: YAMLMap,
    types: readonly T[]
  ): { type?: T; enum?: WorkflowScalar[] } | undefined {
    const typeEntry = f.get('type')
    const enumEntry = f.get('enum')
    if (!typeEntry && !enumEntry) {
      this.report('missing-field', 'An output schema needs "type" or "enum"', joinKey(path, 'type'), map)
      return undefined
    }
    const out: { type?: T; enum?: WorkflowScalar[] } = {}
    if (typeEntry) {
      const type = this.oneOf(typeEntry, joinKey(path, 'type'), types)
      if (type === undefined) return undefined
      out.type = type
    }
    if (enumEntry) {
      const values = this.scalarList(enumEntry, joinKey(path, 'enum'))
      if (values === undefined) return undefined
      out.enum = values
    }
    return out
  }
}

type Locate = (path: string) => { line: number; col: number }

interface NeedsNode {
  id: string
  needs: readonly string[]
}

export function needsClosure(steps: readonly NeedsNode[], stepId: string): Set<string> {
  const byId = new Map<string, NeedsNode>()
  for (const step of steps) if (!byId.has(step.id)) byId.set(step.id, step)
  const seen = new Set<string>()
  const pending = [...(byId.get(stepId)?.needs ?? [])]
  while (pending.length > 0) {
    const id = pending.pop()!
    const step = byId.get(id)
    if (!step || seen.has(id)) continue
    seen.add(id)
    for (const dep of step.needs) pending.push(dep)
  }
  return seen
}

function findCycles(steps: readonly NeedsNode[]): string[][] {
  const byId = new Map(steps.map((s) => [s.id, s]))
  const state = new Map<string, 'active' | 'done'>()
  const cycles: string[][] = []
  for (const root of steps) {
    if (state.has(root.id)) continue
    const path: string[] = []
    const frames: { id: string; next: number }[] = [{ id: root.id, next: 0 }]
    state.set(root.id, 'active')
    path.push(root.id)
    while (frames.length > 0) {
      const frame = frames[frames.length - 1]
      const needs = byId.get(frame.id)?.needs ?? []
      if (frame.next >= needs.length) {
        frames.pop()
        path.pop()
        state.set(frame.id, 'done')
        continue
      }
      const dep = needs[frame.next++]
      const depState = state.get(dep)
      if (depState === 'active') cycles.push(path.slice(path.indexOf(dep)))
      else if (depState === undefined && byId.has(dep)) {
        state.set(dep, 'active')
        path.push(dep)
        frames.push({ id: dep, next: 0 })
      }
    }
  }
  return cycles
}

function isWorkflowAgent(value: string): value is WorkflowAgent {
  return (WORKFLOW_AGENTS as readonly string[]).includes(value)
}

function preview(value: string): string {
  return value.length > 60 ? `${value.slice(0, 60)}…` : value
}

class GraphStage {
  readonly diagnostics: WorkflowDiagnostic[] = []

  constructor(
    private readonly def: ParsedWorkflowDefinition,
    private readonly locate: Locate
  ) {}

  report(code: WorkflowDiagnosticCode, message: string, path: string, severity: WorkflowDiagnostic['severity'] = 'error'): void {
    this.diagnostics.push({ ...this.locate(path), severity, code, message, path })
  }

  run(): ResolvedDefinition | undefined {
    const { def } = this
    if (def.item_input !== undefined && !Object.hasOwn(def.inputs, def.item_input)) {
      this.report('unknown-ref', `"item_input" names "${def.item_input}", which is not a declared input`, 'item_input')
    }
    const needs = def.steps.map((step, i) => step.needs ?? (i === 0 ? [] : [def.steps[i - 1].id]))
    if (this.checkIds()) this.checkGraph(needs)
    const defaultAllow = this.resolveAllow(def.defaults?.allow ?? [], 'defaults.allow')
    const steps = def.steps.map((step, i) => this.resolveStep(step, i, needs[i], defaultAllow))
    if (this.diagnostics.some((d) => d.severity === 'error')) return undefined
    const resolved: ResolvedDefinition = { name: def.name, inputs: def.inputs, steps: steps.filter((s) => s !== undefined) }
    if (def.item_input !== undefined) resolved.item_input = def.item_input
    return resolved
  }

  checkIds(): boolean {
    const first = new Map<string, number>()
    let unique = true
    this.def.steps.forEach((step, i) => {
      const prior = first.get(step.id)
      if (prior === undefined) {
        first.set(step.id, i)
        return
      }
      unique = false
      this.report('duplicate-id', `Step id "${step.id}" is already used by steps[${prior}]`, `steps[${i}].id`)
    })
    return unique
  }

  checkGraph(needs: readonly string[][]): void {
    const steps = this.def.steps
    const ids = new Set(steps.map((s) => s.id))
    let needsOk = true
    steps.forEach((step, i) => {
      step.needs?.forEach((ref, j) => {
        if (ids.has(ref)) return
        needsOk = false
        this.report('unknown-ref', `"needs" names "${ref}", which is not a step in this workflow`, `steps[${i}].needs[${j}]`)
      })
    })
    const nodes = steps.map((step, i) => ({ id: step.id, needs: needs[i].filter((ref) => ids.has(ref)) }))
    const index = new Map(steps.map((s, i) => [s.id, i]))
    for (const cycle of findCycles(nodes)) {
      needsOk = false
      this.reportCycle(cycle, index)
    }
    steps.forEach((step, i) => {
      if (!step.loop) return
      const target = step.loop.back_to
      const path = `steps[${i}].loop.back_to`
      if (!ids.has(target)) {
        this.report('unknown-ref', `"back_to" names "${target}", which is not a step in this workflow`, path)
      } else if (needsOk && !needsClosure(nodes, step.id).has(target)) {
        this.report('bad-back-to', `"back_to" must name a step that "${step.id}" depends on through "needs"; "${target}" is not upstream of it`, path)
      }
    })
  }

  reportCycle(cycle: readonly string[], index: ReadonlyMap<string, number>): void {
    let start = 0
    cycle.forEach((id, k) => {
      if ((index.get(id) ?? 0) < (index.get(cycle[start]) ?? 0)) start = k
    })
    const ordered = [...cycle.slice(start), ...cycle.slice(0, start)]
    const stepIndex = index.get(ordered[0]) ?? 0
    const successor = ordered[1 % ordered.length]
    const entry = this.def.steps[stepIndex].needs?.indexOf(successor) ?? -1
    const path = entry >= 0 ? `steps[${stepIndex}].needs[${entry}]` : `steps[${stepIndex}].needs`
    this.report('cycle', `Steps form a "needs" cycle: ${[...ordered, ordered[0]].join(' -> ')}`, path)
  }

  resolveAllow(list: readonly string[], path: string): string[] {
    list.forEach((raw, j) => {
      if (sanitizeBashAllow([normalizeAllowEntry(raw)]).length > 0) return
      this.report(
        'unsafe-allow',
        `Allow pattern "${preview(raw)}" is dropped: patterns must be non-empty, at most 200 characters, and free of , ( ) quotes, backticks, line breaks and "*" (other than a trailing " *")`,
        `${path}[${j}]`,
        'warning'
      )
    })
    return sanitizeBashAllow(list.map(normalizeAllowEntry))
  }

  resolveStep(step: ParsedWorkflowStep, i: number, needs: string[], defaultAllow: readonly string[]): ResolvedWorkflowStep | undefined {
    const at = (key: string) => `steps[${i}].${key}`
    const kind = step.kind ?? 'agent'
    const common: ResolvedStepCommon = { id: step.id, needs: [...needs] }
    if (step.gate !== undefined) common.gate = step.gate
    if (step.loop !== undefined) common.loop = step.loop
    if (step.when !== undefined) common.when = step.when
    if (step.on_loop !== undefined) common.on_loop = step.on_loop
    if (step.parallel_safe !== undefined) common.parallel_safe = step.parallel_safe
    if (step.timeout !== undefined) common.timeout = step.timeout

    if (kind === 'shell') {
      for (const key of SHELL_FORBIDDEN_KEYS) {
        if (step[key] !== undefined) this.report('kind-mismatch', `"${key}" is not allowed on a shell step`, at(key))
      }
      if (step.run === undefined) {
        this.report('missing-field', 'A shell step needs "run"', at('run'))
        return undefined
      }
      return { ...common, kind, run: step.run }
    }

    this.checkExitConditions(step, i)
    this.checkRequiredOutput(step, i)
    const allow = step.allow === undefined ? [...defaultAllow] : this.resolveAllow(step.allow, at('allow'))

    if (kind !== 'agent') {
      const reserved: ResolvedWorkflowStep = { ...step, kind, needs: common.needs }
      if (step.allow !== undefined) reserved.allow = allow
      return reserved
    }

    const agent = this.agent(step, at('agent'))
    if (step.prompt === undefined) this.report('missing-field', 'An agent step needs "prompt"', at('prompt'))
    if (agent === undefined || step.prompt === undefined) return undefined
    const resolved: ResolvedWorkflowStep = {
      ...common,
      kind,
      agent,
      prompt: step.prompt,
      permissions: step.permissions ?? this.def.defaults?.permissions ?? DEFAULT_PERMISSION,
      allow
    }
    if (step.model !== undefined) resolved.model = step.model
    if (step.output !== undefined) resolved.output = step.output
    return resolved
  }

  agent(step: ParsedWorkflowStep, path: string): WorkflowAgent | undefined {
    if (step.agent === undefined) {
      this.report('missing-field', `An agent step needs "agent" (one of ${quoteList(WORKFLOW_AGENTS)})`, path)
      return undefined
    }
    if (isWorkflowAgent(step.agent)) return step.agent
    if (step.agent === 'pi') this.report('bad-value', PI_MESSAGE, path)
    else this.report('bad-value', `"${preview(step.agent)}" is not one of ${quoteList(WORKFLOW_AGENTS)}`, path)
    return undefined
  }

  checkExitConditions(step: ParsedWorkflowStep, i: number): void {
    const message = 'An "exit" condition is only allowed on a shell step'
    if (step.when && 'exit' in step.when) this.report('bad-condition', message, `steps[${i}].when.exit`)
    if (step.loop && 'exit' in step.loop.until) this.report('bad-condition', message, `steps[${i}].loop.until.exit`)
  }

  checkRequiredOutput(step: ParsedWorkflowStep, i: number): void {
    const output = step.output
    output?.required?.forEach((name, j) => {
      if (Object.hasOwn(output.fields, name)) return
      this.report('unknown-ref', `"required" names "${name}", which is not a declared output field`, `steps[${i}].output.required[${j}]`)
    })
  }
}

function nodeAt(doc: Document, path: string): MaybeNode {
  let node = doc.contents as MaybeNode
  for (const segment of path.match(/[^.[\]]+/g) ?? []) {
    const container = isAlias(node) ? node.resolve(doc) : node
    let next: MaybeNode
    if (isMap(container)) {
      const pair = container.items.find((p) => isScalar(p.key) && p.key.value === segment)
      next = pair?.value as MaybeNode
    } else if (isSeq(container) && /^\d+$/.test(segment)) {
      next = container.items[Number(segment)] as MaybeNode
    }
    if (!next?.range) break
    node = next
  }
  return node
}

function diagnosticAt(
  lineCounter: LineCounter,
  code: WorkflowDiagnosticCode,
  message: string,
  offset: number,
  severity: WorkflowDiagnostic['severity'] = 'error'
): WorkflowDiagnostic {
  return { severity, code, message, path: '', ...positionOf(lineCounter, offset) }
}

function parseStage(text: string): WorkflowValidationResult {
  const lineCounter = new LineCounter()
  if (text.length > MAX_SOURCE_LENGTH) {
    return { diagnostics: [diagnosticAt(lineCounter, 'too-large', `Workflow definitions are limited to ${MAX_SOURCE_LENGTH} characters`, 0)] }
  }
  const doc = parseDocument(text, {
    lineCounter,
    prettyErrors: false,
    schema: 'core',
    customTags: [],
    resolveKnownTags: false,
    merge: false,
    uniqueKeys: true,
    keepSourceTokens: false
  })
  const diagnostics: WorkflowDiagnostic[] = []
  for (const err of doc.errors) {
    diagnostics.push(diagnosticAt(lineCounter, 'yaml-syntax', err.message, err.pos[0]))
  }
  for (const warn of doc.warnings) {
    if (warn.code === 'TAG_RESOLVE_FAILED') {
      diagnostics.push(diagnosticAt(lineCounter, 'yaml-tag', `${warn.message}; custom YAML tags are not supported`, warn.pos[0]))
    } else {
      diagnostics.push(diagnosticAt(lineCounter, 'yaml-syntax', warn.message, warn.pos[0], 'warning'))
    }
  }
  if (diagnostics.some((d) => d.severity === 'error')) return { diagnostics }
  try {
    doc.toJS({ maxAliasCount: MAX_ALIAS_COUNT })
  } catch (err) {
    if (!(err instanceof ReferenceError)) throw err
    diagnostics.push(diagnosticAt(lineCounter, 'alias-limit', 'Too many alias expansions; simplify the anchors and aliases in this file', 0))
    return { diagnostics }
  }
  const walker = new ShapeWalker(doc, lineCounter)
  const parsed = walker.definition(doc.contents as MaybeNode)
  diagnostics.push(...walker.diagnostics)
  if (!parsed || diagnostics.some((d) => d.severity === 'error')) return { diagnostics }
  const graph = new GraphStage(parsed, (path) => positionOf(lineCounter, nodeAt(doc, path)?.range?.[0] ?? 0))
  const definition = graph.run()
  diagnostics.push(...graph.diagnostics)
  return definition ? { parsed, definition, diagnostics } : { parsed, diagnostics }
}

export function validateWorkflowDefinition(text: string, _opts: ValidateWorkflowOptions = {}): WorkflowValidationResult {
  try {
    return parseStage(text)
  } catch {
    return { diagnostics: [{ severity: 'error', code: 'internal', message: 'The workflow definition could not be validated', path: '', line: 1, col: 1 }] }
  }
}

export function evaluateCondition(cond: WorkflowCondition, ctx: ConditionContext): boolean {
  if ('exit' in cond) return ctx.exitCode !== undefined && ctx.exitCode === cond.exit
  const data = ctx.data
  if (!data || !Object.hasOwn(data, cond.field)) return false
  const value = data[cond.field]
  if ('equals' in cond) return value === cond.equals
  if ('in' in cond) return cond.in.some((v) => v === value)
  return value !== cond.not
}
