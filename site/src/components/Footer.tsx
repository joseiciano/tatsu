export function Footer() {
  return (
    <footer className="border-t border-[#292524]">
      <div className="max-w-6xl mx-auto px-6 py-10 flex flex-col md:flex-row items-center justify-between gap-4 text-sm text-[#78716c]">
        <div className="flex items-center gap-2">
          <div className="w-5 h-5 rounded clay-gradient-bg flex items-center justify-center text-white font-extrabold text-[10px]">
            T
          </div>
          <span>Tatsu · Open source · MIT</span>
        </div>
        <div className="flex items-center gap-6">
          <a href="/guide.html" className="hover:text-[#d6d3d1] transition-colors">Guide</a>
          <a href="/releases.html" className="hover:text-[#d6d3d1] transition-colors">Release notes</a>
          <a href="https://github.com/frenchie4111/harness" className="hover:text-[#d6d3d1] transition-colors">GitHub</a>
          <a href="https://github.com/frenchie4111/harness/releases" className="hover:text-[#d6d3d1] transition-colors">Downloads</a>
        </div>
      </div>
    </footer>
  )
}
