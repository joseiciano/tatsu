import { sha256Hex } from '../sha256'

export const INLINE_FRAGMENT_SHA_LENGTH = 12

export type InlineFragmentErrorCode =
  | 'unknown-fragment'
  | 'nested-fragment'
  | 'unbalanced-marker'
  | 'misplaced-placeholder'

export interface InlineFragmentError {
  code: InlineFragmentErrorCode
  name?: string
  line: number
  message: string
}

export interface InlineFragmentExpansion {
  /** The input unchanged when it has no placeholders or markers, or when
   *  any error was found. */
  content: string
  /** Every fragment named by a placeholder or a marker, sorted. */
  fragments: string[]
  /** Fragments with a marked section whose text no longer matches the
   *  hash Tatsu wrote, sorted. Those sections are kept as they are. */
  edited: string[]
  errors: InlineFragmentError[]
}

export type InlineFragmentResolution = 'overwrite' | 'detach' | 'keep-edit'

export interface InlineFragmentResolutionResult {
  content: string
  /** Set for 'keep-edit': the edited text to store as the fragment. */
  fragmentContent?: string
}

const PLACEHOLDER_LINE = /^[ \t]*\{\{fragment:([^{}\s]+)\}\}[ \t]*$/
const PLACEHOLDER_ANYWHERE = /(^|[^\\])\{\{fragment:/
const OPEN_MARKER = /^<!--\s*tatsu:fragment\s+(\S+)\s+sha=([0-9a-f]+)\s*-->$/
const CLOSE_MARKER = /^<!--\s*\/tatsu:fragment\s+(\S+)\s*-->$/
const ANY_MARKER = /<!--\s*\/?tatsu:fragment\b/
const FENCE = /^ {0,3}(`{3,}|~{3,})/
const INLINE_CODE = /(`+)[^`]*?\1/g

type Token =
  | { type: 'line'; text: string }
  | { type: 'placeholder'; name: string; line: number }
  | { type: 'region'; name: string; sha: string; body: string; lines: string[]; line: number }

interface Scan {
  bom: string
  tokens: Token[]
  errors: InlineFragmentError[]
}

function normalizeNewlines(value: string): string {
  return value.replace(/\r\n?/g, '\n')
}

function section(value: string): string {
  return normalizeNewlines(value).replace(/^\n+/, '').replace(/\s+$/, '')
}

function shortHash(body: string): string {
  return sha256Hex(section(body)).slice(0, INLINE_FRAGMENT_SHA_LENGTH)
}

function mentionsInlineFragments(content: string): boolean {
  return content.includes('{{fragment:') || ANY_MARKER.test(content)
}

function regionLines(name: string, content: string): string[] {
  const body = section(content)
  return [
    `<!-- tatsu:fragment ${name} sha=${shortHash(body)} -->`,
    ...(body.length > 0 ? body.split('\n') : []),
    `<!-- /tatsu:fragment ${name} -->`
  ]
}

function frontmatterEnd(lines: string[]): number {
  if (lines[0] !== '---') return 0
  const close = lines.indexOf('---', 1)
  return close === -1 ? 0 : close + 1
}

function scan(content: string): Scan {
  const bom = content.startsWith('\uFEFF') ? '\uFEFF' : ''
  const lines = normalizeNewlines(content.slice(bom.length)).split('\n')
  const tokens: Token[] = []
  const errors: InlineFragmentError[] = []
  const bodyStart = frontmatterEnd(lines)
  for (let i = 0; i < bodyStart; i += 1) tokens.push({ type: 'line', text: lines[i] })

  let fence: string | null = null
  for (let i = bodyStart; i < lines.length; i += 1) {
    const text = lines[i]
    const fenceMatch = FENCE.exec(text)
    if (fence !== null) {
      if (fenceMatch && fenceMatch[1][0] === fence[0] && fenceMatch[1].length >= fence.length) fence = null
      tokens.push({ type: 'line', text })
      continue
    }
    if (fenceMatch) {
      fence = fenceMatch[1]
      tokens.push({ type: 'line', text })
      continue
    }

    const open = OPEN_MARKER.exec(text)
    if (open) {
      const name = open[1]
      let close = -1
      for (let j = i + 1; j < lines.length; j += 1) {
        if (OPEN_MARKER.test(lines[j])) break
        const closeMatch = CLOSE_MARKER.exec(lines[j])
        if (closeMatch) {
          if (closeMatch[1] === name) close = j
          break
        }
      }
      if (close === -1) {
        errors.push({
          code: 'unbalanced-marker',
          name,
          line: i + 1,
          message: `The section for fragment "${name}" on line ${i + 1} has no matching end marker`
        })
        tokens.push({ type: 'line', text })
        continue
      }
      const sectionLines = lines.slice(i + 1, close)
      tokens.push({
        type: 'region',
        name,
        sha: open[2],
        body: sectionLines.join('\n'),
        lines: lines.slice(i, close + 1),
        line: i + 1
      })
      i = close
      continue
    }

    const stray = CLOSE_MARKER.exec(text)
    if (stray) {
      errors.push({
        code: 'unbalanced-marker',
        name: stray[1],
        line: i + 1,
        message: `The end marker for fragment "${stray[1]}" on line ${i + 1} has no matching start marker`
      })
      tokens.push({ type: 'line', text })
      continue
    }

    const placeholder = PLACEHOLDER_LINE.exec(text)
    if (placeholder) {
      tokens.push({ type: 'placeholder', name: placeholder[1], line: i + 1 })
      continue
    }
    if (PLACEHOLDER_ANYWHERE.test(text.replace(INLINE_CODE, ''))) {
      errors.push({
        code: 'misplaced-placeholder',
        line: i + 1,
        message: `The fragment placeholder on line ${i + 1} must be on a line of its own`
      })
    }
    tokens.push({ type: 'line', text })
  }
  return { bom, tokens, errors }
}

function join(bom: string, lines: string[]): string {
  return bom + lines.join('\n')
}

/** Lists the fragments a file names through placeholders or markers. */
export function inlineFragmentNames(content: string): string[] {
  if (!mentionsInlineFragments(content)) return []
  const names = new Set<string>()
  for (const token of scan(content).tokens) {
    if (token.type !== 'line') names.add(token.name)
  }
  return [...names].sort()
}

/** Pure and idempotent: replaces each `{{fragment:name}}` line with a
 *  marked section holding the fragment, and refreshes marked sections
 *  whose fragment changed. A section edited by hand is kept and reported
 *  in `edited`. Frontmatter and fenced code blocks are never touched. */
export function expandInlineFragments(
  content: string,
  fragments: ReadonlyMap<string, string>
): InlineFragmentExpansion {
  if (!mentionsInlineFragments(content)) return { content, fragments: [], edited: [], errors: [] }
  const { bom, tokens, errors } = scan(content)
  const names = new Set<string>()
  const edited = new Set<string>()
  const output: string[] = []
  const nested = new Set<string>()

  const fragmentFor = (name: string, line: number): string | null => {
    names.add(name)
    const value = fragments.get(name)
    if (value === undefined) {
      errors.push({ code: 'unknown-fragment', name, line, message: `Unknown fragment "${name}" on line ${line}` })
      return null
    }
    if (mentionsInlineFragments(value) && !nested.has(name)) {
      nested.add(name)
      errors.push({
        code: 'nested-fragment',
        name,
        line,
        message: `Fragment "${name}" contains another fragment, which is not supported`
      })
      return null
    }
    return value
  }

  for (const token of tokens) {
    if (token.type === 'line') {
      output.push(token.text)
      continue
    }
    const value = fragmentFor(token.name, token.line)
    if (value === null) continue
    if (token.type === 'region' && shortHash(token.body) !== token.sha) {
      edited.add(token.name)
      output.push(...token.lines)
      continue
    }
    output.push(...regionLines(token.name, value))
  }

  const result = {
    fragments: [...names].sort(),
    edited: [...edited].sort(),
    errors: errors.sort((a, b) => a.line - b.line)
  }
  if (errors.length > 0) return { content, ...result }
  return { content: join(bom, output), ...result }
}

/** Settles every hand-edited section for one fragment. 'overwrite'
 *  restores the fragment text, 'detach' drops the markers and keeps the
 *  text, and 'keep-edit' returns the first edited text so the caller can
 *  save it as the fragment. Untouched sections are left as they are. */
export function resolveInlineFragmentEdit(
  content: string,
  name: string,
  resolution: InlineFragmentResolution,
  fragmentContent: string
): InlineFragmentResolutionResult {
  if (!mentionsInlineFragments(content)) return { content }
  const { bom, tokens } = scan(content)
  const output: string[] = []
  let kept: string | undefined
  for (const token of tokens) {
    if (token.type === 'line') {
      output.push(token.text)
      continue
    }
    if (token.type === 'placeholder') {
      output.push(`{{fragment:${token.name}}}`)
      continue
    }
    const isEdited = token.name === name && shortHash(token.body) !== token.sha
    if (!isEdited) {
      output.push(...token.lines)
      continue
    }
    if (resolution === 'overwrite') {
      output.push(...regionLines(name, fragmentContent))
    } else if (resolution === 'detach') {
      output.push(...token.lines.slice(1, -1))
    } else if (kept === undefined) {
      kept = section(token.body)
      output.push(...regionLines(name, kept))
    } else {
      output.push(...token.lines)
    }
  }
  const result: InlineFragmentResolutionResult = { content: join(bom, output) }
  if (kept !== undefined) result.fragmentContent = kept
  return result
}
