import { useEffect, useMemo, useState } from 'react'
import { useAppState } from '../../../store'
import { NeedsYouGroup, type JumpToTabHandler } from '../NeedsYou'
import { createRunListsSelector } from '../run-card-model'
import { RunsTab } from './RunsTab'
import { WorkflowsSection, type WorkflowsTab } from './WorkflowsSection'

const ELAPSED_TICK_MS = 1000

const selectRunLists = createRunListsSelector()

export interface WorkflowsViewProps {
  onClose: () => void
  onJumpToTab?: JumpToTabHandler
}

export function WorkflowsView({ onClose, onJumpToTab }: WorkflowsViewProps): JSX.Element {
  const [tab, setTab] = useState<WorkflowsTab>('runs')
  const [now, setNow] = useState(() => Date.now())
  const { active, recent } = useAppState((s) => selectRunLists(s.workflows.runs))
  const hasActive = active.length > 0

  useEffect(() => {
    if (!hasActive) return
    setNow(Date.now())
    const timer = setInterval(() => setNow(Date.now()), ELAPSED_TICK_MS)
    return () => clearInterval(timer)
  }, [hasActive])

  const needsYou = useMemo(() => <NeedsYouGroup onJumpToTab={onJumpToTab} />, [onJumpToTab])

  return (
    <WorkflowsSection tab={tab} onTabChange={setTab} onClose={onClose}>
      {tab === 'runs' && <RunsTab needsYou={needsYou} activeIds={active} recentIds={recent} now={now} />}
    </WorkflowsSection>
  )
}
