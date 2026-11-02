import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { vi } from 'vitest'
import { initialState, rootReducer, type AppState, type StateEvent } from '../../src/shared/state'

export const FIXTURES_DIR = fileURLToPath(new URL('../../fixtures/wire/', import.meta.url))

export type SliceKey = keyof AppState

export interface FixtureCase {
  name: string
  now: number
  before: unknown
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
    const state = { ...initialState, [key]: fixture.before } as AppState
    const next = rootReducer(state, fixture.event)
    return JSON.parse(JSON.stringify(next[key]))
  } finally {
    vi.useRealTimers()
  }
}
