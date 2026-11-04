import { describe, expect, it } from 'vitest'
import { isValidBranchName, sanitizeBranchInput } from '.'
import { branchNameProblem } from '../../shared/branch-name-rules'

describe('sanitizeBranchInput', () => {
  it('produces names the server-side branch rules accept whenever isValidBranchName passes', () => {
    const raws = ['Fix the login bug', 'feature/Foo Bar', 'map-repo', 'a..b c', 'wip:@{v1.0}', 'x~y^z', 'teleport-01ABC']
    const accepted = raws.map(sanitizeBranchInput).filter(isValidBranchName)
    expect(accepted.length).toBeGreaterThan(0)
    for (const name of accepted) expect(branchNameProblem(name)).toBeNull()
  })
})
