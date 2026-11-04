import { describe, expect, it, vi } from 'vitest'
import { Store } from '../store'
import { initialState, type AppState } from '../../shared/state'
import type { WorkflowRun } from '../../shared/state/workflows'
import { createWorkflowNotifier, type WorkflowNotification } from '.'

const RUN_ID = 'run-1'

function run(overrides: Partial<WorkflowRun> = {}): WorkflowRun {
  return {
    defId: 'def-1',
    defHash: 'h',
    worktreePath: '/repos/app/feature-x',
    status: 'running',
    startedAt: 1,
    cursorStepId: 'build',
    steps: { build: { status: 'running', attemptIds: [] } },
    ...overrides
  }
}

function seededState(labsOn = true): AppState {
  return {
    ...initialState,
    settings: { ...initialState.settings, labs: { ...initialState.settings.labs, workflows: labsOn } },
    workflows: {
      ...initialState.workflows,
      definitions: {
        'def-1': {
          id: 'def-1',
          name: 'Ship feature',
          scope: 'personal',
          path: '/defs/ship.yml',
          hash: 'h',
          stepIds: ['build'],
          issues: []
        }
      },
      runs: { [RUN_ID]: run() }
    }
  }
}

function setup(options: { labsOn?: boolean; headless?: boolean; armed?: boolean } = {}) {
  const store = new Store(seededState(options.labsOn ?? true))
  const sent: WorkflowNotification[] = []
  const openSection = vi.fn()
  const log = vi.fn()
  const notifier = createWorkflowNotifier({
    store,
    notify: options.headless ? null : (n) => sent.push(n),
    openSection,
    log
  })
  if (options.armed ?? true) notifier.arm()
  const pause = (reason: 'step-failed' | 'needs-input' | 'interrupted' = 'needs-input'): void =>
    store.dispatch({ type: 'workflows/runPaused', payload: { runId: RUN_ID, reason } })
  return { store, sent, openSection, log, notifier, pause }
}

describe('createWorkflowNotifier', () => {
  it('sends one notification per pause with the workflow name and reason', () => {
    const { sent, pause } = setup()

    pause('needs-input')

    expect(sent).toHaveLength(1)
    expect(sent[0]?.title).toBe('Ship feature')
    expect(sent[0]?.body).toBe('Needs input · feature-x')
  })

  it('ignores pauses dispatched before it is armed', () => {
    const { sent, pause, notifier, store } = setup({ armed: false })

    pause('interrupted')
    expect(sent).toHaveLength(0)

    store.dispatch({ type: 'workflows/runResumed', payload: { runId: RUN_ID } })
    notifier.arm()
    pause('needs-input')
    expect(sent).toHaveLength(1)
  })

  it('does not notify when labs is off', () => {
    const { sent, pause } = setup({ labsOn: false })

    pause()

    expect(sent).toHaveLength(0)
  })

  it('does not notify in headless where the notifier is null', () => {
    const { pause, log } = setup({ headless: true })

    pause()

    expect(log).not.toHaveBeenCalled()
  })

  it('does not notify for non-pause events', () => {
    const { sent, store } = setup()

    store.dispatch({ type: 'workflows/stepStatusChanged', payload: { runId: RUN_ID, stepId: 'build', status: 'failed' } })
    store.dispatch({ type: 'workflows/runResumed', payload: { runId: RUN_ID } })

    expect(sent).toHaveLength(0)
  })

  it('does not notify for a pause on an unknown run', () => {
    const { sent, store } = setup()

    store.dispatch({ type: 'workflows/runPaused', payload: { runId: 'missing', reason: 'needs-input' } })

    expect(sent).toHaveLength(0)
  })

  it('dedupes a repeated identical pause event', () => {
    const { sent, pause } = setup()

    pause('needs-input')
    pause('needs-input')

    expect(sent).toHaveLength(1)
  })

  it('notifies again for a new pause occurrence after a resume', () => {
    const { sent, pause, store } = setup()

    pause('needs-input')
    store.dispatch({ type: 'workflows/runResumed', payload: { runId: RUN_ID } })
    pause('needs-input')

    expect(sent).toHaveLength(2)
  })

  it('notifies when the pause reason changes', () => {
    const { sent, pause } = setup()

    pause('needs-input')
    pause('step-failed')

    expect(sent.map((n) => n.body)).toEqual(['Needs input · feature-x', 'Step failed · feature-x'])
  })

  it('labels a pause after a user cancel as cancelled by user', () => {
    const { sent, pause, store } = setup()

    store.dispatch({ type: 'workflows/stepStatusChanged', payload: { runId: RUN_ID, stepId: 'build', status: 'cancelled' } })
    pause('step-failed')

    expect(sent[0]?.body).toBe('Cancelled by user · feature-x')
  })

  it('falls back to a generic title when the definition is unknown', () => {
    const { sent, pause, store } = setup()
    store.dispatch({ type: 'workflows/definitionDeleted', payload: { defId: 'def-1' } })

    pause()

    expect(sent[0]?.title).toBe('Workflow')
  })

  it('opens the workflows section when the notification is clicked', () => {
    const { sent, pause, openSection } = setup()

    pause()
    sent[0]?.onClick()

    expect(openSection).toHaveBeenCalledTimes(1)
  })

  it('logs each notification sent with only the run id and reason', () => {
    const { pause, log } = setup()

    pause('interrupted')

    expect(log).toHaveBeenCalledTimes(1)
    expect(log).toHaveBeenCalledWith('workflow', 'notification sent', { runId: RUN_ID, reason: 'interrupted' })
  })

  it('stops notifying after dispose', () => {
    const { sent, pause, notifier } = setup()

    notifier.dispose()
    pause()

    expect(sent).toHaveLength(0)
  })
})
