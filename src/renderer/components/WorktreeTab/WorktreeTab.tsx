import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { GitPullRequest, RotateCw, Trash2, Loader2, Moon, TriangleAlert, Workflow } from 'lucide-react'
import type { Worktree, PtyStatus, PendingTool, PRStatus } from '../../types'
import { isPRMerged } from '../../../shared/state/prs'
import { formatWakeAt } from '../../../shared/state/snooze'
import { useAppState } from '../../store'
import { Tooltip } from '../Tooltip'
import { formatWorktreeAge } from '../worktree-detail'
import { useWorktreeDetailOverride } from '../../worktree-detail-override'
import { repoNameColor } from '../RepoIcon'
import { formatPendingTool } from '../../pending-tool'
import { HotkeyBadge } from '../HotkeyBadge'
import { useMetaHeld } from '../../hooks/useMetaHeld'
import type { Action } from '../../hotkeys'
import { showRunWorkflowItem } from '../Workflows/launch-sheet-helpers'

interface WorktreeTabProps {
  worktree: Worktree
  isActive: boolean
  status: PtyStatus
  pendingTool?: PendingTool | null
  shellActive?: boolean
  prStatus?: PRStatus | null
  isMerged?: boolean
  /** When set, shows a small repo hint next to the branch name. Used in
   *  unified-repo mode so two branches with the same name stay distinguishable. */
  repoLabel?: string
  /** 1-based position in the Cmd+1..9 switch order. Undefined if this
   *  worktree isn't bound to a numeric switch hotkey. */
  cmdOrdinal?: number
  /** When true, the worktree is in the middle of being deleted — show an
   * inert spinner + dim the row, hide action buttons. */
  deleting?: boolean
  isSnoozed?: boolean
  /** Wake-up timestamp (ms). Only meaningful when isSnoozed is true; used
   *  to render a "Wakes …" tooltip. */
  snoozeWakeAt?: number
  onClick: () => void
  onDelete?: () => void
  onContinue?: () => void
  /** Plain click → snooze for default duration. Option-click → open calendar
   *  popover at the row. The handler receives the original event so the
   *  caller can decide based on altKey. */
  onSnooze?: (e: React.MouseEvent) => void
  onUnsnooze?: () => void
  onRunWorkflow?: () => void
}

const STATUS_COLORS: Record<PtyStatus | 'merged', string> = {
  idle: 'bg-faint',
  processing: 'bg-success animate-pulse',
  waiting: 'bg-warning',
  'needs-approval': 'bg-danger animate-pulse',
  merged: 'bg-accent'
}

const STATUS_LABELS: Record<PtyStatus | 'merged', string> = {
  idle: 'Idle',
  processing: 'Working...',
  waiting: 'Waiting for input',
  'needs-approval': 'Needs approval',
  merged: 'Merged'
}

const PR_ICON_COLOR: Record<string, string> = {
  success: 'text-success',
  failure: 'text-danger',
  pending: 'text-warning',
  none: 'text-dim'
}

const DETACHED_LIKE_PREFIXES = ['rebasing', 'bisecting', 'cherry-picking']

function detachedLikeTooltip(branch: string): string | null {
  if (branch === '(detached)') return 'Detached HEAD'
  for (const prefix of DETACHED_LIKE_PREFIXES) {
    if (branch === prefix || branch.startsWith(`${prefix} `) || branch.startsWith(`${prefix}(`)) {
      return `In progress: ${branch}`
    }
  }
  return null
}

const PR_STATE_COLOR: Record<string, string> = {
  open: 'text-success',
  draft: 'text-dim',
  merged: 'text-accent',
  closed: 'text-danger'
}

export function WorktreeTab({ worktree, isActive, status, pendingTool, shellActive, prStatus, isMerged, repoLabel, cmdOrdinal, deleting, isSnoozed, snoozeWakeAt, onClick, onDelete, onContinue, onSnooze, onUnsnooze, onRunWorkflow }: WorktreeTabProps): JSX.Element {
  const metaHeld = useMetaHeld()
  const runWorkflowVisible = useAppState((s) =>
    showRunWorkflowItem({ labsWorkflows: s.settings.labs.workflows, worktreePath: worktree.path, runs: s.workflows.runs })
  )
  const canRunWorkflow = !!onRunWorkflow && runWorkflowVisible
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null)
  const menuRef = useRef<HTMLDivElement | null>(null)
  useEffect(() => {
    if (!menu) return
    menuRef.current?.querySelector('button')?.focus()
    const close = (): void => setMenu(null)
    const onMouseDown = (e: MouseEvent): void => {
      if (e.target instanceof Node && menuRef.current?.contains(e.target)) return
      close()
    }
    const onKeyDown = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape') return
      e.preventDefault()
      close()
    }
    window.addEventListener('mousedown', onMouseDown)
    window.addEventListener('keydown', onKeyDown)
    window.addEventListener('blur', close)
    return () => {
      window.removeEventListener('mousedown', onMouseDown)
      window.removeEventListener('keydown', onKeyDown)
      window.removeEventListener('blur', close)
    }
  }, [menu])
  useEffect(() => {
    if (!canRunWorkflow) setMenu(null)
  }, [canRunWorkflow])
  const configuredWorktreeDetail = useAppState((s) => s.settings.worktreeDetail)
  const worktreeDetailOverride = useWorktreeDetailOverride()
  const worktreeDetail = worktreeDetailOverride ?? configuredWorktreeDetail
  const displayStatus: PtyStatus | 'merged' = isMerged ? 'merged' : status
  const showPendingTool = displayStatus === 'needs-approval' && pendingTool
  const canContinue = !!onContinue && isPRMerged(prStatus)
  // Priority: merged/closed state always wins, then merge conflict, then check
  // status, then PR state
  let iconColor = ''
  let iconTitleSuffix = ''
  if (prStatus) {
    if (prStatus.state === 'merged') iconColor = PR_STATE_COLOR.merged
    else if (prStatus.state === 'closed') iconColor = PR_STATE_COLOR.closed
    else if (prStatus.hasConflict === true) {
      iconColor = PR_ICON_COLOR.failure
      iconTitleSuffix = ' \u2014 merge conflict'
    }
    else if (prStatus.checksOverall === 'failure') iconColor = PR_ICON_COLOR.failure
    else if (prStatus.checksOverall === 'pending') iconColor = PR_ICON_COLOR.pending
    else if (prStatus.checksOverall === 'success') iconColor = PR_ICON_COLOR.success
    else iconColor = PR_STATE_COLOR[prStatus.state]
  }

  return (
    <div
      onClick={onClick}
      onContextMenu={(e) => {
        if (!canRunWorkflow) return
        e.preventDefault()
        setMenu({ x: e.clientX, y: e.clientY })
      }}
      className={`group w-full text-left px-3 py-2 flex items-center gap-2 transition-colors cursor-pointer ${
        deleting ? 'opacity-60 italic' : ''
      } ${
        isActive
          ? 'bg-surface text-fg-bright'
          : 'text-muted hover:bg-panel-raised hover:text-fg'
      }`}
    >
      {deleting ? (
        <Loader2
          className="icon-xs animate-spin text-danger shrink-0"
          aria-label="Deleting worktree" />
      ) : (
        <span
          className={`w-2 h-2 rounded-full shrink-0 ${STATUS_COLORS[displayStatus]}`}
          title={STATUS_LABELS[displayStatus]}
        />
      )}
      {shellActive && (
        <Loader2
          className="icon-xs animate-spin text-fg-bright shrink-0"
          aria-label="Shell activity" />
      )}
      {prStatus && (
        <span
          className="relative shrink-0"
          title={`PR #${prStatus.number}${prStatus.checksOverall !== 'none' ? ` \u2014 checks ${prStatus.checksOverall}` : ''}${iconTitleSuffix}${prStatus.reviewDecision === 'approved' ? ' \u2014 approved' : prStatus.reviewDecision === 'changes_requested' ? ' \u2014 changes requested' : ''}`}
        >
          <GitPullRequest className={`icon-sm ${iconColor}`} />
          {prStatus.reviewDecision === 'approved' && (
            <span className="absolute -top-0.5 -right-0.5 w-1.5 h-1.5 rounded-full bg-success ring-1 ring-panel" />
          )}
          {prStatus.reviewDecision === 'changes_requested' && (
            <span className="absolute -top-0.5 -right-0.5 w-1.5 h-1.5 rounded-full bg-warning ring-1 ring-panel" />
          )}
        </span>
      )}
      <div className="min-w-0 flex-1">
        <div className="text-sm font-medium truncate flex items-center gap-1">
          {(() => {
            const tip = detachedLikeTooltip(worktree.branch)
            return tip ? (
              <span className="shrink-0 inline-flex" title={tip} aria-label={tip}>
                <TriangleAlert className="icon-xs text-warning" />
              </span>
            ) : null
          })()}
          <span className="truncate">{worktree.branch}</span>
        </div>
        {showPendingTool ? (
          <div className="text-xs text-danger truncate font-mono" title={formatPendingTool(pendingTool!)}>
            {formatPendingTool(pendingTool!)}
          </div>
        ) : (
          <div className="text-xs text-faint truncate">
            {repoLabel ? (
              <span className="inline-flex items-center gap-1">
                <span className={repoNameColor(repoLabel)}>{repoLabel}</span>
                <span className="mx-0.5">·</span>
                {worktree.path.split('/').pop()}
              </span>
            ) : (
              worktree.path.split('/').slice(-2).join('/')
            )}
          </div>
        )}
      </div>
      {canContinue && (
        <Tooltip label="Continue on a new branch off main" side="left">
          <button
            onClick={(e) => {
              e.stopPropagation()
              onContinue!()
            }}
            className="hidden group-hover:flex text-faint hover:text-accent transition-colors shrink-0 cursor-pointer"
          >
            <RotateCw className="icon-xs" />
          </button>
        </Tooltip>
      )}
      {worktreeDetail === 'diff' && prStatus && typeof prStatus.additions === 'number' && typeof prStatus.deletions === 'number' && (
        <span
          className="text-xs font-mono shrink-0 leading-none group-hover:hidden"
          title={`+${prStatus.additions} additions, −${prStatus.deletions} deletions`}
        >
          <span className="text-success">+{prStatus.additions}</span>
          <span className="text-danger ml-0.5">−{prStatus.deletions}</span>
        </span>
      )}
      {worktreeDetail === 'age' && (
        <span
          className="text-[10px] font-mono shrink-0 leading-none text-dim group-hover:hidden"
          title={worktree.createdAt ? `Created ${new Date(worktree.createdAt).toLocaleString()}` : 'Creation time unknown'}
        >
          {formatWorktreeAge(worktree.createdAt)}
        </span>
      )}
      {worktreeDetail === 'pr' && prStatus && (
        <span className="inline-flex items-center gap-1.5 shrink-0 group-hover:hidden">
          {prStatus.milestone && (
            <span
              className="text-[10px] text-dim truncate max-w-[6rem]"
              title={`Milestone: ${prStatus.milestone.title}`}
            >
              {prStatus.milestone.title}
            </span>
          )}
          <span
            className="text-[10px] font-mono leading-none px-1.5 py-0.5 rounded-full bg-panel border border-border-strong text-fg-bright"
            title={`PR #${prStatus.number}`}
          >
            #{prStatus.number}
          </span>
          {prStatus.assignees[0] && (
            <img
              src={prStatus.assignees[0].avatarUrl}
              alt=""
              title={`Assignee: ${prStatus.assignees[0].login}${prStatus.assignees.length > 1 ? ` (+${prStatus.assignees.length - 1})` : ''}`}
              className="w-3.5 h-3.5 rounded-full shrink-0"
            />
          )}
        </span>
      )}
      {(onSnooze || onUnsnooze) && !worktree.isMain && (
        <Tooltip
          label={
            isSnoozed
              ? typeof snoozeWakeAt === 'number'
                ? `Wakes ${formatWakeAt(snoozeWakeAt)} — click to wake up`
                : 'Wake up'
              : 'Snooze (⌥-click to pick a date)'
          }
          side="left"
        >
          <button
            onClick={(e) => {
              e.stopPropagation()
              if (isSnoozed) {
                onUnsnooze?.()
              } else {
                onSnooze?.(e)
              }
            }}
            className="hidden group-hover:flex text-faint hover:text-accent transition-colors shrink-0 cursor-pointer"
          >
            <Moon className="icon-xs" />
          </button>
        </Tooltip>
      )}
      {onDelete && (
        <Tooltip label="Remove worktree" side="left">
          <button
            onClick={(e) => {
              e.stopPropagation()
              onDelete()
            }}
            className="hidden group-hover:flex text-faint hover:text-danger transition-colors shrink-0 cursor-pointer"
          >
            <Trash2 className="icon-xs" />
          </button>
        </Tooltip>
      )}
      {metaHeld && cmdOrdinal !== undefined && (
        <HotkeyBadge
          action={`worktree${cmdOrdinal}` as Action}
          variant="strong"
          className="shrink-0"
        />
      )}
      {menu && onRunWorkflow && createPortal(
        <div
          ref={menuRef}
          role="menu"
          className="fixed z-50 bg-panel-raised border border-border-strong rounded shadow-lg text-xs py-1 min-w-[12rem]"
          style={{ left: menu.x, top: menu.y }}
          onClick={(e) => e.stopPropagation()}
          onMouseDown={(e) => e.stopPropagation()}
          onContextMenu={(e) => {
            e.preventDefault()
            e.stopPropagation()
          }}
        >
          <button
            role="menuitem"
            className="flex items-center gap-2 w-full text-left px-3 py-1.5 hover:bg-panel focus:bg-panel focus:outline-none text-fg-bright cursor-pointer"
            onClick={(e) => {
              e.stopPropagation()
              setMenu(null)
              onRunWorkflow()
            }}
          >
            <Workflow className="icon-xs text-dim" />
            Run workflow here…
          </button>
        </div>,
        document.body
      )}
    </div>
  )
}
