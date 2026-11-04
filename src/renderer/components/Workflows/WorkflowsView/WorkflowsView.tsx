import { useCallback, useEffect, useMemo, useState } from 'react'
import { useAppState } from '../../../store'
import { NeedsYouGroup, type JumpToTabHandler } from '../NeedsYou'
import { createRunListsSelector } from '../run-card-model'
import { RunDetailContainer } from '../RunDetail'
import { RunsTab } from './RunsTab'
import { WorkflowsSection, type WorkflowsTab } from './WorkflowsSection'

const ELAPSED_TICK_MS = 1000

const selectRunLists = createRunListsSelector()

export interface WorkflowsViewProps {
  onClose: () => void
  onJumpToTab?: JumpToTabHandler
  onRunWorkflow?: () => void
}

export function WorkflowsView({ onClose, onJumpToTab, onRunWorkflow }: WorkflowsViewProps): JSX.Element {
  const [tab, setTab] = useState<WorkflowsTab>('runs')
  const [now, setNow] = useState(() => Date.now())
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null)
  const [selectedAttemptId, setSelectedAttemptId] = useState<string | null>(null)
  const [returnFocusRunId, setReturnFocusRunId] = useState<string | null>(null)
  const { active, recent } = useAppState((s) => selectRunLists(s.workflows.runs))
  const hasActive = active.length > 0

  useEffect(() => {
    if (!hasActive) return
    setNow(Date.now())
    const timer = setInterval(() => setNow(Date.now()), ELAPSED_TICK_MS)
    return () => clearInterval(timer)
  }, [hasActive])

  const needsYou = useMemo(() => <NeedsYouGroup onJumpToTab={onJumpToTab} />, [onJumpToTab])

  const openRun = useCallback((runId: string) => {
    setSelectedRunId(runId)
    setSelectedAttemptId(null)
    setReturnFocusRunId(null)
  }, [])

  const closeRun = useCallback(() => {
    setReturnFocusRunId(selectedRunId)
    setSelectedRunId(null)
    setSelectedAttemptId(null)
  }, [selectedRunId])

  const changeTab = useCallback((next: WorkflowsTab) => {
    setTab(next)
    setSelectedRunId(null)
    setSelectedAttemptId(null)
    setReturnFocusRunId(null)
  }, [])

  const clearReturnFocus = useCallback(() => setReturnFocusRunId(null), [])

  return (
    <WorkflowsSection tab={tab} onTabChange={changeTab} onClose={onClose}>
      {tab === 'runs' &&
        (selectedRunId ? (
          <RunDetailContainer
            key={selectedRunId}
            runId={selectedRunId}
            now={now}
            selectedAttemptId={selectedAttemptId}
            onSelectAttempt={setSelectedAttemptId}
            onBack={closeRun}
            onJumpToTab={onJumpToTab}
          />
        ) : (
          <RunsTab
            needsYou={needsYou}
            activeIds={active}
            recentIds={recent}
            now={now}
            onOpenRun={openRun}
            focusRunId={returnFocusRunId}
            onFocused={clearReturnFocus}
            onRunWorkflow={onRunWorkflow}
          />
        ))}
    </WorkflowsSection>
  )
}
