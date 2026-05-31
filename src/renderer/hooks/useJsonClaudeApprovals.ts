import { useCallback, useMemo } from 'react'
import { useJsonClaudePendingApprovals, useJsonClaudeSession } from '../store'
import { useBackend } from '../backend'
import type { JsonClaudePendingApproval } from '../../shared/state/json-claude'

interface ApprovalResult {
  behavior: 'allow' | 'deny'
  updatedInput?: Record<string, unknown>
  updatedPermissions?: unknown[]
  message?: string
  interrupt?: boolean
}

interface UseApprovals {
  /** Pending approvals for this session in request-time order. */
  pending: JsonClaudePendingApproval[]
  /** Resolve an approval by request id. */
  resolve: (requestId: string, result: ApprovalResult) => void
}

export function useJsonClaudeApprovals(sessionId: string): UseApprovals {
  const pendingApprovals = useJsonClaudePendingApprovals()
  const session = useJsonClaudeSession(sessionId)
  const backend = useBackend()
  const pending = useMemo(() => {
    if (session?.capabilities?.canApproveTools === false) {
      return []
    }
    const list = Object.values(pendingApprovals).filter(
      (a) => a.sessionId === sessionId
    )
    list.sort((a, b) => a.timestamp - b.timestamp)
    return list
  }, [pendingApprovals, sessionId, session])

  const resolve = useCallback((requestId: string, result: ApprovalResult) => {
    void backend.resolveJsonClaudeApproval(requestId, result)
  }, [backend])

  return { pending, resolve }
}
