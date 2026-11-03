import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { vi } from 'vitest'
import type { Recorder } from './types'

type ActivityModule = typeof import('../../../src/main/activity')

export interface ActivityCall {
  op: 'record' | 'touchMeta' | 'finalize' | 'clear' | 'clearAll' | 'sealAll'
  args: unknown[]
  now: number
}

export interface ActivityCase {
  name: string
  fileBefore: string | null
  calls: ActivityCall[]
  expected?: string | null
}

const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/

function call(activity: ActivityModule, { op, args }: ActivityCall): void {
  const [path, data] = args as [string, never]
  switch (op) {
    case 'record':
      return activity.recordActivity(path, data)
    case 'touchMeta':
      return activity.touchActivityMeta(path, data)
    case 'finalize':
      return activity.finalizeActivity(path, data)
    case 'clear':
      return activity.clearActivityForWorktree(path)
    case 'clearAll':
      return activity.clearAllActivity()
    case 'sealAll':
      return activity.sealAllActive()
  }
}

async function recordCase({ name, fileBefore, calls }: ActivityCase): Promise<string | null> {
  if (fileBefore !== null && LONE_SURROGATE.test(fileBefore)) {
    throw new Error(`${name}: fileBefore must hold lone surrogates only as \\u escapes`)
  }
  const dir = mkdtempSync(join(tmpdir(), 'tatsu-core-activity-'))
  const previous = process.env.HARNESS_DATA_DIR
  process.env.HARNESS_DATA_DIR = dir
  vi.resetModules()
  vi.useFakeTimers()
  try {
    const activity: ActivityModule = await import('../../../src/main/activity')
    const path = join(dir, 'activity.json')
    if (fileBefore !== null) writeFileSync(path, fileBefore)
    for (const c of calls) {
      vi.setSystemTime(c.now)
      call(activity, structuredClone(c))
    }
    vi.runOnlyPendingTimers()
    return existsSync(path) ? readFileSync(path, 'utf8') : null
  } finally {
    vi.useRealTimers()
    vi.resetModules()
    if (previous === undefined) delete process.env.HARNESS_DATA_DIR
    else process.env.HARNESS_DATA_DIR = previous
    rmSync(dir, { recursive: true, force: true })
  }
}

export const activityRecorder: Recorder<ActivityCase, string | null> = {
  path: fileURLToPath(new URL('../../../fixtures/core/activity/cases.json', import.meta.url)),
  record: recordCase,
  recordedOf: ({ expected }) => expected,
  withRecorded: ({ expected: _old, ...fixture }, expected) => ({ ...fixture, expected })
}
