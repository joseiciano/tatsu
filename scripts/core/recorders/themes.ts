import { cpSync, existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { vi } from 'vitest'
import type { CustomTheme } from '../../../src/shared/state/settings'
import { resetPathsForTests } from '../../../src/main/paths'
import { AVAILABLE_THEMES, THEME_APP_BG } from '../../../src/main/persistence'
import { loadCustomThemes } from '../../../src/main/themes-loader'
import type { Recorder } from './types'

const THEMES_FIXTURES = fileURLToPath(new URL('../../../fixtures/core/themes', import.meta.url))

export interface ThemesCase {
  name: string
  customThemes?: CustomTheme[]
  logLines?: string[]
}

interface ThemesRecorded {
  customThemes: CustomTheme[]
  logLines: string[]
}

export function maskThemesLine(line: string): string {
  return line
    .replace(/^\[\d\d:\d\d:\d\d\.\d{3}\]/, '[<ts>]')
    .replace(/(: parse error — )[\s\S]*$/, '$1<message>')
}

function recordThemes({ name }: ThemesCase): ThemesRecorded {
  const dir = mkdtempSync(join(tmpdir(), 'tatsu-core-themes-'))
  const previous = process.env.HARNESS_DATA_DIR
  process.env.HARNESS_DATA_DIR = dir
  resetPathsForTests()
  const lines: string[] = []
  const spy = vi.spyOn(console, 'log').mockImplementation((line: unknown) => {
    if (typeof line === 'string' && /^\[[^\]]*\] \[themes\] /.test(line)) lines.push(line)
  })
  try {
    const source = join(THEMES_FIXTURES, name)
    if (existsSync(source)) {
      const themes = join(dir, 'themes')
      cpSync(source, themes, { recursive: true })
      const entries = readdirSync(themes)
      if (entries.join('\n') !== [...entries].sort().join('\n')) {
        throw new Error(`${name}: readdirSync order is not sorted order: ${JSON.stringify(entries)}`)
      }
    }
    const customThemes = loadCustomThemes()
    return { customThemes, logLines: lines.map(maskThemesLine) }
  } finally {
    spy.mockRestore()
    if (previous === undefined) delete process.env.HARNESS_DATA_DIR
    else process.env.HARNESS_DATA_DIR = previous
    resetPathsForTests()
    rmSync(dir, { recursive: true, force: true })
  }
}

export const themesRecorder: Recorder<ThemesCase, ThemesRecorded> = {
  path: join(THEMES_FIXTURES, 'expected.json'),
  record: recordThemes,
  recordedOf: ({ customThemes, logLines }) =>
    customThemes === undefined || logLines === undefined ? undefined : { customThemes, logLines },
  withRecorded: ({ name }, recorded) => ({ name, ...recorded })
}

export interface BuiltinCase {
  name: string
  availableThemes?: string[]
  themeAppBg?: Record<string, string>
}

interface BuiltinRecorded {
  availableThemes: string[]
  themeAppBg: Record<string, string>
}

export const builtinThemesRecorder: Recorder<BuiltinCase, BuiltinRecorded> = {
  path: join(THEMES_FIXTURES, 'builtin.json'),
  record: () => ({ availableThemes: [...AVAILABLE_THEMES], themeAppBg: { ...THEME_APP_BG } }),
  recordedOf: ({ availableThemes, themeAppBg }) =>
    availableThemes === undefined || themeAppBg === undefined ? undefined : { availableThemes, themeAppBg },
  withRecorded: ({ name }, recorded) => ({ name, ...recorded })
}
