import { useMemo } from 'react'
import { detectLanguage, highlightLine } from '../../syntax'
import { GUTTER_STYLES, LINE_STYLES, parseDiff } from '../DiffView'

export function CodeDiffHunks({ patch, filePath }: { patch: string; filePath: string }): JSX.Element {
  const lines = useMemo(() => parseDiff(patch), [patch])
  const language = detectLanguage(filePath)

  return (
    <div className="absolute inset-0 overflow-auto bg-app">
      <div className="font-mono text-xs leading-5 min-w-fit">
        {lines.map((line, i) => (
          <div key={i} className={`flex ${LINE_STYLES[line.type]}`}>
            <span className={`shrink-0 w-12 text-right pr-2 select-none tabular-nums ${GUTTER_STYLES[line.type]}`}>
              {line.type === 'remove' || line.type === 'context' ? line.oldLine : ''}
            </span>
            <span
              className={`shrink-0 w-12 text-right pr-2 select-none tabular-nums border-r border-border/50 ${GUTTER_STYLES[line.type]}`}
            >
              {line.type === 'add' || line.type === 'context' ? line.newLine : ''}
            </span>
            <span className="shrink-0 w-5 text-center select-none">
              {line.type === 'add' ? '+' : line.type === 'remove' ? '-' : ''}
            </span>
            <span
              className="whitespace-pre pr-4 hljs"
              dangerouslySetInnerHTML={{
                __html: highlightLine(line.content, line.type === 'hunk' ? null : language)
              }}
            />
          </div>
        ))}
      </div>
    </div>
  )
}
