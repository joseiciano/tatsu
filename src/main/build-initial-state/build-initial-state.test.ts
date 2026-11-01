import { describe, it, expect, vi } from 'vitest'

vi.mock('electron', () => ({
  app: {
    getPath: () => '/tmp',
    setPath: () => {},
    isPackaged: false
  }
}))

import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { buildInitialAppState } from '.'
import { loadRunRecordsSync } from '../workflow-run-records'
import type { WorkflowRunRecord } from '../../shared/state/workflows'
import type { Config } from '../persistence'
import { initialPRs } from '../../shared/state/prs'
import { initialOnboarding } from '../../shared/state/onboarding'
import { initialHooks } from '../../shared/state/hooks'
import { initialWorktrees } from '../../shared/state/worktrees'
import { initialTerminals } from '../../shared/state/terminals'
import { initialUpdater } from '../../shared/state/updater'
import { initialRepoConfigs } from '../../shared/state/repo-configs'
import { initialSettings } from '../../shared/state/settings'
import { initialScratchpad } from '../../shared/state/scratchpad'

// The bug we're guarding against: a slice's `initial<Slice>` constant gains
// a new field but the main-process Store seed in index.ts forgets to include
// it, so the renderer gets `undefined` on first snapshot and crashes.
//
// `buildInitialAppState` now spreads each `initial<Slice>` so TypeScript
// catches required-field drift at compile time, but optional fields would
// still slip through. These tests assert that every key present in the
// initial constant is also present in the seeded state — which catches
// optional-field drift at runtime.

const emptyConfig: Config = {
  windowBounds: null,
  repoRoots: []
}

describe('buildInitialAppState', () => {
  const seeded = buildInitialAppState(emptyConfig, { hasGithubToken: false })

  const slices = {
    prs: initialPRs,
    onboarding: initialOnboarding,
    hooks: initialHooks,
    worktrees: initialWorktrees,
    terminals: initialTerminals,
    updater: initialUpdater,
    repoConfigs: initialRepoConfigs,
    settings: initialSettings,
    scratchpad: initialScratchpad
  } as const

  for (const [name, initial] of Object.entries(slices)) {
    it(`seeds every key from initial${name[0].toUpperCase() + name.slice(1)}`, () => {
      const slice = seeded[name as keyof typeof slices] as unknown as Record<string, unknown>
      for (const key of Object.keys(initial)) {
        expect(slice, `${name}.${key} missing from seed`).toHaveProperty(key)
      }
    })
  }

  it('applies config overrides to settings', () => {
    const result = buildInitialAppState(
      {
        ...emptyConfig,
        themeMode: 'dark',
        themeDark: 'dracula',
        themeLight: 'solarized-light',
        repoRoots: ['/a', '/b']
      },
      { hasGithubToken: true }
    )
    expect(result.settings.themeMode).toBe('dark')
    expect(result.settings.themeDark).toBe('dracula')
    expect(result.settings.themeLight).toBe('solarized-light')
    expect(result.settings.hasGithubToken).toBe(true)
    expect(result.worktrees.repoRoots).toEqual(['/a', '/b'])
  })

  it('seeds labs and workflow settings defaults when config has none', () => {
    const result = buildInitialAppState(emptyConfig, { hasGithubToken: false })
    expect(result.settings.labs).toEqual({ workflows: false })
    expect(result.settings.workflows).toEqual({ maxConcurrentAgents: 4 })
  })

  it('seeds stored labs and workflow settings values', () => {
    const result = buildInitialAppState(
      { ...emptyConfig, labs: { workflows: true }, workflowSettings: { maxConcurrentAgents: 9 } },
      { hasGithubToken: false }
    )
    expect(result.settings.labs).toEqual({ workflows: true })
    expect(result.settings.workflows).toEqual({ maxConcurrentAgents: 9 })
  })

  it('clamps a stored out-of-range cap and defaults a non-finite one', () => {
    const high = buildInitialAppState(
      { ...emptyConfig, workflowSettings: { maxConcurrentAgents: 99 } },
      { hasGithubToken: false }
    )
    expect(high.settings.workflows.maxConcurrentAgents).toBe(16)
    const bad = buildInitialAppState(
      { ...emptyConfig, workflowSettings: { maxConcurrentAgents: Number.NaN } },
      { hasGithubToken: false }
    )
    expect(bad.settings.workflows.maxConcurrentAgents).toBe(4)
  })

  it('hydrates live runs and the 50 newest finished runs from records on disk', () => {
    const dir = mkdtempSync(join(tmpdir(), 'initial-runs-'))
    try {
      const record = (runId: string, patch: Partial<WorkflowRunRecord>): WorkflowRunRecord => ({
        version: 1,
        runId,
        defId: 'personal:flow',
        defHash: 'hash',
        definition: { name: 'flow', inputs: {}, steps: [] },
        inputs: {},
        worktreePath: `/wt/${runId}`,
        contextPath: `/wt/${runId}/.harness/runs/${runId}/context.md`,
        status: 'done',
        cursor: 0,
        steps: { plan: 'done' },
        startedAt: 1,
        attempts: [],
        ...patch
      })
      for (let i = 0; i < 60; i++) {
        const runId = `done-${String(i).padStart(2, '0')}`
        writeFileSync(join(dir, `${runId}.json`), JSON.stringify(record(runId, { finishedAt: 100 + i })))
      }
      writeFileSync(
        join(dir, 'paused-1.json'),
        JSON.stringify(record('paused-1', { status: 'paused', pausedReason: 'step-failed', steps: { plan: 'failed' } }))
      )
      writeFileSync(join(dir, 'broken.json'), '{')
      const logs: string[] = []

      const records = loadRunRecordsSync(dir, (_c, message, data) => logs.push(`${message} ${data?.file}`))
      const state = buildInitialAppState(emptyConfig, { hasGithubToken: false, workflowRuns: records })

      const runIds = Object.keys(state.workflows.runs)
      expect(runIds).toHaveLength(51)
      expect(state.workflows.runs['paused-1']).toMatchObject({ status: 'paused', pausedReason: 'step-failed' })
      expect(runIds.filter((id) => id.startsWith('done-')).sort()[0]).toBe('done-10')
      expect(logs).toEqual(['run record skipped unreadable broken.json'])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('seeds an empty workflows slice when no run records are passed', () => {
    const state = buildInitialAppState(emptyConfig, { hasGithubToken: false })
    expect(state.workflows.runs).toEqual({})
    expect(state.workflows.attempts).toEqual({})
  })
})
