import { describe, expect, it } from 'vitest'
import type { CodeDiffFile } from '../../../shared/code-diff'
import { classifyChangeType, groupByChangeType, stepFile, stepGroup } from './grouping'
import type { ChangeTypeGroupKey } from './grouping'

function file(path: string): CodeDiffFile {
  return { path, status: 'modified' }
}

describe('classifyChangeType', () => {
  const cases: Array<{ name: string; path: string; expected: ChangeTypeGroupKey }> = [
    { name: '.test. basename', path: 'src/util/math.test.ts', expected: 'tests' },
    { name: '.spec. basename', path: 'src/App.spec.tsx', expected: 'tests' },
    { name: '__tests__ directory', path: 'src/foo/__tests__/x.ts', expected: 'tests' },
    { name: 'test directory', path: 'test/helpers.ts', expected: 'tests' },
    { name: 'nested tests directory', path: 'pkg/tests/fixtures.ts', expected: 'tests' },
    { name: 'tests beats api', path: 'src/api.test.ts', expected: 'tests' },
    { name: 'tests beats data', path: 'src/models/schema.test.ts', expected: 'tests' },
    { name: 'testing dir is not a tests segment', path: 'src/testing/math.ts', expected: 'other' },
    { name: 'test token in basename is not a tests dir', path: 'src/test.ts', expected: 'other' },

    { name: '.json', path: 'package.json', expected: 'config' },
    { name: '.yaml', path: 'deploy/app.yaml', expected: 'config' },
    { name: '.yml', path: '.github/workflows/ci.yml', expected: 'config' },
    { name: '.toml', path: 'crates/core/Cargo.toml', expected: 'config' },
    { name: '.env prefix at root', path: '.env.local', expected: 'config' },
    { name: '.env prefix nested', path: 'apps/web/.env.production', expected: 'config' },
    { name: '.config. basename', path: 'vite.config.ts', expected: 'config' },
    { name: 'nested .config. basename', path: 'apps/web/tailwind.config.js', expected: 'config' },
    { name: 'root dotfile', path: '.gitignore', expected: 'config' },
    { name: 'nested dotfile is not root dotfile', path: 'src/.hidden', expected: 'other' },
    { name: 'config beats api', path: 'src/api/openapi.json', expected: 'config' },
    { name: 'config beats ui', path: 'src/components/manifest.json', expected: 'config' },

    { name: 'api directory', path: 'src/api/client.ts', expected: 'api' },
    { name: 'routes directory', path: 'src/routes/index.ts', expected: 'api' },
    { name: 'camelCase controller basename', path: 'src/userController.ts', expected: 'api' },
    { name: 'kebab-case routes basename', path: 'src/user-routes.ts', expected: 'api' },
    { name: 'snake_case handler basename', path: 'server/webhook_handler.py', expected: 'api' },
    { name: 'router basename', path: 'src/router.ts', expected: 'api' },
    { name: 'api beats data types.ts', path: 'src/api/types.ts', expected: 'api' },
    { name: 'api beats ui extension', path: 'src/api/Button.tsx', expected: 'api' },
    { name: 'no substring match on api', path: 'src/capital.ts', expected: 'other' },
    { name: 'no substring match on apiary', path: 'src/apiary.ts', expected: 'other' },
    { name: 'no substring match on route', path: 'src/routeless/x.ts', expected: 'other' },

    { name: 'models directory', path: 'src/models/user.ts', expected: 'data' },
    { name: 'migrations directory', path: 'src/db/migrations/001.sql', expected: 'data' },
    { name: 'camelCase schema basename', path: 'src/userSchema.ts', expected: 'data' },
    { name: 'types.ts basename', path: 'src/shared/state/types.ts', expected: 'data' },
    { name: 'types.d.ts basename', path: 'src/env/types.d.ts', expected: 'data' },
    { name: 'mytypes.ts is not types.ts', path: 'src/mytypes.ts', expected: 'other' },
    { name: 'data beats ui extension', path: 'src/models/Card.tsx', expected: 'data' },

    { name: '.tsx', path: 'src/App.tsx', expected: 'ui' },
    { name: '.jsx', path: 'web/Widget.jsx', expected: 'ui' },
    { name: '.css', path: 'src/styles.css', expected: 'ui' },
    { name: '.scss', path: 'src/theme/base.scss', expected: 'ui' },
    { name: 'components directory', path: 'src/components/x.ts', expected: 'ui' },
    { name: 'views directory', path: 'src/views/home.ts', expected: 'ui' },
    { name: 'pages directory', path: 'site/pages/index.ts', expected: 'ui' },
    { name: 'camelCase view basename', path: 'src/settingsView.ts', expected: 'ui' },

    { name: 'plain util', path: 'src/util/math.ts', expected: 'other' },
    { name: 'root README', path: 'README.md', expected: 'other' },
  ]

  it.each(cases)('$name: $path -> $expected', ({ path, expected }) => {
    expect(classifyChangeType(path)).toBe(expected)
  })
})

describe('groupByChangeType', () => {
  it('returns groups in fixed order with labels, omitting empty groups', () => {
    const groups = groupByChangeType([
      file('src/util/math.ts'),
      file('src/App.tsx'),
      file('src/api/client.ts'),
      file('src/foo.test.ts'),
    ])
    expect(groups.map((g) => ({ key: g.key, label: g.label }))).toEqual([
      { key: 'tests', label: 'Tests' },
      { key: 'api', label: 'API / routing' },
      { key: 'ui', label: 'UI / views' },
      { key: 'other', label: 'Other' },
    ])
  })

  it('labels every group kind', () => {
    const groups = groupByChangeType([
      file('src/util/math.ts'),
      file('src/App.tsx'),
      file('src/models/user.ts'),
      file('src/api/client.ts'),
      file('package.json'),
      file('src/foo.test.ts'),
    ])
    expect(groups.map((g) => [g.key, g.label])).toEqual([
      ['tests', 'Tests'],
      ['config', 'Config'],
      ['api', 'API / routing'],
      ['data', 'Data / models'],
      ['ui', 'UI / views'],
      ['other', 'Other'],
    ])
  })

  it('sorts files by path inside each group and preserves the file objects', () => {
    const b = file('src/util/b.ts')
    const a = file('src/util/a.ts')
    const c = file('lib/c.ts')
    const groups = groupByChangeType([b, a, c])
    expect(groups).toHaveLength(1)
    expect(groups[0].key).toBe('other')
    expect(groups[0].files).toEqual([c, a, b])
    expect(groups[0].files[0]).toBe(c)
  })

  it('places every input file in exactly one group', () => {
    const input = [
      file('src/App.tsx'),
      file('src/api/types.ts'),
      file('src/api.test.ts'),
      file('.gitignore'),
      file('src/shared/state/types.ts'),
      file('src/util/math.ts'),
    ]
    const groups = groupByChangeType(input)
    const flat = groups.flatMap((g) => g.files.map((f) => f.path))
    expect(flat.slice().sort()).toEqual(input.map((f) => f.path).sort())
    expect(groups.find((g) => g.key === 'api')?.files.map((f) => f.path)).toEqual(['src/api/types.ts'])
  })

  it('returns no groups for no files', () => {
    expect(groupByChangeType([])).toEqual([])
  })
})

describe('stepFile', () => {
  const groups = [
    { files: [file('t/a.test.ts'), file('t/b.test.ts')] },
    { files: [file('x/c.ts')] },
  ]

  const cases: Array<{ name: string; selected: string | null; delta: number; expected: string | null }> = [
    { name: 'null selection -> first file', selected: null, delta: 1, expected: 't/a.test.ts' },
    { name: 'null selection with negative delta -> first file', selected: null, delta: -1, expected: 't/a.test.ts' },
    { name: 'unknown selection -> first file', selected: 'gone.ts', delta: 1, expected: 't/a.test.ts' },
    { name: 'next within group', selected: 't/a.test.ts', delta: 1, expected: 't/b.test.ts' },
    { name: 'next crosses group boundary', selected: 't/b.test.ts', delta: 1, expected: 'x/c.ts' },
    { name: 'previous crosses group boundary', selected: 'x/c.ts', delta: -1, expected: 't/b.test.ts' },
    { name: 'clamps at last file', selected: 'x/c.ts', delta: 1, expected: 'x/c.ts' },
    { name: 'clamps at first file', selected: 't/a.test.ts', delta: -1, expected: 't/a.test.ts' },
    { name: 'large delta clamps to last', selected: 't/a.test.ts', delta: 10, expected: 'x/c.ts' },
    { name: 'large negative delta clamps to first', selected: 'x/c.ts', delta: -10, expected: 't/a.test.ts' },
  ]

  it.each(cases)('$name', ({ selected, delta, expected }) => {
    expect(stepFile(groups, selected, delta)).toBe(expected)
  })

  it('returns null when there are no files', () => {
    expect(stepFile([], null, 1)).toBeNull()
    expect(stepFile([{ files: [] }], 'a.ts', 1)).toBeNull()
  })
})

describe('stepGroup', () => {
  const groups = [
    { files: [file('t/a.test.ts'), file('t/b.test.ts')] },
    { files: [file('api/c.ts'), file('api/d.ts')] },
    { files: [file('x/e.ts')] },
  ]

  const cases: Array<{ name: string; selected: string | null; delta: number; expected: string | null }> = [
    { name: 'null selection -> first file of first group', selected: null, delta: 1, expected: 't/a.test.ts' },
    { name: 'next group from first file', selected: 't/a.test.ts', delta: 1, expected: 'api/c.ts' },
    { name: 'next group from non-first file', selected: 't/b.test.ts', delta: 1, expected: 'api/c.ts' },
    { name: 'previous group from middle group', selected: 'api/d.ts', delta: -1, expected: 't/a.test.ts' },
    { name: 'previous group from last group', selected: 'x/e.ts', delta: -1, expected: 'api/c.ts' },
    { name: 'clamps at last group', selected: 'x/e.ts', delta: 1, expected: 'x/e.ts' },
    { name: 'clamps at first group to its first file', selected: 't/b.test.ts', delta: -1, expected: 't/a.test.ts' },
  ]

  it.each(cases)('$name', ({ selected, delta, expected }) => {
    expect(stepGroup(groups, selected, delta)).toBe(expected)
  })

  it('clamps at last group to its first file when selection is not first', () => {
    const twoInLast = [{ files: [file('a.ts')] }, { files: [file('b.ts'), file('c.ts')] }]
    expect(stepGroup(twoInLast, 'c.ts', 1)).toBe('b.ts')
  })

  it('returns null when there are no files', () => {
    expect(stepGroup([], null, 1)).toBeNull()
    expect(stepGroup([], 'a.ts', -1)).toBeNull()
  })
})
