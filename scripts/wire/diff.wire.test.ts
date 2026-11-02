import { spawnSync, type SpawnSyncReturns } from 'node:child_process'
import { createHash } from 'node:crypto'
import { closeSync, mkdtempSync, openSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { initialState, rootReducer, type AppState, type StateEvent } from '../../src/shared/state'
import { Rng, eventTypes, generateEvent, nextNow, pickFocus, stringMapPaths } from './generators'

const ROOT = fileURLToPath(new URL('../../', import.meta.url))
const HARNESS = join(process.env.CARGO_TARGET_DIR ?? join(ROOT, 'target'), 'debug', 'reduce')
const MAX_EVENTS = 80
const REQUEST_DIR = mkdtempSync(join(tmpdir(), 'wire-diff-'))
const REQUEST = join(REQUEST_DIR, 'request.json')
const HARNESS_TIMEOUT_MS = 60_000

interface Step {
  now: number
  event: StateEvent
}

interface Run {
  start: AppState
  steps: Step[]
  final: unknown
}

function envInt(name: string, fallback: number): number {
  const raw = process.env[name]
  if (raw === undefined || raw === '') return fallback
  const value = Number(raw)
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${name} must be a non-negative integer, got ${raw}`)
  return value
}

function runSeed(seed: number, run: number): number {
  return (seed + run) >>> 0
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

function generateRun(seed: number, events?: number): Run {
  const rng = new Rng(seed)
  const start = clone(initialState)
  const count = events ?? 1 + rng.int(MAX_EVENTS)
  const focus = pickFocus(rng)
  const steps: Step[] = []
  let state = start
  let now: number | undefined
  vi.useFakeTimers()
  try {
    for (let i = 0; i < count; i++) {
      now = nextNow(rng, now)
      const event = generateEvent(rng, state, focus)
      vi.setSystemTime(now)
      state = rootReducer(state, event)
      steps.push({ now, event })
    }
  } finally {
    vi.useRealTimers()
  }
  return { start, steps, final: clone(state) }
}

function rustFinal(run: Run): unknown {
  writeFileSync(REQUEST, JSON.stringify({ state: run.start, steps: run.steps }))
  const stdin = openSync(REQUEST, 'r')
  let result: SpawnSyncReturns<string>
  try {
    result = spawnSync(HARNESS, [], {
      stdio: [stdin, 'pipe', 'pipe'],
      encoding: 'utf8',
      maxBuffer: 256 * 1024 * 1024,
      timeout: HARNESS_TIMEOUT_MS
    })
  } finally {
    closeSync(stdin)
  }
  if (result.error) throw result.error
  if (result.signal) throw new Error(`harness killed by ${result.signal} (timeout ${HARNESS_TIMEOUT_MS} ms)`)
  if (result.status !== 0) throw new Error(`harness exited ${result.status}: ${result.stderr}`)
  return JSON.parse(result.stdout)
}

interface Difference {
  path: string
  ts: unknown
  rust: unknown
}

const MAP_PATHS = stringMapPaths()

function firstDifference(ts: unknown, rust: unknown, path = '$', pattern = '$'): Difference | null {
  if (Array.isArray(ts) && Array.isArray(rust)) {
    if (ts.length !== rust.length) return { path: `${path}.length`, ts: ts.length, rust: rust.length }
    for (let i = 0; i < ts.length; i++) {
      const found = firstDifference(ts[i], rust[i], `${path}[${i}]`, `${pattern}[]`)
      if (found) return found
    }
    return null
  }
  if (ts && rust && typeof ts === 'object' && typeof rust === 'object' && !Array.isArray(ts) && !Array.isArray(rust)) {
    const a = ts as Record<string, unknown>
    const b = rust as Record<string, unknown>
    const isMap = MAP_PATHS.has(pattern)
    for (const key of new Set([...Object.keys(a), ...Object.keys(b)])) {
      if (!(key in a) || !(key in b)) return { path: `${path}.${key}`, ts: a[key], rust: b[key] }
      const found = firstDifference(a[key], b[key], `${path}.${key}`, isMap ? `${pattern}.*` : `${pattern}.${key}`)
      if (found) return found
    }
    if (isMap && Object.keys(a).join('\0') !== Object.keys(b).join('\0')) {
      return { path: `${path} (key order)`, ts: Object.keys(a), rust: Object.keys(b) }
    }
    return null
  }
  return Object.is(ts, rust) ? null : { path, ts, rust }
}

function show(value: unknown): string {
  const text = value === undefined ? 'undefined' : JSON.stringify(value)
  return text.length > 400 ? `${text.slice(0, 400)}…` : text
}

const seed = envInt('WIRE_DIFF_SEED', 1)
const runs = envInt('WIRE_DIFF_RUNS', 20)

describe('generator', () => {
  it('parses every StateEvent variant and fills a payload for each', () => {
    const seen = new Set<string>()
    for (let run = 0; run < 400; run++) {
      for (const { event } of generateRun(runSeed(7, run), 40).steps) seen.add(event.type)
    }
    expect([...seen].sort()).toStrictEqual(eventTypes())
  })

  it('makes the same sequence from the same seed', () => {
    expect(generateRun(42).steps).toStrictEqual(generateRun(42).steps)
    expect(generateRun(42).steps).not.toStrictEqual(generateRun(43).steps)
  })
})

describe('differential: TS rootReducer vs Rust root_reduce', () => {
  beforeAll(() => {
    const build = spawnSync('cargo', ['build', '-q', '-p', 'tatsu-state-harness', '--bin', 'reduce'], {
      cwd: ROOT,
      encoding: 'utf8',
      timeout: 570_000
    })
    if (build.error) throw new Error(`cargo build failed (is cargo on PATH?): ${build.error.message}`)
    if (build.signal) throw new Error(`cargo build killed by ${build.signal}`)
    if (build.status !== 0) throw new Error(`cargo build failed:\n${build.stderr}`)
  }, 600_000)

  afterAll(() => rmSync(REQUEST_DIR, { recursive: true, force: true }))

  it('keeps the initial state unchanged through Rust', () => {
    const run = generateRun(seed, 0)
    expect(firstDifference(run.final, rustFinal(run))).toBeNull()
  })

  it(`agrees on ${runs} random sequences from seed ${seed}`, () => {
    const digest = createHash('sha256')
    let events = 0
    for (let run = 0; run < runs; run++) {
      const sequence = generateRun(runSeed(seed, run))
      const steps = JSON.stringify(sequence.steps)
      digest.update(steps)
      events += sequence.steps.length
      let difference: Difference | null
      try {
        difference = firstDifference(sequence.final, rustFinal(sequence))
      } catch (err) {
        throw new Error(
          `wire-diff: seed ${seed} run ${run}: harness failed (replay: pnpm test:wire-diff -- --seed ${runSeed(seed, run)} --runs 1)\n${(err as Error).message}`
        )
      }
      if (difference) {
        throw new Error(
          [
            `wire-diff: seed ${seed} run ${run} differs after ${sequence.steps.length} events`,
            `replay: pnpm test:wire-diff -- --seed ${runSeed(seed, run)} --runs 1`,
            `path: ${difference.path}`,
            `ts:   ${show(difference.ts)}`,
            `rust: ${show(difference.rust)}`,
            `steps sha256: ${createHash('sha256').update(steps).digest('hex').slice(0, 16)}`
          ].join('\n')
        )
      }
    }
    console.log(`wire-diff: seed ${seed}, ${runs} runs, ${events} events, steps sha256 ${digest.digest('hex').slice(0, 16)}`)
  }, 600_000)
})
