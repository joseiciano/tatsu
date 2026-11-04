export const MAX_BRANCH_NAME_LENGTH = 200

const SPACE_OR_CONTROL = /[\s\x00-\x1f\x7f]/
const GIT_SPECIAL = /[~^:?*[]/

export function branchNameProblem(name: string): string | null {
  if (name === '') return 'Enter a branch name'
  if (name.length > MAX_BRANCH_NAME_LENGTH) {
    return `A branch name can’t be longer than ${MAX_BRANCH_NAME_LENGTH} characters`
  }
  if (name.startsWith('-')) return 'A branch name can’t start with “-”'
  if (name.includes('..')) return 'A branch name can’t contain “..”'
  if (name.includes('\\')) return 'A branch name can’t contain “\\”'
  if (name.includes('@{')) return 'A branch name can’t contain “@{”'
  if (name === '@') return 'A branch name can’t be “@”'
  if (SPACE_OR_CONTROL.test(name)) return 'A branch name can’t contain spaces or control characters'
  if (GIT_SPECIAL.test(name)) return 'A branch name can’t contain ~ ^ : ? * ['
  if (name.startsWith('/') || name.endsWith('/') || name.includes('//')) {
    return 'A branch name can’t start or end with “/” or contain “//”'
  }
  if (name.split('/').some((part) => part.startsWith('.') || part.endsWith('.lock'))) {
    return 'A branch name part can’t start with “.” or end with “.lock”'
  }
  if (name.endsWith('.')) return 'A branch name can’t end with “.”'
  return null
}
