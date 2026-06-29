import { MockTatsu, type MockTatsuState } from './MockTatsu'

const STATIC_STATE: MockTatsuState = {
  activeWorktreeId: 'wt-1',
  highlightedElement: null,
  panelMode: 'terminal',
  rightPanelOpen: true,
  mergedClosedCount: 3,
  worktrees: [
    {
      id: 'wt-1',
      branch: 'feat/realtime-presence',
      path: 'tatsu/feat-realtime-presence',
      status: 'needs-approval',
      pr: {
        checks: 'success',
        additions: 142,
        deletions: 12
      }
    },
    {
      id: 'wt-2',
      branch: 'bug/login-flash',
      path: 'tatsu/bug-login-flash',
      status: 'processing',
      pr: {
        checks: 'pending',
        additions: 24,
        deletions: 8
      }
    },
    {
      id: 'wt-3',
      branch: 'refactor/types',
      path: 'tatsu/refactor-types',
      status: 'idle'
    },
    {
      id: 'wt-4',
      branch: 'main',
      path: 'tatsu/main',
      status: 'merged',
      pr: {
        checks: 'success',
        additions: 0,
        deletions: 0
      }
    }
  ]
}

export function ProductVisual() {
  return (
    <section className="py-12 md:py-20">
      <div className="max-w-6xl mx-auto px-6">
        <div className="relative rounded-xl border border-border-strong bg-app overflow-hidden glow-amber h-[360px] md:h-[68vh] md:min-h-[560px] md:max-h-[760px]">
          <MockTatsu state={STATIC_STATE} />
        </div>
      </div>
    </section>
  )
}
