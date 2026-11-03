import { realpathSync } from 'node:fs'
import { isAbsolute, relative, resolve, sep } from 'node:path'
import type { AppState } from '../../shared/state'
import type { Worktree } from '../../shared/state/worktrees'
import { CliError } from '../errors'

function canonical(path: string): string {
  try {
    return realpathSync(path)
  } catch {
    return resolve(path)
  }
}

function contains(base: string, path: string): boolean {
  const rel = relative(base, path)
  return rel === '' || (!isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${sep}`))
}

export function findRepo(state: AppState, path: string): string | null {
  const target = canonical(path)
  let best: { root: string; depth: number } | null = null
  for (const root of state.worktrees.repoRoots) {
    const bases = [root, ...state.worktrees.list.filter((wt) => wt.repoRoot === root).map((wt) => wt.path)]
    for (const base of bases) {
      const canonicalBase = canonical(base)
      if (contains(canonicalBase, target) && (best === null || canonicalBase.length > best.depth)) {
        best = { root, depth: canonicalBase.length }
      }
    }
  }
  return best?.root ?? null
}

export function findWorktree(state: AppState, value: string): Worktree {
  const { list } = state.worktrees
  const byBranch = value === '' ? undefined : list.find((wt) => wt.branch === value)
  if (byBranch) return byBranch
  const target = canonical(value)
  let best: { worktree: Worktree; depth: number } | null = null
  for (const wt of list) {
    const base = canonical(wt.path)
    if (contains(base, target) && (best === null || base.length > best.depth)) best = { worktree: wt, depth: base.length }
  }
  if (best) return best.worktree
  throw new CliError('usage', `no worktree matches '${value}'`, {
    worktrees: list.map(({ path, branch }) => ({ path, branch }))
  })
}
