import { createTwoFilesPatch, FILE_HEADERS_ONLY } from 'diff'
import type { CodeDiffFile, CodeDiffSides } from '../../../shared/code-diff'

export function renderPatch(file: CodeDiffFile, sides: CodeDiffSides): string {
  const oldName = file.status === 'added' || file.status === 'untracked' ? '/dev/null' : `a/${file.previousPath ?? file.path}`
  const newName = file.status === 'deleted' ? '/dev/null' : `b/${file.path}`
  if (sides.large) {
    if (sides.large.patch === null) return `${file.path}: too large to diff\n`
    return `--- ${oldName}\n+++ ${newName}\n${sides.large.patch}`
  }
  if (sides.originalBinary || sides.modifiedBinary) return `Binary files ${oldName} and ${newName} differ\n`
  return createTwoFilesPatch(oldName, newName, sides.original, sides.modified, '', '', {
    context: 3,
    headerOptions: FILE_HEADERS_ONLY
  })
}
