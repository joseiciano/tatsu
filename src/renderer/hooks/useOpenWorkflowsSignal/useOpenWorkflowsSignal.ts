import { useEffect, useRef } from 'react'
import type { ElectronAPI } from '../../types'

export type OpenWorkflowsSignalSource = Pick<ElectronAPI, 'onOpenWorkflowsSection'>

export function useOpenWorkflowsSignal(source: OpenWorkflowsSignalSource, open: () => void): void {
  const openRef = useRef(open)
  openRef.current = open
  useEffect(() => source.onOpenWorkflowsSection(() => openRef.current()), [source])
}
