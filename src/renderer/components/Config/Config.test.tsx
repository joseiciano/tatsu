// @vitest-environment jsdom
//
// TASK-017/TEST-008: renderer-level orchestration coverage for the Step
// 10 conversion invariants that `config-conversion.test.ts` (pure outcome
// helper) and `ConfigResourceList.test.ts` (pure per-row action
// derivation) don't reach — both of those are pure-function tests with
// no React tree, so neither exercises `Config.tsx`'s actual dispatch
// gating, its in-flight overlay, or the "never auto-converts" property
// (REQ-012, REQ-014, CON-004). This file mounts the real `Config`
// component (via `react-dom/client` + `act`, in a per-file jsdom
// environment) with a mocked backend/store so every assertion observes
// genuine DOM state driven by genuine React state updates, not a
// hand-rolled projection of them.
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Config } from './Config'
import type {
  HarnessConfigApplyResult,
  HarnessConfigComparison,
  HarnessConfigConversionResult,
  HarnessConfigFileRef,
  HarnessConfigRequestResult,
  HarnessConfigScanResult,
  HarnessConfigScope,
  HarnessConfigState,
  HarnessConfigSyncPlan,
  ManagedHarnessKind
} from '../../../shared/state/harness-config'
import type { BackendConnection } from '../../types'

// Monaco can't construct in jsdom (workers, canvas text measurement,
// ResizeObserver) and is irrelevant to every assertion here — swapped
// for a no-op so `ConfigEditor`'s surrounding create/edit chrome (name
// input, submit label, generated-from note) still renders normally.
vi.mock('../MonacoEditor', () => ({ MonacoEditor: () => null }))

const { backendApi, storeState } = vi.hoisted(() => {
  const backendApi = {
    scanHarnessConfig: vi.fn(),
    readHarnessConfigFile: vi.fn(),
    compareHarnessConfig: vi.fn(),
    prepareHarnessConfigCreate: vi.fn(),
    prepareHarnessConfigUpdate: vi.fn(),
    prepareHarnessConfigDelete: vi.fn(),
    planHarnessConfigSyncToDisk: vi.fn(),
    planHarnessConfigAdoptFromDisk: vi.fn(),
    createHarnessConfigFile: vi.fn(),
    updateHarnessConfigFile: vi.fn(),
    deleteHarnessConfigFile: vi.fn(),
    syncHarnessConfigToDisk: vi.fn(),
    adoptHarnessConfigFromDisk: vi.fn(),
    prepareHarnessConfigCommandFromSkill: vi.fn(),
    prepareHarnessConfigSkillFromCommand: vi.fn()
  }
  const storeState: {
    harnessConfig: HarnessConfigState | null
    activeBackend: BackendConnection | null
    settings: { terminalFontFamily?: string; terminalFontSize?: number } | null
  } = { harnessConfig: null, activeBackend: null, settings: null }
  return { backendApi, storeState }
})

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

vi.mock('../../backend', () => ({ useBackend: () => backendApi }))
vi.mock('../../store', () => ({
  useHarnessConfig: () => storeState.harnessConfig,
  useActiveBackend: () => storeState.activeBackend,
  useSettings: () => storeState.settings
}))

function ref(overrides: Partial<HarnessConfigFileRef> = {}): HarnessConfigFileRef {
  return {
    id: 'ref-id',
    agentKind: 'claude',
    resourceType: 'skills',
    canonicalResourceType: 'skills',
    aliasResourceTypes: [],
    label: 'Resource',
    relativePath: 'skills/resource.md',
    absolutePath: '/workspace/.claude/skills/resource.md',
    hash: 'hash-value',
    existsOnDisk: true,
    managed: true,
    updatedAt: 1_700_000_000_000,
    ...overrides
  }
}

function emptyComparison(scope: HarnessConfigScope): HarnessConfigComparison {
  return { scope, status: 'synced', diskOnly: [], configOnly: [], changed: [], comparedAt: 1 }
}

const MANAGED_KINDS: readonly ManagedHarnessKind[] = ['claude', 'codex', 'opencode']
const RESOURCE_TYPES = ['agents', 'skills', 'commands'] as const

function setStore(
  resources: Partial<Record<(typeof RESOURCE_TYPES)[number], HarnessConfigFileRef[]>> = {}
): void {
  const comparisons: HarnessConfigState['comparisons'] = {}
  for (const agentKind of MANAGED_KINDS) {
    for (const resourceType of RESOURCE_TYPES) {
      comparisons[`${agentKind}:${resourceType}`] = emptyComparison({ agentKind, resourceType })
    }
  }
  storeState.harnessConfig = {
    resources: { agents: [], skills: [], commands: [], ...resources },
    comparisons,
    loading: false,
    error: null,
    lastScannedAt: null,
    lastSyncedAt: null
  }
  storeState.activeBackend = { id: 'local', label: 'Local', url: '', kind: 'local', addedAt: 0 }
  storeState.settings = {}
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((res) => {
    resolve = res
  })
  return { promise, resolve }
}

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  vi.clearAllMocks()
  backendApi.scanHarnessConfig.mockResolvedValue({
    ok: true,
    value: { resources: [], scannedAt: 1 }
  } satisfies HarnessConfigRequestResult<HarnessConfigScanResult>)
  backendApi.compareHarnessConfig.mockImplementation(
    async (request: { scope: HarnessConfigScope }) => ({
      ok: true,
      value: emptyComparison(request.scope)
    })
  )
  setStore()
  container = document.createElement('div')
  document.body.appendChild(container)
})

afterEach(() => {
  act(() => {
    root.unmount()
  })
  container.remove()
})

async function renderConfig(): Promise<void> {
  await act(async () => {
    root = createRoot(container)
    root.render(<Config onClose={() => {}} />)
  })
}

async function rerenderConfig(): Promise<void> {
  await act(async () => {
    root.render(<Config onClose={() => {}} />)
  })
}

/** Lets every pending promise (mocked backend calls plus their chained
 *  `.then`/`await` continuations) settle before the next assertion — a
 *  macrotask always runs after the full microtask queue drains, however
 *  many `await`s deep the continuation chain is. */
async function flush(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0))
  })
}

function click(el: Element | null): void {
  if (!el) throw new Error('element not found')
  act(() => {
    ;(el as HTMLElement).click()
  })
}

function clickTab(label: string): void {
  const tab = Array.from(container.querySelectorAll<HTMLButtonElement>('[role="tab"]')).find(
    (b) => b.textContent === label
  )
  if (!tab) throw new Error(`tab not found: ${label}`)
  click(tab)
}

function findConversionButton(rowLabel: string, actionLabel: string): HTMLButtonElement {
  const btn = container.querySelector<HTMLButtonElement>(
    `[aria-label="${actionLabel} from ${rowLabel}"]`
  )
  if (!btn) throw new Error(`conversion button not found for "${rowLabel}" (${actionLabel})`)
  return btn
}

function findButtonByText(text: string): HTMLButtonElement {
  const btn = Array.from(container.querySelectorAll('button')).find((b) => b.textContent === text)
  if (!btn) throw new Error(`button not found: ${text}`)
  return btn as HTMLButtonElement
}

describe('Config conversion orchestration (TASK-017/TEST-008)', () => {
  it('dispatches the matching prepare channel with exactly {scope, id}, only from the row\'s own enabled action', async () => {
    const claudeSkill = ref({
      id: 'claude-skill-1',
      agentKind: 'claude',
      resourceType: 'skills',
      label: 'Claude Skill One',
      relativePath: 'skills/claude-skill-1.md'
    })
    setStore({ skills: [claudeSkill] })
    backendApi.prepareHarnessConfigCommandFromSkill.mockResolvedValue({
      ok: true,
      value: {
        status: 'draft',
        agentKind: 'claude',
        resourceType: 'commands',
        name: 'claude-skill-1',
        relativePath: 'commands/claude-skill-1.md',
        label: 'Claude Skill One',
        content: 'draft body\n\n<!-- Converted by Tatsu from claude skills skills/claude-skill-1.md -->'
      }
    } satisfies HarnessConfigRequestResult<HarnessConfigConversionResult>)

    await renderConfig()
    await flush()
    expect(backendApi.prepareHarnessConfigCommandFromSkill).not.toHaveBeenCalled()

    clickTab('Skills')
    await flush()
    expect(backendApi.prepareHarnessConfigCommandFromSkill).not.toHaveBeenCalled()
    expect(backendApi.prepareHarnessConfigSkillFromCommand).not.toHaveBeenCalled()

    const button = findConversionButton('Claude Skill One', 'Create command')
    expect(button.disabled).toBe(false)
    click(button)
    await flush()

    expect(backendApi.prepareHarnessConfigCommandFromSkill).toHaveBeenCalledTimes(1)
    expect(backendApi.prepareHarnessConfigCommandFromSkill).toHaveBeenCalledWith({
      scope: { agentKind: 'claude', resourceType: 'skills' },
      id: 'claude-skill-1'
    })
    expect(backendApi.prepareHarnessConfigSkillFromCommand).not.toHaveBeenCalled()

    // A `draft` result enters create mode pre-filled — it never applies
    // itself (no create-plan/apply channel touched by the conversion
    // response alone).
    expect(backendApi.prepareHarnessConfigCreate).not.toHaveBeenCalled()
    expect(backendApi.createHarnessConfigFile).not.toHaveBeenCalled()
    const nameInput = container.querySelector<HTMLInputElement>('#config-create-name')
    expect(nameInput?.value).toBe('claude-skill-1')
    expect(container.textContent).toContain(
      'Generated from claude skills skills/claude-skill-1.md'
    )
    expect(findButtonByText('Create command')).toBeTruthy()
  })

  it('overlays an in-flight guard on the row action while its request is outstanding, and clears it once settled', async () => {
    const claudeSkill = ref({
      id: 'claude-skill-1',
      agentKind: 'claude',
      resourceType: 'skills',
      label: 'Claude Skill One'
    })
    setStore({ skills: [claudeSkill] })
    const { promise, resolve } = deferred<HarnessConfigRequestResult<HarnessConfigConversionResult>>()
    backendApi.prepareHarnessConfigCommandFromSkill.mockReturnValue(promise)

    await renderConfig()
    await flush()
    clickTab('Skills')
    await flush()

    click(findConversionButton('Claude Skill One', 'Create command'))
    await flush()
    expect(backendApi.prepareHarnessConfigCommandFromSkill).toHaveBeenCalledTimes(1)

    const busyButton = findConversionButton('Claude Skill One', 'Create command')
    expect(busyButton.disabled).toBe(true)
    expect(busyButton.title).toBe('A conversion request is already in progress.')

    // A disabled button can't dispatch a second click at all (native
    // disabled-control semantics) — the ref-backed guard in `Config.tsx`
    // is defense in depth behind this.
    click(busyButton)
    await flush()
    expect(backendApi.prepareHarnessConfigCommandFromSkill).toHaveBeenCalledTimes(1)

    resolve({
      ok: true,
      value: {
        status: 'draft',
        agentKind: 'claude',
        resourceType: 'commands',
        name: 'claude-skill-1',
        relativePath: 'commands/claude-skill-1.md',
        label: 'Claude Skill One',
        content: 'draft body'
      }
    })
    await flush()

    // The row moved out of the pending set once the request settled —
    // re-querying proves the overlay is gone (the row itself is
    // unaffected by entering create mode elsewhere on the page).
    const idleButton = findConversionButton('Claude Skill One', 'Create command')
    expect(idleButton.disabled).toBe(false)
    expect(idleButton.title).toBe('Create command')
  })

  it('never dispatches from a disabled row action (unsupported destination capability)', async () => {
    const codexSkill = ref({
      id: 'codex-skill-1',
      agentKind: 'codex',
      resourceType: 'skills',
      label: 'Codex Skill One'
    })
    setStore({ skills: [codexSkill] })

    await renderConfig()
    await flush()
    clickTab('Skills')
    await flush()

    // Codex has no verified commands contract (agent-registry), so its
    // skill rows' conversion action renders disabled.
    const button = findConversionButton('Codex Skill One', 'Create command')
    expect(button.disabled).toBe(true)
    click(button)
    await flush()

    expect(backendApi.prepareHarnessConfigCommandFromSkill).not.toHaveBeenCalled()
    expect(backendApi.prepareHarnessConfigSkillFromCommand).not.toHaveBeenCalled()
  })

  it('retains an alias/existing result as an inline notice without entering create mode or mutating anything', async () => {
    const claudeSkill = ref({
      id: 'claude-skill-1',
      agentKind: 'claude',
      resourceType: 'skills',
      label: 'Claude Skill One'
    })
    setStore({ skills: [claudeSkill] })
    const aliasRef = ref({
      id: 'claude-skill-1',
      agentKind: 'claude',
      resourceType: 'commands',
      relativePath: 'commands/claude-skill-1.md',
      label: 'Claude Skill One'
    })
    backendApi.prepareHarnessConfigCommandFromSkill.mockResolvedValue({
      ok: true,
      value: { status: 'alias', ref: aliasRef }
    } satisfies HarnessConfigRequestResult<HarnessConfigConversionResult>)

    await renderConfig()
    await flush()
    clickTab('Skills')
    await flush()

    click(findConversionButton('Claude Skill One', 'Create command'))
    await flush()

    expect(backendApi.prepareHarnessConfigCommandFromSkill).toHaveBeenCalledTimes(1)
    // No create form — the ref is "retained" as a notice, not as a draft
    // to review/edit.
    expect(container.querySelector('#config-create-name')).toBeNull()
    expect(container.textContent).toContain(
      'Already available as a command at commands/claude-skill-1.md'
    )
    // Zero mutation: nothing beyond the single prepare call fires.
    expect(backendApi.prepareHarnessConfigCreate).not.toHaveBeenCalled()
    expect(backendApi.createHarnessConfigFile).not.toHaveBeenCalled()
    expect(backendApi.prepareHarnessConfigUpdate).not.toHaveBeenCalled()
    expect(backendApi.updateHarnessConfigFile).not.toHaveBeenCalled()
    expect(backendApi.prepareHarnessConfigDelete).not.toHaveBeenCalled()
    expect(backendApi.deleteHarnessConfigFile).not.toHaveBeenCalled()
  })

  it('never dispatches a conversion from mount, tab/filter/search changes, an inventory refresh, or a sync/adopt flow', async () => {
    const claudeSkill = ref({
      id: 'claude-skill-1',
      agentKind: 'claude',
      resourceType: 'skills',
      label: 'Claude Skill One'
    })
    setStore({ skills: [claudeSkill] })

    await renderConfig()
    await flush()

    // Tab churn — the resource-type rail a disk-inventory refresh would
    // also re-render through.
    clickTab('Skills')
    await flush()
    clickTab('Commands')
    await flush()
    clickTab('Agents')
    await flush()
    clickTab('Skills')
    await flush()

    // Agent filter change.
    const agentFilter = container.querySelector<HTMLSelectElement>('#config-agent-filter')
    if (!agentFilter) throw new Error('agent filter select not found')
    act(() => {
      agentFilter.value = 'claude'
      agentFilter.dispatchEvent(new Event('change', { bubbles: true }))
    })
    await flush()

    // Search.
    const search = container.querySelector<HTMLInputElement>('[aria-label="Search resources"]')
    if (!search) throw new Error('search input not found')
    act(() => {
      search.value = 'claude'
      search.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await flush()
    act(() => {
      search.value = ''
      search.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await flush()

    // A Tatsu-config/disk-inventory/plugin-metadata refresh: the store
    // slice changes under the mounted component without any user action.
    setStore({
      skills: [
        claudeSkill,
        ref({ id: 'claude-skill-2', agentKind: 'claude', resourceType: 'skills', label: 'Claude Skill Two' })
      ]
    })
    await rerenderConfig()
    await flush()

    // A full scoped sync-conflict review -> adopt-from-disk outcome.
    const conflictScope: HarnessConfigScope = { agentKind: 'claude', resourceType: 'skills' }
    const driftRef = ref({
      id: 'drift-1',
      agentKind: 'claude',
      resourceType: 'skills',
      relativePath: 'skills/drift.md'
    })
    const conflict: HarnessConfigComparison = {
      scope: conflictScope,
      status: 'conflict',
      diskOnly: [driftRef],
      configOnly: [],
      changed: [],
      comparedAt: 1
    }
    backendApi.compareHarnessConfig.mockImplementationOnce(async () => ({ ok: true, value: conflict }))

    click(container.querySelector<HTMLButtonElement>('[aria-label="Sync Claude Code"]'))
    await flush()
    expect(container.querySelector('[role="dialog"]')).toBeTruthy()

    backendApi.planHarnessConfigAdoptFromDisk.mockResolvedValueOnce({
      ok: true,
      value: {
        planId: 'plan-1',
        scope: conflictScope,
        direction: 'adopt-from-disk',
        status: 'conflict',
        diskOnly: [driftRef],
        configOnly: [],
        changed: [],
        generatedAt: 1,
        fingerprint: 'fp-1'
      }
    } satisfies HarnessConfigRequestResult<HarnessConfigSyncPlan>)
    backendApi.adoptHarnessConfigFromDisk.mockResolvedValueOnce({
      ok: true,
      value: {
        scope: conflictScope,
        planId: 'plan-1',
        applied: [],
        resultingRefs: [],
        requiresRescan: true
      }
    } satisfies HarnessConfigRequestResult<HarnessConfigApplyResult>)

    click(findButtonByText('Adopt current disk files into Tatsu config'))
    await flush()
    await flush()

    expect(backendApi.adoptHarnessConfigFromDisk).toHaveBeenCalledTimes(1)
    expect(container.querySelector('[role="dialog"]')).toBeNull()

    expect(backendApi.prepareHarnessConfigCommandFromSkill).not.toHaveBeenCalled()
    expect(backendApi.prepareHarnessConfigSkillFromCommand).not.toHaveBeenCalled()
  })
})
