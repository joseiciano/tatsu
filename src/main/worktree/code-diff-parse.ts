import type { CodeDiffStatus } from '../../shared/code-diff'

export interface NameStatusEntry {
  status: CodeDiffStatus
  path: string
  previousPath?: string
  copied?: boolean
}

export type NumstatCounts = { additions: number; deletions: number } | null

/** Parse `git diff --name-status -z`. Renames and copies carry the old path
 * then the new path as separate NUL-terminated tokens. */
export function parseNameStatusZ(stdout: string): NameStatusEntry[] {
  const tokens = stdout.split('\0')
  const entries: NameStatusEntry[] = []
  let i = 0
  while (i < tokens.length) {
    const code = tokens[i]
    if (!code) {
      i++
      continue
    }
    const kind = code[0]
    if (kind === 'R' || kind === 'C') {
      const previousPath = tokens[i + 1] ?? ''
      const path = tokens[i + 2] ?? ''
      const entry: NameStatusEntry = { status: 'renamed', path, previousPath }
      if (kind === 'C') entry.copied = true
      if (path) entries.push(entry)
      i += 3
      continue
    }
    const path = tokens[i + 1] ?? ''
    const status: CodeDiffStatus = kind === 'A' ? 'added' : kind === 'D' ? 'deleted' : 'modified'
    if (path) entries.push({ status, path })
    i += 2
  }
  return entries
}

/** Parse `git diff --numstat -z`, keyed by destination path. Binary files
 * report `-` for both counts and map to null. */
export function parseNumstatZ(stdout: string): Map<string, NumstatCounts> {
  const map = new Map<string, NumstatCounts>()
  const tokens = stdout.split('\0')
  let i = 0
  while (i < tokens.length) {
    const tok = tokens[i]
    if (!tok) {
      i++
      continue
    }
    const first = tok.indexOf('\t')
    const second = first < 0 ? -1 : tok.indexOf('\t', first + 1)
    if (second < 0) {
      i++
      continue
    }
    const addStr = tok.slice(0, first)
    const delStr = tok.slice(first + 1, second)
    const pathField = tok.slice(second + 1)
    const counts: NumstatCounts =
      addStr === '-' || delStr === '-' ? null : { additions: Number(addStr), deletions: Number(delStr) }
    if (pathField === '') {
      const newPath = tokens[i + 2] ?? ''
      if (newPath) map.set(newPath, counts)
      i += 3
    } else {
      map.set(pathField, counts)
      i++
    }
  }
  return map
}

export function isUnsafeRef(ref: string): boolean {
  if (!ref || ref.startsWith('-') || ref.includes('..')) return true
  return /[\s\x00-\x1f\x7f]/.test(ref)
}

export function countLines(text: string): number {
  if (!text) return 0
  let n = 0
  for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) === 10) n++
  return text.endsWith('\n') ? n : n + 1
}
