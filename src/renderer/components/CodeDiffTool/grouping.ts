import type { CodeDiffFile } from '../../../shared/code-diff'

export type ChangeTypeGroupKey = 'tests' | 'config' | 'api' | 'data' | 'ui' | 'other'

const GROUP_ORDER: ChangeTypeGroupKey[] = ['tests', 'config', 'api', 'data', 'ui', 'other']

export const CHANGE_TYPE_LABELS: Record<ChangeTypeGroupKey, string> = {
  tests: 'Tests',
  config: 'Config',
  api: 'API / routing',
  data: 'Data / models',
  ui: 'UI / views',
  other: 'Other'
}

const TEST_DIRS = new Set(['__tests__', 'test', 'tests'])
const CONFIG_EXTS = new Set(['json', 'yaml', 'yml', 'toml'])
const UI_EXTS = new Set(['tsx', 'jsx', 'css', 'scss'])
const API_WORDS = new Set(['api', 'apis', 'route', 'routes', 'router', 'routing', 'controller', 'controllers', 'handler', 'handlers'])
const DATA_WORDS = new Set(['model', 'models', 'schema', 'schemas', 'migration', 'migrations'])
const UI_WORDS = new Set(['component', 'components', 'view', 'views', 'page', 'pages'])

function words(path: string): string[] {
  return path
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean)
}

function hasWord(tokens: string[], set: Set<string>): boolean {
  return tokens.some((t) => set.has(t))
}

export function classifyChangeType(path: string): ChangeTypeGroupKey {
  const segments = path.split('/')
  const base = segments[segments.length - 1]
  const dirs = segments.slice(0, -1)
  const dot = base.lastIndexOf('.')
  const ext = dot > 0 ? base.slice(dot + 1).toLowerCase() : ''

  if (/\.(test|spec)\./.test(base) || dirs.some((d) => TEST_DIRS.has(d))) return 'tests'
  if (
    CONFIG_EXTS.has(ext) ||
    base.startsWith('.env') ||
    base.includes('.config.') ||
    (dirs.length === 0 && base.startsWith('.'))
  ) {
    return 'config'
  }
  const tokens = words(path)
  if (hasWord(tokens, API_WORDS)) return 'api'
  if (hasWord(tokens, DATA_WORDS) || base === 'types.ts' || base === 'types.d.ts') return 'data'
  if (UI_EXTS.has(ext) || hasWord(tokens, UI_WORDS)) return 'ui'
  return 'other'
}

export function groupByChangeType(
  files: CodeDiffFile[]
): Array<{ key: ChangeTypeGroupKey; label: string; files: CodeDiffFile[] }> {
  const buckets = new Map<ChangeTypeGroupKey, CodeDiffFile[]>()
  for (const file of files) {
    const key = classifyChangeType(file.path)
    const list = buckets.get(key)
    if (list) list.push(file)
    else buckets.set(key, [file])
  }
  return GROUP_ORDER.filter((key) => buckets.has(key)).map((key) => ({
    key,
    label: CHANGE_TYPE_LABELS[key],
    files: buckets.get(key)!.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
  }))
}

export function stepFile(groups: Array<{ files: CodeDiffFile[] }>, selected: string | null, delta: number): string | null {
  const flat = groups.flatMap((g) => g.files)
  if (flat.length === 0) return null
  const idx = selected == null ? -1 : flat.findIndex((f) => f.path === selected)
  if (idx < 0) return flat[0].path
  return flat[Math.max(0, Math.min(flat.length - 1, idx + delta))].path
}

export function stepGroup(groups: Array<{ files: CodeDiffFile[] }>, selected: string | null, delta: number): string | null {
  const nonEmpty = groups.filter((g) => g.files.length > 0)
  if (nonEmpty.length === 0) return null
  const idx = selected == null ? -1 : nonEmpty.findIndex((g) => g.files.some((f) => f.path === selected))
  if (idx < 0) return nonEmpty[0].files[0].path
  return nonEmpty[Math.max(0, Math.min(nonEmpty.length - 1, idx + delta))].files[0].path
}
