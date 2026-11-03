import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { vi } from 'vitest'
import { resetPathsForTests } from '../../../src/main/paths'
import { loadConfig, saveConfigSync } from '../../../src/main/persistence'
import { SCHEMA_VERSION } from '../../../src/main/persistence-migrations'
import type { Recorder } from './types'

export interface ConfigCase {
  name: string
  now: number
  input: string | null
  expected?: string
  schemaVersion?: number
}

interface ConfigRecorded {
  expected: string
  schemaVersion: number
}

const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/

export function loadAndSave({ name, now, input }: ConfigCase): ConfigRecorded {
  if (input !== null && LONE_SURROGATE.test(input)) {
    throw new Error(`${name}: input must hold lone surrogates only as \\u escapes`)
  }
  const dir = mkdtempSync(join(tmpdir(), 'tatsu-core-config-'))
  const previous = process.env.HARNESS_DATA_DIR
  process.env.HARNESS_DATA_DIR = dir
  resetPathsForTests()
  vi.useFakeTimers()
  vi.setSystemTime(now)
  try {
    const path = join(dir, 'config.json')
    if (input !== null) writeFileSync(path, input)
    saveConfigSync(loadConfig())
    return { expected: readFileSync(path, 'utf8'), schemaVersion: SCHEMA_VERSION }
  } finally {
    vi.useRealTimers()
    if (previous === undefined) delete process.env.HARNESS_DATA_DIR
    else process.env.HARNESS_DATA_DIR = previous
    resetPathsForTests()
    rmSync(dir, { recursive: true, force: true })
  }
}

export const configRecorder: Recorder<ConfigCase, ConfigRecorded> = {
  path: fileURLToPath(new URL('../../../fixtures/core/config/load-save.json', import.meta.url)),
  record: loadAndSave,
  recordedOf: ({ expected, schemaVersion }) =>
    expected === undefined || schemaVersion === undefined ? undefined : { expected, schemaVersion },
  withRecorded: ({ name, now, input }, recorded) => ({ name, now, input, ...recorded })
}
