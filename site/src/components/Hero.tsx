export function Hero() {
  return (
    <section className="relative pt-32 pb-20 md:pt-40 md:pb-28 overflow-hidden">
      <div className="max-w-6xl mx-auto px-6 text-center">
        <div className="inline-flex items-center gap-2 px-3 py-1.5 rounded-full bg-[#292524] border border-[#44403c] text-xs text-[#d6d3d1] mb-8">
          <span className="w-1.5 h-1.5 rounded-full bg-[#f59e0b] pulse-dot" />
          Open source · macOS & Linux
        </div>

        <h1 className="text-5xl md:text-7xl font-extrabold tracking-tight mb-6 leading-[1.1]">
          Swarm Control Agents
          <br />
          across <span className="text-[#f59e0b]">every worktree.</span>
        </h1>

        <p className="text-lg md:text-xl text-[#a8a29e] max-w-2xl mx-auto mb-10 leading-relaxed">
          Tatsu is an Electron app for running multiple agentic CLI sessions in parallel
          across git worktrees. Claude Code, Opencode, Codex — one window, total control.
        </p>

        <div className="flex flex-col sm:flex-row items-center justify-center gap-4">
          <a
            href="#install"
            className="inline-flex items-center gap-2 px-8 py-3.5 bg-[#f59e0b] text-[#0c0a09] rounded-lg font-semibold hover:bg-[#fbbf24] transition-colors"
          >
            Download for macOS
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" /><polyline points="7 10 12 15 17 10" /><line x1="12" y1="15" x2="12" y2="3" /></svg>
          </a>
          <a
            href="https://github.com/frenchie4111/harness"
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-2 px-8 py-3.5 bg-[#1c1917] border border-[#44403c] text-[#fafaf9] rounded-lg font-semibold hover:bg-[#292524] hover:border-[#57534e] transition-colors"
          >
            View on GitHub
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M9 19c-5 1.5-5-2.5-7-3m14 6v-3.87a3.37 3.37 0 0 0-.94-2.61c3.14-.35 6.44-1.54 6.44-7A5.44 5.44 0 0 0 20 4.77 5.07 5.07 0 0 0 19.91 1S18.73.65 16 2.48a13.38 13.38 0 0 0-7 0C6.27.65 5.09 1 5.09 1A5.07 5.07 0 0 0 5 4.77a5.44 5.44 0 0 0-1.5 3.78c0 5.42 3.3 6.61 6.44 7A3.37 3.37 0 0 0 9 18.13V22" /></svg>
          </a>
        </div>
      </div>
    </section>
  )
}
