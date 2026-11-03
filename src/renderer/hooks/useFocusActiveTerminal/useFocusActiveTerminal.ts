import { useEffect } from 'react'
import { focusTerminalById } from '../../components/XTerminal'

export function useFocusActiveTerminal(activeWorktreeId: string | null, activeTabId: Record<string, string>): void {
  const tabId = activeWorktreeId ? activeTabId[activeWorktreeId] : undefined
  useEffect(() => {
    if (!tabId || tabId.startsWith('diff-')) return
    const raf = requestAnimationFrame(() => focusTerminalById(tabId))
    return () => cancelAnimationFrame(raf)
  }, [activeWorktreeId, tabId])
}
