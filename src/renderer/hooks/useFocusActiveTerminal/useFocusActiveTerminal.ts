import { useEffect } from 'react'
import { focusTerminalById } from '../../components/XTerminal'
import { FOCUS_TRAP_ATTRIBUTE } from '../useFocusTrap'

export function useFocusActiveTerminal(activeWorktreeId: string | null, activeTabId: Record<string, string>): void {
  const tabId = activeWorktreeId ? activeTabId[activeWorktreeId] : undefined
  useEffect(() => {
    if (!tabId || tabId.startsWith('diff-')) return
    const raf = requestAnimationFrame(() => {
      if (document.activeElement?.closest(`[${FOCUS_TRAP_ATTRIBUTE}]`)) return
      focusTerminalById(tabId)
    })
    return () => cancelAnimationFrame(raf)
  }, [activeWorktreeId, tabId])
}
