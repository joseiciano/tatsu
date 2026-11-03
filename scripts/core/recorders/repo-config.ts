import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { invalidateRepoConfigCache, saveRepoConfig, type RepoConfig } from '../../../src/main/repo-config'
import type { Recorder } from './types'

export interface RepoConfigSaveCase {
  name: string
  fileBefore: string | null
  next: RepoConfig
  expected?: RepoConfigSaveRecorded
}

interface RepoConfigSaveRecorded {
  fileAfter: string | null
  reply: RepoConfig
}

function recordSave({ fileBefore, next }: RepoConfigSaveCase): RepoConfigSaveRecorded {
  const repoRoot = mkdtempSync(join(tmpdir(), 'tatsu-core-repo-config-'))
  const path = join(repoRoot, '.harness.json')
  invalidateRepoConfigCache()
  try {
    if (fileBefore !== null) writeFileSync(path, fileBefore)
    const reply = saveRepoConfig(repoRoot, structuredClone(next))
    return { fileAfter: existsSync(path) ? readFileSync(path, 'utf8') : null, reply: structuredClone(reply) }
  } finally {
    invalidateRepoConfigCache()
    rmSync(repoRoot, { recursive: true, force: true })
  }
}

export const repoConfigSaveRecorder: Recorder<RepoConfigSaveCase, RepoConfigSaveRecorded> = {
  path: fileURLToPath(new URL('../../../fixtures/core/repo-config/save.json', import.meta.url)),
  record: recordSave,
  recordedOf: ({ expected }) => expected,
  withRecorded: ({ expected: _old, ...fixture }, expected) => ({ ...fixture, expected })
}
