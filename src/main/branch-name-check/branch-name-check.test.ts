import { describe, expect, it } from 'vitest'
import { checkBranchName } from '.'

describe('checkBranchName', () => {
  it.each(['feat', 'feature/foo', 'wf/plan/k3x9-ab12'])('accepts %s', async (name) => {
    expect(await checkBranchName(name)).toBeNull()
  })

  it('rejects shapes before asking git', async () => {
    expect(await checkBranchName('-delete')).toBe('A branch name can’t start with “-”')
    expect(await checkBranchName('../escape')).toBe('A branch name can’t contain “..”')
    expect(await checkBranchName('@{-1}')).toBe('A branch name can’t contain “@{”')
  })

  it('rejects what git check-ref-format refuses', async () => {
    expect(await checkBranchName('HEAD')).toBe('“HEAD” is not a valid git branch name')
  })
})
