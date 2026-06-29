export function ProductVisual() {
  return (
    <section className="py-12 md:py-20">
      <div className="max-w-6xl mx-auto px-6">
        <div className="relative rounded-xl border border-[#44403c] bg-[#1c1917] overflow-hidden glow-amber">
          {/* Window chrome */}
          <div className="h-9 bg-[#292524] border-b border-[#44403c] flex items-center gap-2 px-4">
            <span className="w-3 h-3 rounded-full bg-[#ef4444]/70" />
            <span className="w-3 h-3 rounded-full bg-[#fbbf24]/70" />
            <span className="w-3 h-3 rounded-full bg-[#22c55e]/70" />
            <span className="ml-4 text-xs text-[#78716c] font-mono">Tatsu</span>
          </div>

          <div className="flex flex-col md:flex-row" style={{ minHeight: '24rem' }}>
            {/* Sidebar */}
            <div className="w-full md:w-64 bg-[#1c1917] border-b md:border-b-0 md:border-r border-[#44403c] p-3 flex flex-col gap-2">
              <div className="flex items-center gap-2 px-2 py-1.5 rounded-md bg-[#292524]">
                <span className="w-2 h-2 rounded-full bg-[#22c55e]" />
                <span className="text-xs text-[#e7e5e4] font-mono truncate">feature/auth</span>
              </div>
              <div className="flex items-center gap-2 px-2 py-1.5 rounded-md hover:bg-[#292524]/50">
                <span className="w-2 h-2 rounded-full bg-[#fbbf24] pulse-dot" />
                <span className="text-xs text-[#a8a29e] font-mono truncate">bug/login-flash</span>
              </div>
              <div className="flex items-center gap-2 px-2 py-1.5 rounded-md hover:bg-[#292524]/50">
                <span className="w-2 h-2 rounded-full bg-[#22c55e]" />
                <span className="text-xs text-[#a8a29e] font-mono truncate">refactor/types</span>
              </div>
              <div className="flex items-center gap-2 px-2 py-1.5 rounded-md hover:bg-[#292524]/50">
                <span className="w-2 h-2 rounded-full bg-[#78716c]" />
                <span className="text-xs text-[#78716c] font-mono truncate">main</span>
              </div>
              <div className="mt-auto pt-3 border-t border-[#44403c]">
                <div className="text-[10px] text-[#78716c] uppercase tracking-wider px-2 mb-1">PR Status</div>
                <div className="px-2 py-1 text-xs text-[#a8a29e]">
                  <span className="text-[#22c55e]">●</span> 3 passing
                </div>
              </div>
            </div>

            {/* Main content */}
            <div className="flex-1 p-4 font-mono text-sm">
              <div className="flex items-center gap-3 mb-4 pb-3 border-b border-[#44403c]">
                <span className="px-2 py-0.5 rounded bg-[#292524] text-[#fbbf24] text-xs">Claude</span>
                <span className="px-2 py-0.5 rounded bg-[#292524] text-[#a8a29e] text-xs">Shell</span>
                <span className="px-2 py-0.5 rounded bg-[#292524] text-[#a8a29e] text-xs">Browser</span>
              </div>
              <div className="space-y-3 text-[#a8a29e]">
                <div className="flex gap-3">
                  <span className="text-[#78716c] shrink-0">$</span>
                  <span>claude --prompt "Refactor the auth middleware to use JWT"</span>
                </div>
                <div className="pl-6 text-[#d6d3d1]">
                  Working on <span className="text-[#fbbf24]">auth/middleware.ts</span>...
                </div>
                <div className="pl-6 text-[#d6d3d1]">
                  Updated 4 files. Ready for review.
                </div>
                <div className="flex gap-3 mt-4">
                  <span className="text-[#78716c] shrink-0">$</span>
                  <span className="caret-blink">_</span>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </section>
  )
}
