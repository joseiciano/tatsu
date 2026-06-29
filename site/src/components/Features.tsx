const features = [
  {
    icon: (
      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="2" y="3" width="20" height="14" rx="2" ry="2"/><line x1="8" y1="21" x2="16" y2="21"/><line x1="12" y1="17" x2="12" y2="21"/></svg>
    ),
    title: 'Multi-Agent Orchestration',
    description: 'Run Claude Code, Opencode, and Codex side by side. Each agent gets its own worktree, terminal, and chat pane.',
  },
  {
    icon: (
      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="16 18 22 12 16 6"/><polyline points="8 6 2 12 8 18"/></svg>
    ),
    title: 'Terminal + Chat + Browser',
    description: 'Every worktree supports multiple tab types. Spawn CLI agents, switch to native chat mode, or open a live browser pane.',
  },
  {
    icon: (
      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M12 2L2 7l10 5 10-5-10-5z"/><polyline points="2 17 12 22 22 17"/><polyline points="2 12 12 17 22 12"/></svg>
    ),
    title: 'Git Worktree Native',
    description: 'One-click worktree creation and deletion. Tatsu runs the git commands, installs dependencies, and wires up hooks automatically.',
  },
  {
    icon: (
      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/></svg>
    ),
    title: 'PR & CI Awareness',
    description: 'See open PR status, check runs, and merge state for every worktree. Sort by what needs your attention first.',
  },
  {
    icon: (
      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="2" y="3" width="20" height="14" rx="2" ry="2"/><line x1="8" y1="21" x2="16" y2="21"/><line x1="12" y1="17" x2="12" y2="21"/></svg>
    ),
    title: 'Headless & Remote',
    description: 'Run Tatsu as a headless server and connect from any browser. WebSocket transport with token auth and PWA support.',
  },
  {
    icon: (
      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z"/></svg>
    ),
    title: 'Real-Time Status Hooks',
    description: 'Agent-specific hooks report live status via NDJSON. Know at a glance which sessions are working, waiting, or need approval.',
  },
]

export function Features() {
  return (
    <section id="features" className="py-20 md:py-28">
      <div className="max-w-6xl mx-auto px-6">
        <div className="text-center mb-16">
          <div className="text-xs uppercase tracking-widest text-[#78716c] mb-4">Capabilities</div>
          <h2 className="text-4xl md:text-5xl font-extrabold tracking-tight mb-4">
            Built for <span className="gradient-text">parallel agents.</span>
          </h2>
          <p className="text-lg text-[#a8a29e] max-w-xl mx-auto">
            Everything you need to run a swarm of coding agents without losing your mind.
          </p>
        </div>

        <div className="grid md:grid-cols-2 lg:grid-cols-3 gap-4">
          {features.map((f) => (
            <div
              key={f.title}
              className="group p-6 rounded-xl bg-[#1c1917] border border-[#292524] hover:border-[#57534e] transition-colors"
            >
              <div className="w-10 h-10 rounded-lg bg-[#292524] border border-[#44403c] flex items-center justify-center text-[#fbbf24] mb-4 group-hover:bg-[#c67c5c]/10 group-hover:border-[#c67c5c]/30 transition-colors">
                {f.icon}
              </div>
              <h3 className="text-base font-semibold text-[#fafaf9] mb-2">{f.title}</h3>
              <p className="text-sm text-[#a8a29e] leading-relaxed">{f.description}</p>
            </div>
          ))}
        </div>
      </div>
    </section>
  )
}
