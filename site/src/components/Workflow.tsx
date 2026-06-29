const steps = [
  {
    number: '01',
    title: 'Add your repo',
    description: 'Open a repository and Tatsu discovers existing worktrees or creates your first one.',
  },
  {
    number: '02',
    title: 'Spawn agents',
    description: 'Launch Claude Code, Opencode, or Codex in dedicated worktrees. Each gets its own isolated folder.',
  },
  {
    number: '03',
    title: 'Watch the sidebar',
    description: 'Status dots show which agents are working, waiting for input, or need approval. Jump to the one that needs you.',
  },
  {
    number: '04',
    title: 'Review & ship',
    description: 'Scan diffs in the changed-files panel, check CI status, open PRs, and delete worktrees when done.',
  },
]

export function Workflow() {
  return (
    <section id="workflow" className="py-20 md:py-28">
      <div className="max-w-6xl mx-auto px-6">
        <div className="text-center mb-16">
          <div className="text-xs uppercase tracking-widest text-[#78716c] mb-4">How it works</div>
          <h2 className="text-4xl md:text-5xl font-extrabold tracking-tight mb-4">
            From repo to <span className="gradient-text">running agents.</span>
          </h2>
          <p className="text-lg text-[#a8a29e] max-w-xl mx-auto">
            Four steps to parallel agent workflows that actually stay organized.
          </p>
        </div>

        <div className="grid md:grid-cols-2 lg:grid-cols-4 gap-6">
          {steps.map((step, i) => (
            <div key={step.number} className="relative">
              <div className="text-5xl font-extrabold text-[#292524] mb-4">{step.number}</div>
              <h3 className="text-lg font-semibold text-[#fafaf9] mb-2">{step.title}</h3>
              <p className="text-sm text-[#a8a29e] leading-relaxed">{step.description}</p>
              {i < steps.length - 1 && (
                <div className="hidden lg:block absolute top-8 left-full w-full h-px bg-gradient-to-r from-[#44403c] to-transparent" />
              )}
            </div>
          ))}
        </div>
      </div>
    </section>
  )
}
