import { Download } from 'lucide-react'
import { agentDisplayName } from '../../../shared/agent-registry'
import type { AgentKind } from '../../../shared/state/terminals'
import type { RuntimeStatus } from '../../../shared/state/runtimes'

export function formatRuntimeBytes(bytes: number): string {
  const mb = bytes / (1024 * 1024)
  if (mb >= 1024) return `${(mb / 1024).toFixed(1)} GB`
  return `${Math.max(1, Math.round(mb))} MB`
}

const PRIMARY_BUTTON =
  'px-2 py-1 bg-accent text-white rounded hover:bg-accent/90 cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed'

export function RuntimeDownloadCard({
  agentKind,
  status,
  onDownload,
  onRetry
}: {
  agentKind: AgentKind
  status: RuntimeStatus
  onDownload: () => void
  onRetry: () => void
}): JSX.Element | null {
  if (status.state === 'bundled') return null
  const name = agentDisplayName(agentKind)
  const title =
    status.state === 'ready'
      ? `${name} is ready`
      : status.state === 'downloading'
        ? `Downloading ${name}`
        : `${name} is not installed yet`
  const danger = status.state === 'error'

  return (
    <div
      className="my-2 border border-border bg-panel/40 overflow-hidden"
      style={{ borderRadius: 'var(--chat-bubble-radius)' }}
    >
      <div
        className="flex items-center gap-2 bg-panel-raised border-b border-border"
        style={{
          paddingInline: 'var(--chat-chrome-px)',
          paddingBlock: 'var(--chat-chrome-py)',
          fontSize: 'var(--chat-chrome-text)'
        }}
      >
        <Download className="icon-xs text-muted shrink-0" />
        <span
          className="font-semibold shrink-0 text-fg-bright"
          style={{ fontFamily: 'var(--chat-tool-name-family)' }}
        >
          {danger ? `${name} download failed` : title}
        </span>
      </div>
      <div className="px-3 py-2 text-xs text-fg space-y-2">
        {status.state === 'missing' && (
          <>
            <div>
              Tatsu downloads the pinned {status.version} build
              {status.sizeBytes !== null
                ? ` (~${formatRuntimeBytes(status.sizeBytes)})`
                : ''}{' '}
              into its own data folder. No global install, no PATH changes.
            </div>
            <div className="pt-1">
              <button onClick={onDownload} className={PRIMARY_BUTTON}>
                Download {name}
              </button>
            </div>
          </>
        )}
        {status.state === 'downloading' && (
          <>
            <div
              className="h-1.5 w-full rounded-full bg-app/60 overflow-hidden"
              role="progressbar"
              aria-valuemin={0}
              aria-valuemax={status.totalBytes ?? undefined}
              aria-valuenow={
                status.totalBytes !== null ? status.receivedBytes : undefined
              }
            >
              {status.totalBytes !== null && status.totalBytes > 0 ? (
                <div
                  className="h-full bg-accent transition-[width] duration-200"
                  style={{
                    width: `${Math.min(100, (status.receivedBytes / status.totalBytes) * 100)}%`
                  }}
                />
              ) : (
                <div className="h-full w-1/3 bg-accent animate-pulse" />
              )}
            </div>
            <div className="text-muted">
              {status.totalBytes !== null
                ? `${formatRuntimeBytes(status.receivedBytes)} of ${formatRuntimeBytes(status.totalBytes)}`
                : `${formatRuntimeBytes(status.receivedBytes)} downloaded`}
            </div>
            <div className="pt-1">
              <button disabled className={PRIMARY_BUTTON}>
                Downloading…
              </button>
            </div>
          </>
        )}
        {status.state === 'error' && (
          <>
            <pre className="whitespace-pre-wrap break-words font-mono text-xs text-muted bg-app/40 border border-border/40 rounded px-2 py-1 max-h-32 overflow-auto">
              {status.error}
            </pre>
            <div className="pt-1">
              <button onClick={onDownload} className={PRIMARY_BUTTON}>
                Try again
              </button>
            </div>
          </>
        )}
        {status.state === 'ready' && (
          <div className="pt-1">
            <button onClick={onRetry} className={PRIMARY_BUTTON}>
              Start session
            </button>
          </div>
        )}
      </div>
    </div>
  )
}
