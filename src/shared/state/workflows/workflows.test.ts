import { describe, it, expect } from 'vitest'
import {
  initialWorkflows,
  workflowsReducer,
  type WorkflowDefinitionSummary,
  type WorkflowScope,
  type WorkflowsState
} from './index'

function summary(
  slug: string,
  overrides: Partial<WorkflowDefinitionSummary> = {}
): WorkflowDefinitionSummary {
  return {
    id: `personal:${slug}`,
    name: slug,
    scope: 'personal',
    path: `/home/u/.tatsu/workflows/${slug}.yaml`,
    hash: `hash-${slug}`,
    stepIds: ['plan', 'build'],
    issues: [],
    ...overrides
  }
}

function load(
  state: WorkflowsState,
  definitions: WorkflowDefinitionSummary[],
  scope: WorkflowScope = 'personal'
): WorkflowsState {
  return workflowsReducer(state, {
    type: 'workflows/definitionsLoaded',
    payload: { scope, definitions }
  })
}

const REPO_SCOPE = 'repo' as WorkflowScope

function repoSummary(slug: string): WorkflowDefinitionSummary {
  return summary(slug, { id: `repo:${slug}`, scope: REPO_SCOPE })
}

describe('workflowsReducer', () => {
  it('definitionsLoaded replaces the personal entries keyed by id', () => {
    const start: WorkflowsState = { definitions: { 'personal:old': summary('old') } }
    const broken = summary('broken', {
      stepIds: [],
      issues: ['steps[0].needs references unknown step "nope"']
    })
    const next = load(start, [summary('a'), broken])
    expect(next.definitions).toEqual({
      'personal:a': summary('a'),
      'personal:broken': broken
    })
  })

  it('definitionsLoaded removes personal entries absent from the payload', () => {
    const start = load(initialWorkflows, [summary('a'), summary('b')])
    const next = load(start, [summary('a')])
    expect(Object.keys(next.definitions)).toEqual(['personal:a'])
  })

  it('definitionsLoaded keeps the reference of each unchanged entry', () => {
    const start = load(initialWorkflows, [summary('a'), summary('b')])
    const next = load(start, [summary('a'), summary('b', { hash: 'hash-b2' })])
    expect(next).not.toBe(start)
    expect(next.definitions['personal:a']).toBe(start.definitions['personal:a'])
    expect(next.definitions['personal:b']).not.toBe(start.definitions['personal:b'])
    expect(next.definitions['personal:b'].hash).toBe('hash-b2')
  })

  it('definitionsLoaded treats a changed array element as a change', () => {
    const start = load(initialWorkflows, [summary('a', { issues: ['first issue'] })])
    const next = load(start, [summary('a', { issues: ['second issue'] })])
    expect(next).not.toBe(start)
    expect(next.definitions['personal:a'].issues).toEqual(['second issue'])
  })

  it('definitionsLoaded returns the same state when content is unchanged', () => {
    const start = load(initialWorkflows, [summary('a'), summary('b')])
    const next = load(start, [summary('b'), summary('a')])
    expect(next).toBe(start)
  })

  it('definitionsLoaded with no definitions on empty state returns the same state', () => {
    expect(load(initialWorkflows, [])).toBe(initialWorkflows)
  })

  it('definitionsLoaded leaves entries of other scopes untouched', () => {
    const repo = repoSummary('shared')
    const start: WorkflowsState = {
      definitions: { 'repo:shared': repo, 'personal:a': summary('a') }
    }
    const next = load(start, [summary('b')])
    expect(next.definitions['repo:shared']).toBe(repo)
    expect(Object.keys(next.definitions).sort()).toEqual(['personal:b', 'repo:shared'])
  })
})
