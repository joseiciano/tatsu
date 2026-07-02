import { useCallback, useEffect, useMemo, useState } from 'react'
import { ArrowLeft, GitPullRequest, ChevronDown, ChevronRight, Layers, Rows3 } from 'lucide-react'
import { useSettings, useSnooze } from '../../store'
import type {
  Worktree,
  PtyStatus,
  PendingTool,
  PRStatus
} from '../../types'
import { groupWorktrees, type GroupKey } from '../../worktree-sort'
import { isPRMerged } from '../../../shared/state/prs'
import { repoNameColor } from '../RepoIcon'
import { formatPendingTool } from '../../pending-tool'

interface CommandCenterProps {
  worktrees: Worktree[]
  worktreeStatuses: Record<string, PtyStatus>
  worktreePendingTools: Record<string, PendingTool | null>
  prStatuses: Record<string, PRStatus | null>
  mergedPaths: Record<string, boolean>
  lastActive: Record<string, number>
  onClose: () => void
  onSelect: (worktreePath: string) => void
  embedded?: boolean
}

type DisplayStatus = PtyStatus | 'merged'

const STATUS_DOT: Record<DisplayStatus, string> = {
  idle: 'bg-faint',
  processing: 'bg-success animate-pulse',
  waiting: 'bg-warning',
  'needs-approval': 'bg-danger animate-pulse',
  merged: 'bg-accent'
}

const STATUS_LABEL: Record<DisplayStatus, string> = {
  idle: 'Idle',
  processing: 'Working',
  waiting: 'Waiting',
  'needs-approval': 'Needs approval',
  merged: 'Merged'
}

const STATUS_CARD_BORDER: Record<DisplayStatus, string> = {
  idle: 'border-border',
  processing: 'border-success/60',
  waiting: 'border-warning/70',
  'needs-approval': 'border-danger/80',
  merged: 'border-accent/60'
}

interface StatusCounts {
  'needs-approval': number
  waiting: number
  processing: number
  idle: number
}

function emptyStatusCounts(): StatusCounts {
  return { 'needs-approval': 0, waiting: 0, processing: 0, idle: 0 }
}

function relTime(ms: number | undefined, now: number): string {
  if (!ms) return '—'
  const diff = now - ms
  if (diff < 60_000) return 'just now'
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`
  return `${Math.floor(diff / 86_400_000)}d ago`
}

export function CommandCenter({
  worktrees,
  worktreeStatuses,
  worktreePendingTools,
  prStatuses,
  mergedPaths,
  lastActive,
  onClose,
  onSelect,
  embedded = false
}: CommandCenterProps): JSX.Element {
  // Clock tick so relative times advance.
  const [now, setNow] = useState(Date.now())
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 2000)
    return () => clearInterval(t)
  }, [])

  // Aggregate counts right now.
  const counts = useMemo(() => {
    const c = emptyStatusCounts()
    for (const wt of worktrees) {
      if (wt.isMain) continue
      if (mergedPaths[wt.path] || isPRMerged(prStatuses[wt.path])) continue
      const s = worktreeStatuses[wt.path] || 'idle'
      c[s] = (c[s] || 0) + 1
    }
    return c
  }, [worktrees, worktreeStatuses, prStatuses, mergedPaths])

  // Distinct repos represented in the current worktree list, in first-seen
  // order. Used to decide when to show the unified/split toggle and to
  // render per-repo sections in split mode.
  const repoRoots = useMemo(() => {
    const seen: string[] = []
    for (const wt of worktrees) {
      if (!seen.includes(wt.repoRoot)) seen.push(wt.repoRoot)
    }
    return seen
  }, [worktrees])

  // Unified = one set of PR-status groups across all repos (default).
  // Split = each repo gets its own section with its own groups.
  // Shares the same localStorage key as the sidebar toggle so the user's
  // preference stays consistent across views.
  const [unifiedRepos, setUnifiedRepos] = useState<boolean>(() => {
    const saved = localStorage.getItem('harness:unifiedRepos')
    return saved === null ? true : saved === '1'
  })
  useEffect(() => {
    localStorage.setItem('harness:unifiedRepos', unifiedRepos ? '1' : '0')
  }, [unifiedRepos])

  // Group cards. In unified mode we pass the full worktree list through
  // `groupWorktrees` once; in split mode we bucket by repo first, then
  // group inside each bucket so every repo has its own "Active" section.
  interface Section {
    /** Stable scope for collapse state. `__unified__` in unified mode,
     *  otherwise the repoRoot. */
    scope: string
    /** Repo header text — empty string in unified mode. */
    repoLabel: string
    groups: ReturnType<typeof groupWorktrees>
  }
  const viewerLogin = useSettings().viewerLogin
  const snoozeByPath = useSnooze().byPath
  const snoozedPaths = useMemo(() => {
    const m: Record<string, true> = {}
    for (const p of Object.keys(snoozeByPath)) m[p] = true
    return m
  }, [snoozeByPath])
  const sections = useMemo<Section[]>(() => {
    if (unifiedRepos || repoRoots.length <= 1) {
      return [{
        scope: '__unified__',
        repoLabel: '',
        groups: groupWorktrees(worktrees, prStatuses, mergedPaths, snoozedPaths, viewerLogin)
      }]
    }
    const byRepo = new Map<string, Worktree[]>()
    for (const root of repoRoots) byRepo.set(root, [])
    for (const wt of worktrees) byRepo.get(wt.repoRoot)!.push(wt)
    return repoRoots.map((root) => ({
      scope: root,
      repoLabel: root.split('/').pop() || root,
      groups: groupWorktrees(byRepo.get(root) || [], prStatuses, mergedPaths, snoozedPaths, viewerLogin)
    }))
  }, [unifiedRepos, repoRoots, worktrees, prStatuses, mergedPaths, snoozedPaths, viewerLogin])

  const totalCards = useMemo(
    () => sections.reduce((acc, s) => acc + s.groups.reduce((a, g) => a + g.worktrees.length, 0), 0),
    [sections]
  )

  // Collapse state keyed by `${scope}:${groupKey}` so each repo's groups
  // collapse independently in split mode. Defaults `merged` to collapsed.
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({})
  const isCollapsed = useCallback((scope: string, key: GroupKey): boolean => {
    const composite = `${scope}:${key}`
    if (composite in collapsed) return collapsed[composite]
    return key === 'merged'
  }, [collapsed])
  const toggleGroup = useCallback((scope: string, key: GroupKey): void => {
    const composite = `${scope}:${key}`
    setCollapsed((prev) => {
      const current = composite in prev ? prev[composite] : key === 'merged'
      return { ...prev, [composite]: !current }
    })
  }, [])

  const showRepoLabelOnCards = repoRoots.length > 1

  // ESC to close
  useEffect(() => {
    const handler = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [onClose])

  const cardDisplay = (wt: Worktree): DisplayStatus => {
    if (mergedPaths[wt.path] || isPRMerged(prStatuses[wt.path])) return 'merged'
    return worktreeStatuses[wt.path] || 'idle'
  }

  return (
    <div className={`${embedded ? 'min-w-0 flex flex-col bg-panel' : 'flex-1 min-w-0 flex flex-col bg-panel'}`}>
      {!embedded && <div className="drag-region h-10 shrink-0 border-b border-border relative">
        <button
          onClick={onClose}
          className="no-drag absolute left-4 top-1/2 -translate-y-1/2 flex items-center gap-1.5 text-xs text-muted hover:text-fg-bright transition-colors cursor-pointer"
        >
          <ArrowLeft className="icon-sm" />
          Back
          <kbd className="text-xs text-faint bg-bg px-1.5 py-0.5 rounded border border-border font-mono">ESC</kbd>
        </button>
        <span className="absolute left-1/2 -translate-x-1/2 top-1/2 -translate-y-1/2 text-sm font-medium text-fg pointer-events-none">
          Command Center
        </span>
      </div>}

      <div className="px-4 py-4 border-b border-border flex items-start gap-6 shrink-0">
        <div className="flex-1 min-w-0">
          <p className="text-xs text-dim">
            {totalCards} session{totalCards === 1 ? '' : 's'} · live view
          </p>
        </div>

        {/* Big counts */}
        <div className="flex items-center gap-4 no-drag">
          <StatCount
            label="Needs approval"
            value={counts['needs-approval']}
            dot="bg-danger"
            pulse={counts['needs-approval'] > 0}
          />
          <StatCount label="Waiting" value={counts.waiting} dot="bg-warning" />
          <StatCount label="Working" value={counts.processing} dot="bg-success" />
          <StatCount label="Idle" value={counts.idle} dot="bg-faint" />
        </div>

        {repoRoots.length > 1 && (
          <button
            onClick={() => setUnifiedRepos((v) => !v)}
            className="no-drag p-2 rounded hover:bg-surface text-muted hover:text-fg cursor-pointer"
            title={unifiedRepos ? 'Split by repo' : 'Merge repos into one list'}
          >
            {unifiedRepos ? <Rows3 className="icon-base" /> : <Layers className="icon-base" />}
          </button>
        )}
      </div>

      {/* Grouped grid of session cards */}
      <div className={`${embedded ? 'p-6 space-y-6' : 'flex-1 min-h-0 overflow-y-auto p-6 space-y-6'}`}>
        {totalCards === 0 && (
          <div className="h-full flex items-center justify-center text-dim">
            No sessions yet — create a worktree to get started.
          </div>
        )}

        {sections.map((section) => (
          <div key={section.scope}>
            {section.repoLabel && (
              <div className="flex items-center gap-2 mb-5">
                <h2 className={`text-base font-semibold tracking-tight ${repoNameColor(section.repoLabel)}`}>
                  {section.repoLabel}
                </h2>
                <div className="flex-1 border-t border-border" />
              </div>
            )}
            <div className="space-y-6">
            {section.groups.map((group) => {
              const collapsedHere = isCollapsed(section.scope, group.key)
              return (
                <section key={group.key}>
                  <button
                    onClick={() => toggleGroup(section.scope, group.key)}
                    className="w-full flex items-center gap-2 mb-3 text-left text-muted hover:text-fg transition-colors cursor-pointer"
                  >
                    {collapsedHere
                      ? <ChevronRight className="icon-sm shrink-0" />
                      : <ChevronDown className="icon-sm shrink-0" />}
                    <h2 className="text-xs font-semibold uppercase tracking-wider">
                      {group.label}
                    </h2>
                    <span className="text-xs text-faint">{group.worktrees.length}</span>
                    <div className="flex-1 border-t border-border ml-2" />
                  </button>

                  {!collapsedHere && (
                    <div
                      className="grid gap-3"
                      style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(190px, 1fr))' }}
                    >
                      {group.worktrees.map((wt) => {
                        const display = cardDisplay(wt)
                        const pr = prStatuses[wt.path]
                        const repoLabel = wt.repoRoot.split('/').pop() || wt.repoRoot
                        return (
                          <button
                            key={wt.path}
                            onClick={() => onSelect(wt.path)}
                            className={`h-28 text-left bg-app/50 border rounded-xl p-4 transition-colors hover:bg-app/60 flex flex-col justify-between cursor-pointer ${STATUS_CARD_BORDER[display]}`}
                          >
                            <div className="flex items-center gap-2 min-w-0">
                              <span
                                className={`w-2 h-2 rounded-full shrink-0 ${STATUS_DOT[display]}`}
                              />
                              <span className="text-xs uppercase tracking-wider text-dim font-semibold truncate">
                                {STATUS_LABEL[display]}
                              </span>
                              <div className="flex-1" />
                              {pr && (
                                <GitPullRequest
                                  className={`icon-xs shrink-0 ${pr.state === 'merged'
                                      ? 'text-accent'
                                      : pr.state === 'closed'
                                        ? 'text-danger'
                                        : pr.checksOverall === 'failure' || pr.hasConflict
                                          ? 'text-danger'
                                          : pr.checksOverall === 'pending'
                                            ? 'text-warning'
                                            : pr.checksOverall === 'success'
                                              ? 'text-success'
                                              : 'text-dim'}`} />
                              )}
                            </div>

                            <div className="min-w-0">
                              <div className="text-lg font-bold text-fg-bright tabular-nums truncate">
                                {wt.branch}
                              </div>
                            </div>

                            <div className="flex items-center gap-1.5 min-w-0 text-xs text-dim">
                              {showRepoLabelOnCards && (
                                <>
                                  <span className={`truncate shrink ${repoNameColor(repoLabel)}`}>
                                    {repoLabel}
                                  </span>
                                  <span className="text-dim/60 shrink-0">·</span>
                                </>
                              )}
                              {display === 'needs-approval' && worktreePendingTools[wt.path] ? (
                                <span className="truncate text-danger">
                                  waiting on {formatPendingTool(worktreePendingTools[wt.path] as PendingTool)}
                                </span>
                              ) : (
                                <span className="truncate tabular-nums">
                                  active {relTime(lastActive[wt.path], now)}
                                </span>
                              )}
                            </div>
                          </button>
                        )
                      })}
                    </div>
                  )}
                </section>
              )
            })}
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}

function StatCount({
  label,
  value,
  dot,
  pulse
}: {
  label: string
  value: number
  dot: string
  pulse?: boolean
}): JSX.Element {
  return (
    <div className="flex items-center gap-2">
      <span className={`w-2 h-2 rounded-full ${dot} ${pulse ? 'animate-pulse' : ''}`} />
      <div className="flex items-baseline gap-1">
        <span className="text-2xl font-bold tabular-nums text-fg-bright">{value}</span>
        <span className="text-xs uppercase tracking-wider text-faint">{label}</span>
      </div>
    </div>
  )
}
