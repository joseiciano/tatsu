import { describe, expect, it } from 'vitest'
import { branchNameProblem, MAX_BRANCH_NAME_LENGTH } from '.'

describe('branchNameProblem', () => {
  it.each(['feat', 'feature/foo', 'wf/plan/k3x9-ab12', 'release_2024.10-rc1', 'teleport-01ABCdef', 'a-b.c'])(
    'accepts %s',
    (name) => {
      expect(branchNameProblem(name)).toBeNull()
    }
  )

  it.each([
    ['', 'Enter a branch name'],
    ['-x', 'A branch name can’t start with “-”'],
    ['a..b', 'A branch name can’t contain “..”'],
    ['../../etc', 'A branch name can’t contain “..”'],
    ['a\\b', 'A branch name can’t contain “\\”'],
    ['a@{1}', 'A branch name can’t contain “@{”'],
    ['@', 'A branch name can’t be “@”'],
    ['a b', 'A branch name can’t contain spaces or control characters'],
    ['a\tb', 'A branch name can’t contain spaces or control characters'],
    ['a:b', 'A branch name can’t contain ~ ^ : ? * ['],
    ['a*b', 'A branch name can’t contain ~ ^ : ? * ['],
    ['/a', 'A branch name can’t start or end with “/” or contain “//”'],
    ['a/', 'A branch name can’t start or end with “/” or contain “//”'],
    ['a//b', 'A branch name can’t start or end with “/” or contain “//”'],
    ['a/.b', 'A branch name part can’t start with “.” or end with “.lock”'],
    ['.a', 'A branch name part can’t start with “.” or end with “.lock”'],
    ['a.lock/b', 'A branch name part can’t start with “.” or end with “.lock”'],
    ['a.', 'A branch name can’t end with “.”']
  ])('rejects %j', (name, problem) => {
    expect(branchNameProblem(name)).toBe(problem)
  })

  it('rejects a name longer than the cap', () => {
    expect(branchNameProblem('a'.repeat(MAX_BRANCH_NAME_LENGTH))).toBeNull()
    expect(branchNameProblem('a'.repeat(MAX_BRANCH_NAME_LENGTH + 1))).toBe(
      `A branch name can’t be longer than ${MAX_BRANCH_NAME_LENGTH} characters`
    )
  })

})
