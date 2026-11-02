import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { vi } from 'vitest'
import {
  initialState,
  mergeWireSnapshot,
  rootReducer,
  stripSnapshotForWire,
  type AppState,
  type StateEvent,
  type WireSnapshotState
} from '../../src/shared/state'

export const FIXTURES_DIR = fileURLToPath(new URL('../../fixtures/wire/', import.meta.url))

export type SliceKey = keyof AppState

export interface FixtureCase {
  name: string
  now: number
  before?: unknown
  event: StateEvent
  after?: unknown
}

export interface SliceFile {
  key: SliceKey
  path: string
}

const SLICE_KEYS = new Set(Object.keys(initialState))

export function sliceFiles(): SliceFile[] {
  return readdirSync(FIXTURES_DIR)
    .filter((file) => file.endsWith('.json') && SLICE_KEYS.has(file.slice(0, -'.json'.length)))
    .sort()
    .map((file) => ({ key: file.slice(0, -'.json'.length) as SliceKey, path: join(FIXTURES_DIR, file) }))
}

export function loadCases(path: string): FixtureCase[] {
  return JSON.parse(readFileSync(path, 'utf8')) as FixtureCase[]
}

export function caseInput({ now, before, event }: FixtureCase): string {
  return JSON.stringify({ now, before, event }, null, 2)
}

export function reduceCase(key: SliceKey, fixture: FixtureCase): unknown {
  vi.useFakeTimers()
  vi.setSystemTime(fixture.now)
  try {
    const before = 'before' in fixture ? fixture.before : initialState[key]
    const state = { ...initialState, [key]: before } as AppState
    const next = rootReducer(state, fixture.event)
    return JSON.parse(JSON.stringify(next[key]))
  } finally {
    vi.useRealTimers()
  }
}

export const ROOT_FIXTURES = join(FIXTURES_DIR, 'root.json')

export type RootCase =
  | { name: string; kind: 'strip'; before: { state: WireSnapshotState; seq: number }; after?: unknown }
  | { name: string; kind: 'deserialize'; before: Record<string, unknown>; after?: unknown }

export function loadRootCases(): RootCase[] {
  return JSON.parse(readFileSync(ROOT_FIXTURES, 'utf8')) as RootCase[]
}

type Slices = Record<string, Record<string, unknown>>

function knownFields(state: AppState): Slices {
  const slices = state as unknown as Slices
  return Object.fromEntries(
    Object.entries(initialState).map(([key, initial]) => [
      key,
      Object.fromEntries(Object.keys(initial).map((field) => [field, slices[key][field]]))
    ])
  )
}

export function rootCaseAfter(fixture: RootCase): unknown {
  const after =
    fixture.kind === 'strip'
      ? stripSnapshotForWire({ seq: fixture.before.seq, state: mergeWireSnapshot(fixture.before.state) })
      : knownFields(mergeWireSnapshot(fixture.before as WireSnapshotState))
  return JSON.parse(JSON.stringify(after))
}
