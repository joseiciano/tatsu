import { realpathSync } from 'node:fs'
import { isAbsolute, relative, resolve, sep } from 'node:path'
import type { AppState } from '../../shared/state'

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
