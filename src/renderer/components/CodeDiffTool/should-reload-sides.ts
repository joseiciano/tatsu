import type { CodeDiffFile } from '../../../shared/code-diff'

/** The open diff reloads only when the selected file's content plausibly
 * changed, so the 3 s list poll does not re-send both sides every tick. */
export function shouldReloadSides(prev: CodeDiffFile | undefined, next: CodeDiffFile | undefined): boolean {
  if (!prev || !next) return false
  return prev.mtimeMs !== next.mtimeMs || prev.additions !== next.additions || prev.deletions !== next.deletions
}
