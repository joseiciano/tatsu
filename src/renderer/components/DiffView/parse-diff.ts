export interface DiffLine {
  type: 'add' | 'remove' | 'context' | 'header' | 'hunk'
  content: string
  oldLine?: number
  newLine?: number
  file?: string
}

export function parseDiff(raw: string): DiffLine[] {
  const lines: DiffLine[] = []
  let oldLine = 0
  let newLine = 0
  let currentFile: string | undefined

  for (const line of raw.split('\n')) {
    if (line.startsWith('+++ b/')) {
      currentFile = line.slice(6)
      lines.push({ type: 'header', content: line })
    } else if (line.startsWith('diff --git ')) {
      const match = line.match(/diff --git a\/(.+?) b\//)
      if (match) currentFile = match[1]
      lines.push({ type: 'header', content: line })
    } else if (
      line.startsWith('diff ') ||
      line.startsWith('index ') ||
      line.startsWith('---') ||
      line.startsWith('+++')
    ) {
      lines.push({ type: 'header', content: line })
    } else if (line.startsWith('@@')) {
      const match = line.match(/@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/)
      if (match) {
        oldLine = parseInt(match[1], 10)
        newLine = parseInt(match[2], 10)
      }
      lines.push({ type: 'hunk', content: line, file: currentFile })
    } else if (line.startsWith('+')) {
      lines.push({ type: 'add', content: line.slice(1), newLine, file: currentFile })
      newLine++
    } else if (line.startsWith('-')) {
      lines.push({ type: 'remove', content: line.slice(1), oldLine, file: currentFile })
      oldLine++
    } else if (line.startsWith(' ')) {
      lines.push({ type: 'context', content: line.slice(1), oldLine, newLine, file: currentFile })
      oldLine++
      newLine++
    }
  }

  return lines
}

export const LINE_STYLES: Record<DiffLine['type'], string> = {
  add: 'bg-success/15 text-success',
  remove: 'bg-danger/15 text-danger',
  context: 'text-muted',
  header: 'text-dim italic',
  hunk: 'text-info bg-info/10'
}

export const GUTTER_STYLES: Record<DiffLine['type'], string> = {
  add: 'text-success/70',
  remove: 'text-danger/70',
  context: 'text-faint',
  header: '',
  hunk: 'text-info/70'
}
