import { readFileSync } from 'node:fs'
import type { AppState, StateEvent } from '../../src/shared/state'

export type Schema =
  | { k: 'string' | 'number' | 'boolean' | 'null' | 'unknown' | 'never' }
  | { k: 'lit'; v: string | number | boolean }
  | { k: 'ref'; name: string }
  | { k: 'array'; of: Schema }
  | { k: 'tuple'; items: Schema[] }
  | { k: 'object'; fields: Field[] }
  | { k: 'map'; key: Schema; value: Schema }
  | { k: 'union'; of: Schema[] }
  | { k: 'inter'; of: Schema[] }

export interface Field {
  name: string
  optional: boolean
  type: Schema
}

export type Defs = Map<string, Schema>

const GENERATED = new URL('../../src/shared/state/generated/generated.ts', import.meta.url)

function tokenize(source: string): string[] {
  const tokens: string[] = []
  const pattern = /\s+|\/\/[^\n]*|("(?:[^"\\]|\\.)*")|([A-Za-z_$][\w$]*)|(-?\d+(?:\.\d+)?)|([{}[\]()<>|&:;,?=])/gy
  while (pattern.lastIndex < source.length) {
    const at = pattern.lastIndex
    const match = pattern.exec(source)
    if (!match) throw new Error(`generated.ts: cannot tokenize at ${at}`)
    const token = match[1] ?? match[2] ?? match[3] ?? match[4]
    if (token !== undefined) tokens.push(token)
  }
  return tokens
}

export function parseDefs(source: string): Defs {
  const tokens = tokenize(source)
  let at = 0
  const peek = (): string | undefined => tokens[at]
  const take = (expected?: string): string => {
    const token = tokens[at++]
    if (expected !== undefined && token !== expected) {
      throw new Error(`generated.ts: expected ${expected}, got ${token} near ${tokens.slice(at - 5, at + 5).join(' ')}`)
    }
    return token
  }

  const union = (): Schema => {
    if (peek() === '|') take()
    const members = [intersection()]
    while (peek() === '|') {
      take()
      members.push(intersection())
    }
    return members.length === 1 ? members[0] : { k: 'union', of: members }
  }
  const intersection = (): Schema => {
    const parts = [postfix()]
    while (peek() === '&') {
      take()
      parts.push(postfix())
    }
    return parts.length === 1 ? parts[0] : { k: 'inter', of: parts }
  }
  const postfix = (): Schema => {
    let schema = primary()
    while (peek() === '[' && tokens[at + 1] === ']') {
      at += 2
      schema = { k: 'array', of: schema }
    }
    return schema
  }
  const separator = (): void => {
    if (peek() === ',' || peek() === ';') take()
  }
  const primary = (): Schema => {
    const token = take()
    if (token === '{') {
      if (peek() === '[') {
        take('[')
        take()
        take('in')
        const key = union()
        take(']')
        take(':')
        const value = union()
        separator()
        take('}')
        return { k: 'map', key, value }
      }
      const fields: Field[] = []
      while (peek() !== '}') {
        const raw = take()
        const name = raw.startsWith('"') ? (JSON.parse(raw) as string) : raw
        const optional = peek() === '?'
        if (optional) take()
        take(':')
        fields.push({ name, optional, type: union() })
        separator()
      }
      take('}')
      return { k: 'object', fields }
    }
    if (token === '[') {
      const items = [union()]
      while (peek() === ',') {
        take()
        items.push(union())
      }
      take(']')
      return { k: 'tuple', items }
    }
    if (token === '(') {
      const inner = union()
      take(')')
      return inner
    }
    if (token.startsWith('"')) return { k: 'lit', v: JSON.parse(token) as string }
    if (/^-?\d/.test(token)) return { k: 'lit', v: Number(token) }
    if (token === 'true' || token === 'false') return { k: 'lit', v: token === 'true' }
    if (token === 'string' || token === 'number' || token === 'boolean' || token === 'null') return { k: token }
    if (token === 'unknown' || token === 'never') return { k: token }
    if (token === 'Partial') {
      take('<')
      const inner = union()
      take('>')
      return inner
    }
    return { k: 'ref', name: token }
  }

  const defs: Defs = new Map()
  while (at < tokens.length) {
    take('export')
    take('type')
    const name = take()
    take('=')
    defs.set(name, union())
    take(';')
  }
  return defs
}

let cached: Defs | undefined
export function wireDefs(): Defs {
  cached ??= parseDefs(readFileSync(GENERATED, 'utf8'))
  return cached
}

export function resolve(defs: Defs, schema: Schema): Schema {
  while (schema.k === 'ref') {
    const next = defs.get(schema.name)
    if (!next) throw new Error(`generated.ts: unknown type ${schema.name}`)
    schema = next
  }
  return schema
}

export function objectFields(defs: Defs, schema: Schema): Field[] {
  const resolved = resolve(defs, schema)
  if (resolved.k === 'object') return resolved.fields
  if (resolved.k === 'inter') return resolved.of.flatMap((part) => objectFields(defs, part))
  throw new Error(`generated.ts: ${resolved.k} is not an object type`)
}

export class Rng {
  private s: number
  constructor(seed: number) {
    this.s = seed >>> 0
  }
  next(): number {
    this.s = (this.s + 0x6d2b79f5) >>> 0
    let t = this.s
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
  int(n: number): number {
    return Math.floor(this.next() * n)
  }
  chance(p: number): boolean {
    return this.next() < p
  }
  pick<T>(items: readonly T[]): T {
    return items[this.int(items.length)]
  }
}

const MAX_DEPTH = 8

const FLOAT_FIELDS = new Set([
  'assistantEcho',
  'autoSleepMinutes',
  'cols',
  'cost',
  'createdAt',
  'fetchedAt',
  'lastFetched',
  'ratio',
  'resetAt',
  'rows',
  'snoozeDefaultDays',
  'snoozedAt',
  'terminalFontSize',
  'text',
  'thinking',
  'toolResults',
  'toolUse',
  'userPrompt',
  'utilization',
  'value',
  'wakeAt',
  'wsTransportPort'
])

const SIGNED_FIELDS = new Set([
  'changedAt',
  'compactPostTokens',
  'compactPreTokens',
  'comparedAt',
  'exitCode',
  'generatedAt',
  'lastScannedAt',
  'lastSyncedAt',
  'loadedAt',
  'postTokens',
  'preTokens',
  'scannedAt',
  'setupExitCode',
  'syncedAt',
  'teardownExitCode',
  'timestamp',
  'ts',
  'updatedAt',
  'version'
])
const NEGATIVE_INTS = [-1, -2, -255]

const STRINGS = ['a', 'b', 'c', '/repo/a', '/repo/a/wt', '/repo/b', 'main', 'x y', '']
const KEYS = ['a', 'b', 'c', '/repo/a', '/repo/a/wt', '/repo/b', 'main']
const OWNER_STRINGS: Record<string, string[]> = {
  PaneLeaf: ['pane-a', 'pane-b', 'pane-c'],
  PaneSplit: ['split-a', 'split-b']
}
const INTS = [0, 1, 2, 3, 7, 42, 1000]
const BASE_TIME = 1_700_000_000_000

const CREATOR_WEIGHT = 6
const CREATORS = new Set([
  'browser/tabStateChanged',
  'costs/usageUpdated',
  'harnessConfig/fragmentsLoaded',
  'harnessConfig/resourcesLoaded',
  'harnessConfig/templatesLoaded',
  'jsonClaude/approvalRequested',
  'jsonClaude/entriesSeeded',
  'jsonClaude/entryAppended',
  'jsonClaude/sessionStarted',
  'repoConfigs/changed',
  'scratchpad/textChanged',
  'snooze/set',
  'terminals/panesForWorktreeChanged',
  'terminals/panesReplaced',
  'worktrees/listChanged',
  'worktrees/pendingAdded',
  'worktrees/pendingDeletionStarted'
])

const FOCUS_WEIGHT = 60

const WEIGHTS: Record<string, number> = {
  TerminalsEvent: 4,
  JsonClaudeEvent: 4,
  WorktreesEvent: 2,
  HarnessConfigEvent: 2,
  PRsEvent: 2
}

const ID_FIELD = /^(id|key|name|path)$|(Id|Path|Root|Key)$/

interface Seen {
  byField: Map<string, string[]>
  ids: string[]
}

function harvest(state: AppState): Seen {
  const byField = new Map<string, Set<string>>()
  const ids = new Set<string>()
  const add = (field: string, value: string): void => {
    if (value.length > 40 || /^\d+$/.test(value)) return
    if (!byField.has(field)) byField.set(field, new Set())
    byField.get(field)!.add(value)
    if (field === '' || ID_FIELD.test(field)) ids.add(value)
  }
  const walk = (value: unknown, field: string): void => {
    if (typeof value === 'string') add(field, value)
    else if (Array.isArray(value)) for (const item of value) walk(item, field)
    else if (value && typeof value === 'object') {
      for (const [key, item] of Object.entries(value)) {
        if (KEYS.includes(key) || /[^\w]/.test(key)) add('', key)
        walk(item, key)
      }
    }
  }
  for (const [slice, value] of Object.entries(state)) if (slice !== 'settings') walk(value, slice)
  const sorted = (values: Set<string>): string[] => [...values].sort()
  return { byField: new Map([...byField].map(([field, values]) => [field, sorted(values)])), ids: sorted(ids) }
}

function paneSplits(node: unknown, into: string[]): void {
  if (!node || typeof node !== 'object') return
  const pane = node as { type?: string; id?: string; children?: unknown[] }
  if (pane.type !== 'split') return
  if (typeof pane.id === 'string') into.push(pane.id)
  for (const child of pane.children ?? []) paneSplits(child, into)
}

class Generator {
  private readonly seen: Seen

  constructor(
    private readonly defs: Defs,
    private readonly rng: Rng,
    state: AppState
  ) {
    this.seen = harvest(state)
  }

  string(field: string, owner: string): string {
    const pool = OWNER_STRINGS[owner]
    if (pool) return this.rng.pick(pool)
    const same = this.seen.byField.get(field) ?? []
    const roll = this.rng.next()
    if (ID_FIELD.test(field)) {
      if (same.length > 0 && roll < 0.65) return this.rng.pick(same)
      if (this.seen.ids.length > 0 && roll < 0.85) return this.rng.pick(this.seen.ids)
    } else if (same.length > 0 && roll < 0.3) {
      return this.rng.pick(same)
    }
    return this.rng.pick(STRINGS)
  }

  key(): string {
    const ids = this.seen.ids.filter((value) => value !== '')
    if (ids.length > 0 && this.rng.chance(0.6)) return this.rng.pick(ids)
    return this.rng.pick(KEYS)
  }

  number(field: string): number {
    if (FLOAT_FIELDS.has(field)) {
      switch (this.rng.int(4)) {
        case 0:
          return this.rng.pick([0, 0.5, 1, 1.25, 12.75, 100])
        case 1:
          return this.rng.next()
        case 2:
          return this.rng.next() * 1000
        default:
          return BASE_TIME + this.rng.int(10_000_000) + this.rng.next()
      }
    }
    if (SIGNED_FIELDS.has(field) && this.rng.chance(0.2)) return this.rng.pick(NEGATIVE_INTS)
    if (this.rng.chance(0.2)) return BASE_TIME + this.rng.int(10_000_000)
    return this.rng.pick(INTS)
  }

  unknown(depth: number): unknown {
    const options: Array<() => unknown> = [
      () => this.string('', ''),
      () => this.rng.pick(INTS),
      () => this.rng.next(),
      () => this.rng.chance(0.5),
      () => null
    ]
    if (depth < 3) {
      options.push(
        () => Object.fromEntries([[this.key(), this.unknown(depth + 1)]]),
        () => [this.unknown(depth + 1), this.unknown(depth + 1)]
      )
    }
    return this.rng.pick(options)()
  }

  value(schema: Schema, field: string, owner: string, depth: number): unknown {
    switch (schema.k) {
      case 'string':
        return this.string(field, owner)
      case 'number':
        return this.number(field)
      case 'boolean':
        return this.rng.chance(0.5)
      case 'null':
        return null
      case 'unknown':
        return this.unknown(0)
      case 'never':
        throw new Error(`generator: cannot make a value of type never for ${owner}.${field}`)
      case 'lit':
        return schema.v
      case 'ref':
        return this.value(resolve(this.defs, schema), field, schema.name, depth + 1)
      case 'array': {
        const length = depth > MAX_DEPTH ? 0 : this.rng.int(4)
        return Array.from({ length }, () => this.value(schema.of, field, owner, depth + 1))
      }
      case 'tuple':
        return schema.items.map((item) => this.value(item, field, owner, depth + 1))
      case 'object':
      case 'inter':
        return this.object(schema, owner, depth)
      case 'map':
        return this.map(schema, field, owner, depth)
      case 'union': {
        const members = schema.of.filter((member) => member.k !== 'never')
        const member = depth > MAX_DEPTH ? members[0] : this.rng.pick(members)
        return this.value(member, field, owner, depth)
      }
    }
  }

  object(schema: Schema, owner: string, depth: number): Record<string, unknown> {
    const out: Record<string, unknown> = {}
    for (const field of objectFields(this.defs, schema)) {
      if (field.type.k === 'never') continue
      if (field.optional && (depth > MAX_DEPTH || this.rng.chance(0.5))) continue
      out[field.name] = this.value(field.type, field.name, owner, depth + 1)
    }
    return out
  }

  map(schema: Extract<Schema, { k: 'map' }>, field: string, owner: string, depth: number): Record<string, unknown> {
    const key = resolve(this.defs, schema.key)
    const out: Record<string, unknown> = {}
    if (key.k === 'string') {
      const size = depth > MAX_DEPTH ? 0 : this.rng.int(4)
      for (let i = 0; i < size; i++) out[this.key()] = this.value(schema.value, field, owner, depth + 1)
      return out
    }
    const literals = key.k === 'union' ? key.of : [key]
    for (const literal of literals) {
      if (literal.k !== 'lit') throw new Error(`generator: unsupported map key ${literal.k}`)
      if (depth <= MAX_DEPTH && this.rng.chance(0.5)) {
        out[String(literal.v)] = this.value(schema.value, field, owner, depth + 1)
      }
    }
    return out
  }

  variantType(variant: Schema): string {
    const type = objectFields(this.defs, variant).find((field) => field.name === 'type')?.type
    return type?.k === 'lit' ? String(type.v) : ''
  }

  event(state: AppState, focus: string | undefined): StateEvent {
    const slices = eventSlices(this.defs)
    const sliceWeight = (name: string): number => (name === focus ? FOCUS_WEIGHT : (WEIGHTS[name] ?? 1))
    const total = slices.reduce((sum, name) => sum + sliceWeight(name), 0)
    let roll = this.rng.next() * total
    const slice = slices.find((name) => (roll -= sliceWeight(name)) < 0) ?? slices[slices.length - 1]
    const variants = resolve(this.defs, { k: 'ref', name: slice })
    const options = variants.k === 'union' ? variants.of : [variants]
    const weight = (variant: Schema): number => (CREATORS.has(this.variantType(variant)) ? CREATOR_WEIGHT : 1)
    let pick = this.rng.next() * options.reduce((sum, variant) => sum + weight(variant), 0)
    const variant = options.find((option) => (pick -= weight(option)) < 0) ?? options[options.length - 1]
    const event = this.object(variant, slice, 0) as unknown as StateEvent
    fixup(event, state, this.rng)
    return event
  }
}

function leafTabs(node: unknown, into: string[]): void {
  if (!node || typeof node !== 'object') return
  const pane = node as { type?: string; tabs?: Array<{ id?: unknown }>; children?: unknown[] }
  if (pane.type === 'leaf') {
    for (const tab of pane.tabs ?? []) if (typeof tab.id === 'string') into.push(tab.id)
  }
  for (const child of pane.children ?? []) leafTabs(child, into)
}

function fixup(event: StateEvent, state: AppState, rng: Rng): void {
  const payload = (event.payload ?? {}) as unknown as Record<string, unknown>
  if (event.type === 'terminals/paneRatioChanged') {
    const candidates = Object.entries(state.terminals.panes).flatMap(([path, tree]) => {
      const splits: string[] = []
      paneSplits(tree, splits)
      return splits.map((id) => [path, id] as const)
    })
    if (candidates.length > 0 && rng.chance(0.7)) {
      const [worktreePath, splitId] = rng.pick(candidates)
      event.payload.worktreePath = worktreePath
      event.payload.splitId = splitId
    } else {
      event.payload.splitId = 'split-absent'
    }
    return
  }
  if (typeof payload.worktreePath === 'string' && typeof payload.tabId === 'string' && rng.chance(0.75)) {
    const trees = Object.keys(state.terminals.panes)
    if (trees.length > 0) {
      const worktreePath = rng.pick(trees)
      const tabs: string[] = []
      leafTabs(state.terminals.panes[worktreePath], tabs)
      payload.worktreePath = worktreePath
      if (tabs.length > 0) payload.tabId = rng.pick(tabs)
    }
  }
  if (event.type === 'jsonClaude/assistantTextDelta' || event.type === 'jsonClaude/assistantThinkingDelta') {
    const blockType = event.type === 'jsonClaude/assistantTextDelta' ? 'text' : 'thinking'
    const candidates = Object.values(state.jsonClaude.sessions).flatMap((session) =>
      session.entries
        .filter((entry) => entry.blocks?.some((block) => block.type === blockType))
        .map((entry) => [session.sessionId, entry.entryId] as const)
    )
    if (candidates.length > 0 && rng.chance(0.75)) {
      const [sessionId, entryId] = rng.pick(candidates)
      event.payload.sessionId = sessionId
      event.payload.entryId = entryId
      return
    }
  }
  if (event.type === 'harnessConfig/resourceDeleted') {
    const candidates = (['agents', 'skills', 'commands'] as const).flatMap((resourceType) =>
      state.harnessConfig.resources[resourceType].map((resource) => [resourceType, resource] as const)
    )
    if (candidates.length > 0 && rng.chance(0.75)) {
      const [resourceType, resource] = rng.pick(candidates)
      event.payload.resourceType = resourceType
      event.payload.agentKind = resource.agentKind
      event.payload.id = resource.id
    }
    return
  }
  const sessions = Object.keys(state.jsonClaude.sessions)
  if (typeof payload.sessionId === 'string' && sessions.length > 0 && rng.chance(0.75)) {
    const sessionId = rng.pick(sessions)
    const entries = state.jsonClaude.sessions[sessionId].entries
    payload.sessionId = sessionId
    for (const field of ['entryId', 'fromEntryId']) {
      if (typeof payload[field] === 'string' && entries.length > 0) {
        payload[field] = (rng.chance(0.5) ? entries[entries.length - 1] : rng.pick(entries)).entryId
      }
    }
  }
}

function eventSlices(defs: Defs): string[] {
  const root = resolve(defs, { k: 'ref', name: 'StateEvent' })
  if (root.k !== 'union') throw new Error('generated.ts: StateEvent is not a union')
  return root.of.map((slice) => {
    if (slice.k !== 'ref') throw new Error('generated.ts: StateEvent member is not a named slice event')
    return slice.name
  })
}

export function pickFocus(rng: Rng): string | undefined {
  return rng.chance(0.5) ? rng.pick(eventSlices(wireDefs())) : undefined
}

export function generateEvent(rng: Rng, state: AppState, focus?: string): StateEvent {
  return new Generator(wireDefs(), rng, state).event(state, focus)
}

export function nextNow(rng: Rng, previous: number | undefined): number {
  return previous === undefined ? BASE_TIME : previous + 1 + rng.int(5000)
}

export function stringMapPaths(defs: Defs = wireDefs()): Set<string> {
  const paths = new Set<string>()
  const walk = (schema: Schema, path: string, stack: string[]): void => {
    switch (schema.k) {
      case 'ref':
        if (stack.includes(schema.name)) return
        walk(resolve(defs, schema), path, [...stack, schema.name])
        return
      case 'array':
        walk(schema.of, `${path}[]`, stack)
        return
      case 'tuple':
        for (const item of schema.items) walk(item, `${path}[]`, stack)
        return
      case 'union':
        for (const member of schema.of) walk(member, path, stack)
        return
      case 'object':
      case 'inter':
        for (const field of objectFields(defs, schema)) walk(field.type, `${path}.${field.name}`, stack)
        return
      case 'map':
        if (resolve(defs, schema.key).k === 'string') paths.add(path)
        walk(schema.value, `${path}.*`, stack)
        return
      default:
        return
    }
  }
  walk({ k: 'ref', name: 'AppState' }, '$', [])
  return paths
}

export function eventTypes(defs: Defs = wireDefs()): string[] {
  const types: string[] = []
  const walk = (schema: Schema): void => {
    const resolved = resolve(defs, schema)
    if (resolved.k === 'union') return resolved.of.forEach(walk)
    const type = objectFields(defs, resolved).find((field) => field.name === 'type')?.type
    if (type?.k === 'lit') types.push(String(type.v))
  }
  walk({ k: 'ref', name: 'StateEvent' })
  return types.sort()
}
