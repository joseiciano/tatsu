import { useState, useCallback } from 'react'
import { ChevronLeft, ChevronRight } from 'lucide-react'

interface Section {
  eyebrow: string
  title: string
  body: string
  bonus?: string
}

const SECTIONS: Section[] = [
  {
    eyebrow: 'Parallel sessions',
    title: 'All your agents in one place.',
    body: 'Every agent is its own git branch, its own folder, its own Claude (or Codex!). Kick off five tasks, switch between them in a keystroke, and never worry about two agents fighting over the same file.'
  },
  {
    eyebrow: 'Reliable status',
    title: 'See which agent needs attention at a glance.',
    body: 'Glancing at the sidebar tells you which agents need your attention. The second an agent is waiting on approval, the row lights up red and jumps the queue.'
  },
  {
    eyebrow: 'New worktree in a click',
    title: 'Start new work instantly.',
    body: 'Spawn a fresh agent from the sidebar. Harness manages the full lifecycle of the git worktree, so you never even have to learn the commands.',
    bonus: 'Bonus: Agents can create new worktrees themselves through the Harness MCP. Just ask!'
  },
  {
    eyebrow: 'Everything in one UI',
    title: 'Everything about the worktree, one keystroke away.',
    body: 'Pull request status, branch commits, changed-file review, and any file opened in an embedded editor. All right there next to Claude. Review what shipped without leaving Harness.'
  }
]

export function ScrollDiorama() {
  const [activeIndex, setActiveIndex] = useState(0)

  const goTo = useCallback((index: number) => {
    setActiveIndex(Math.max(0, Math.min(SECTIONS.length - 1, index)))
  }, [])

  const goPrev = useCallback(() => goTo(activeIndex - 1), [activeIndex, goTo])
  const goNext = useCallback(() => goTo(activeIndex + 1), [activeIndex, goTo])

  return (
    <section id="diorama" className="diorama-bg py-16 md:py-24">
      <div className="max-w-6xl mx-auto px-6">
        <div className="relative">
          <div className="overflow-hidden">
            <div
              className="flex transition-transform duration-500 ease-out"
              style={{ transform: `translateX(-${activeIndex * 100}%)` }}
            >
              {SECTIONS.map((s, i) => (
                <div
                  key={i}
                  className="w-full flex-shrink-0 px-2 md:px-4"
                  role="group"
                  aria-roledescription="slide"
                  aria-label={`${i + 1} of ${SECTIONS.length}`}
                >
                  <div className="max-w-2xl mx-auto">
                    <div className="bg-[#1c1917] border border-[#44403c] rounded-xl p-8 md:p-12 min-h-[360px] md:min-h-[420px] flex flex-col justify-center text-center">
                      <div className="text-xs uppercase tracking-[0.2em] text-[#fbbf24]/80 font-semibold mb-4">
                        {s.eyebrow}
                      </div>
                      <h2 className="text-3xl md:text-4xl font-bold tracking-tight leading-[1.1] mb-5 text-[#fafaf9]">
                        {s.title}
                      </h2>
                      <p className="text-base md:text-lg text-[#a8a29e] leading-relaxed mb-3">
                        {s.body}
                      </p>
                      {s.bonus && (
                        <p className="text-sm text-[#78716c] leading-relaxed">
                          <span className="text-[#fbbf24]/80 font-semibold">Bonus:</span>{' '}
                          {s.bonus.replace(/^Bonus:\s*/, '')}
                        </p>
                      )}
                      {/* <MockHarness state={mockState} /> */}
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </div>

          <button
            onClick={goPrev}
            disabled={activeIndex === 0}
            className="absolute left-0 top-1/2 -translate-y-1/2 -translate-x-2 md:-translate-x-4 p-2 rounded-full bg-[#292524]/80 text-[#a8a29e] hover:bg-[#44403c] hover:text-[#fafaf9] disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
            aria-label="Previous slide"
          >
            <ChevronLeft className="w-5 h-5" />
          </button>
          <button
            onClick={goNext}
            disabled={activeIndex === SECTIONS.length - 1}
            className="absolute right-0 top-1/2 -translate-y-1/2 translate-x-2 md:translate-x-4 p-2 rounded-full bg-[#292524]/80 text-[#a8a29e] hover:bg-[#44403c] hover:text-[#fafaf9] disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
            aria-label="Next slide"
          >
            <ChevronRight className="w-5 h-5" />
          </button>
        </div>

        <div className="flex justify-center gap-2 mt-10" role="tablist" aria-label="Carousel slides">
          {SECTIONS.map((_, i) => (
            <button
              key={i}
              onClick={() => goTo(i)}
              role="tab"
              aria-selected={i === activeIndex}
              aria-label={`Go to slide ${i + 1}`}
              className={`w-2.5 h-2.5 rounded-full transition-colors ${
                i === activeIndex ? 'bg-[#fbbf24]' : 'bg-[#44403c] hover:bg-[#57534e]'
              }`}
            />
          ))}
        </div>
      </div>
    </section>
  )
}
