import { mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { resetPathsForTests } from '../../../src/main/paths'
import { saveTerminalHistory } from '../../../src/main/persistence'
import { shellQuote } from '../../../src/main/shell-quote'
import type { Recorder } from './types'

export interface ShellHelperCase {
  name: string
  fn: 'shellQuote' | 'sanitizeId'
  input: string
  expected?: string
}

function historyFileStem(id: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'tatsu-core-history-'))
  const previous = process.env.HARNESS_DATA_DIR
  process.env.HARNESS_DATA_DIR = dir
  resetPathsForTests()
  try {
    saveTerminalHistory(id, 'x')
    const files = readdirSync(join(dir, 'terminal-history'))
    if (files.length !== 1 || !files[0].endsWith('.txt')) {
      throw new Error(`history id ${JSON.stringify(id)}: unexpected files ${JSON.stringify(files)}`)
    }
    return files[0].slice(0, -'.txt'.length)
  } finally {
    if (previous === undefined) delete process.env.HARNESS_DATA_DIR
    else process.env.HARNESS_DATA_DIR = previous
    resetPathsForTests()
    rmSync(dir, { recursive: true, force: true })
  }
}

export const shellHelpersRecorder: Recorder<ShellHelperCase, string> = {
  path: fileURLToPath(new URL('../../../fixtures/core/helpers/shell.json', import.meta.url)),
  record: ({ fn, input }) => (fn === 'shellQuote' ? shellQuote(input) : historyFileStem(input)),
  recordedOf: ({ expected }) => expected,
  withRecorded: ({ expected: _old, ...fixture }, expected) => ({ ...fixture, expected })
}
