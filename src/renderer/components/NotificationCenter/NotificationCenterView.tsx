import { ArrowLeft, Bell, BellOff, CalendarDays, Loader2, RefreshCw, X } from 'lucide-react'
import type { Announcement } from '../../../shared/state/announcements'

export interface NotificationCenterViewProps {
  items: Announcement[]
  dismissedIds: ReadonlySet<string>
  loading: boolean
  muted: boolean
  onClose: () => void
  onRefresh: () => void
  onOpen: (href: string) => void
  onDismiss: (id: string) => void
  onToggleMute: () => void
}

function formatDate(iso: string): string {
  const t = Date.parse(iso)
  if (!Number.isFinite(t)) return ''
  return new Date(t).toLocaleDateString()
}

export function NotificationCenterView({
  items,
  dismissedIds,
  loading,
  muted,
  onClose,
  onRefresh,
  onOpen,
  onDismiss,
  onToggleMute
}: NotificationCenterViewProps): JSX.Element {
  return (
    <div className="flex flex-col h-full w-full bg-panel">
      <div className="drag-region h-10 shrink-0 border-b border-border relative">
        <button
          onClick={onClose}
          className="no-drag absolute left-4 top-1/2 -translate-y-1/2 flex items-center gap-1.5 text-xs text-muted hover:text-fg-bright transition-colors cursor-pointer"
        >
          <ArrowLeft className="icon-sm" />
          Back
        </button>
        <span className="absolute left-1/2 -translate-x-1/2 top-1/2 -translate-y-1/2 text-sm font-medium text-fg pointer-events-none">
          Notifications
        </span>
        <div className="no-drag absolute right-4 top-1/2 -translate-y-1/2 flex items-center gap-2">
          <button
            onClick={onToggleMute}
            className="flex items-center gap-1.5 px-2 py-1 text-xs text-muted hover:text-fg-bright hover:bg-surface rounded transition-colors cursor-pointer"
            title={muted ? 'Unmute notifications' : 'Mute notifications'}
          >
            {muted ? <BellOff className="icon-sm" /> : <Bell className="icon-sm" />}
            {muted ? 'Unmute' : 'Mute'}
          </button>
          <button
            onClick={onRefresh}
            className="text-muted hover:text-fg-bright transition-colors cursor-pointer p-1"
            title="Refresh"
          >
            {loading ? <Loader2 className="icon-sm animate-spin" /> : <RefreshCw className="icon-sm" />}
          </button>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto">
        <div className="max-w-5xl mx-auto px-8 py-8">
          {muted && (
            <div className="mb-4 text-xs text-dim bg-surface/40 border border-border rounded-lg px-3 py-2">
              Notifications are muted. Unmute to see new announcements.
            </div>
          )}

          {items.length === 0 && !loading && (
            <div className="text-sm text-dim py-12 text-center">
              No announcements yet.
            </div>
          )}

          <div className="space-y-3">
            {items.map((a) => {
              const dismissed = dismissedIds.has(a.id)
              return (
                <div
                  key={a.id}
                  onClick={() => onOpen(a.href)}
                  className={`group flex items-start gap-3 p-4 bg-app/50 border border-border rounded-xl cursor-pointer hover:border-accent/40 transition-colors ${
                    dismissed ? 'opacity-50' : ''
                  }`}
                  title="Open"
                >
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className="text-sm font-semibold text-fg-bright truncate">{a.title}</span>
                      {dismissed && (
                        <span className="shrink-0 text-xs uppercase tracking-wider text-dim/70 bg-faint/10 px-1 py-px rounded">
                          dismissed
                        </span>
                      )}
                    </div>
                    {a.summary && <p className="text-sm text-muted mt-1">{a.summary}</p>}
                    <div className="flex items-center gap-1.5 text-xs text-dim mt-2">
                      <CalendarDays className="icon-xs" />
                      <span>{formatDate(a.publishedAt)}</span>
                    </div>
                  </div>
                  {!dismissed && (
                    <button
                      onClick={(e) => {
                        e.stopPropagation()
                        onDismiss(a.id)
                      }}
                      className="opacity-0 group-hover:opacity-100 text-faint hover:text-danger transition-all shrink-0 cursor-pointer p-1"
                      title="Dismiss"
                    >
                      <X className="icon-sm" />
                    </button>
                  )}
                </div>
              )
            })}
          </div>
        </div>
      </div>
    </div>
  )
}
