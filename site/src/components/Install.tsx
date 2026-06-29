export function Install() {
  return (
    <section id="install" className="py-20 md:py-28">
      <div className="max-w-3xl mx-auto px-6 text-center">
        <div className="p-8 md:p-12 rounded-2xl bg-[#1c1917] border border-[#44403c]">
          <h2 className="text-3xl md:text-4xl font-extrabold tracking-tight mb-4">
            Ready to run <span className="text-[#f59e0b]">parallel agents?</span>
          </h2>
          <p className="text-[#a8a29e] mb-8 max-w-md mx-auto">
            Download the macOS app or run the headless server on Linux.
          </p>

          <div className="flex flex-col sm:flex-row items-center justify-center gap-4 mb-8">
            <a
              href="https://github.com/frenchie4111/harness/releases"
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-2 px-8 py-3.5 bg-[#f59e0b] text-[#0c0a09] rounded-lg font-semibold hover:bg-[#fbbf24] transition-colors w-full sm:w-auto justify-center"
            >
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
              Download for macOS
            </a>
            <a
              href="https://github.com/frenchie4111/harness/releases"
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-2 px-8 py-3.5 bg-[#292524] border border-[#44403c] text-[#fafaf9] rounded-lg font-semibold hover:bg-[#44403c] hover:border-[#57534e] transition-colors w-full sm:w-auto justify-center"
            >
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
              Linux (.deb / AppImage)
            </a>
          </div>

          <div className="text-left bg-[#0c0a09] rounded-lg border border-[#292524] p-4 font-mono text-xs text-[#a8a29e] overflow-x-auto">
            <div className="flex items-center gap-2 mb-2 text-[#78716c]">
              <span className="w-2 h-2 rounded-full bg-[#ef4444]/70" />
              <span className="w-2 h-2 rounded-full bg-[#fbbf24]/70" />
              <span className="w-2 h-2 rounded-full bg-[#22c55e]/70" />
              <span className="ml-2">terminal</span>
            </div>
            <code className="text-[#d6d3d1]">
              <span className="text-[#78716c]"># Headless server</span>
              <br />
              <span className="text-[#fbbf24]">$</span> npm install -g tatsu
              <br />
              <span className="text-[#fbbf24]">$</span> tatsu-server --port 8080
            </code>
          </div>
        </div>
      </div>
    </section>
  )
}
