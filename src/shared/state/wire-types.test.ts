import { describe, expect, it } from 'vitest'
import type * as Generated from './generated'
import { initialSnooze, snoozeReducer, type SnoozeEvent, type SnoozeState } from './snooze'

type MutuallyAssignable<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false

const snoozeState: MutuallyAssignable<Generated.SnoozeState, SnoozeState> = true
const snoozeEvent: MutuallyAssignable<Generated.SnoozeEvent, SnoozeEvent> = true

describe('generated wire types', () => {
  it('the TS reducer applies events typed with the generated union', () => {
    const events: Generated.SnoozeEvent[] = [
      { type: 'snooze/set', payload: { path: '/a', snoozedAt: 1, wakeAt: 2.5 } },
      { type: 'snooze/set', payload: { path: '/b', snoozedAt: 1, wakeAt: 3 } },
      { type: 'snooze/clear', payload: '/a' }
    ]
    const state: Generated.SnoozeState = events.reduce(snoozeReducer, initialSnooze)
    expect(state).toEqual({ byPath: { '/b': { path: '/b', snoozedAt: 1, wakeAt: 3 } } })
  })
})
