import type { ChatRuntimeId } from '../json-claude/types'

/** Agents whose native binary the desktop app downloads on first chat use
 *  instead of bundling. Claude ships inside the app and is never listed. */
export type DownloadableRuntime = Exclude<ChatRuntimeId, 'claude'>

export type RuntimeStatus =
  /** Resolved from the app bundle or node_modules; nothing to download. */
  | { state: 'bundled' }
  /** Downloaded earlier into userData and verified. */
  | { state: 'ready'; version: string }
  /** Not available yet; `sizeBytes` is the unpacked size when known. */
  | { state: 'missing'; version: string; sizeBytes: number | null }
  | { state: 'downloading'; version: string; receivedBytes: number; totalBytes: number | null }
  | { state: 'error'; version: string; error: string }

export interface RuntimesState {
  byAgent: Partial<Record<DownloadableRuntime, RuntimeStatus>>
}

export type RuntimesEvent = {
  type: 'runtimes/statusChanged'
  payload: { agentKind: DownloadableRuntime; status: RuntimeStatus }
}
