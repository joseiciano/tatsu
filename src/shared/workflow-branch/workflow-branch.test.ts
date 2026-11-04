import { describe, expect, it } from 'vitest'
import { branchNameProblem } from '../branch-name-rules'
import { chainItemBranchName, workflowBranchName } from '.'

const RUN = '0a1b2c3d'

describe('workflowBranchName', () => {
  it('builds wf/<definition>/<suffix> from a sanitized definition name', () => {
    expect(workflowBranchName('Plan & Ship!', 'k3x9ab12')).toBe('wf/plan-ship/k3x9ab12')
  })
})

describe('chainItemBranchName', () => {
  it.each([
    ['plain title', 'Fix login bug', 'wf/browser-hang/fix-login-bug-0a1b2c3d'],
    ['unicode and emoji', 'Ünïcode 🚀 títle', 'wf/browser-hang/n-code-t-tle-0a1b2c3d'],
    ['shell metacharacters', '$(rm -rf /); `id` | cat & "x" \'y\'', 'wf/browser-hang/rm-rf-id-cat-x-y-0a1b2c3d'],
    ['dot-dot and leading dash', '--../..evil', 'wf/browser-hang/evil-0a1b2c3d'],
    ['empty title', '', 'wf/browser-hang/item-0a1b2c3d'],
    ['title with nothing usable', '🚀…', 'wf/browser-hang/item-0a1b2c3d']
  ])('slugs a %s', (_label, title, expected) => {
    expect(chainItemBranchName('browser-hang', title, RUN)).toBe(expected)
  })

  it('falls back to "workflow" for an unusable definition name', () => {
    expect(chainItemBranchName('…', 'Task', RUN)).toBe('wf/workflow/task-0a1b2c3d')
  })

  it('caps an over-long title so the whole name stays within 100 chars without a trailing dash', () => {
    const name = chainItemBranchName('d'.repeat(200), `${'a'.repeat(39)} ${'b'.repeat(200)}`, RUN)
    expect(name.length).toBeLessThanOrEqual(100)
    expect(name).toBe(`wf/${'d'.repeat(40)}/${'a'.repeat(39)}-0a1b2c3d`)
  })

  it('never produces a name the branch rules reject', () => {
    const titles = ['Fix login bug', 'Ünïcode 🚀', '$(rm -rf /)', '--../..evil', '', 'x.lock', '@{u}', 'a~b^c:d?e*f[g', 'z'.repeat(500)]
    for (const title of titles) {
      expect(branchNameProblem(chainItemBranchName('Plan & Ship!', title, RUN))).toBeNull()
    }
  })

  it.each(['', '0A1B2C3D', '0a1b2c3', '0a1b2c3d9', '0a1b2c3g', '../aaaaa', '-0a1b2c3'])(
    'refuses a malformed shortRunId %j',
    (shortRunId) => {
      expect(() => chainItemBranchName('browser-hang', 'Task', shortRunId)).toThrow(/shortRunId/)
    }
  )
})
