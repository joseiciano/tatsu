import { fileURLToPath } from 'node:url'
import { buildInitialAppState } from '../../../src/main/build-initial-state'
import type { Config } from '../../../src/main/persistence'
import type { Recorder } from './types'

export interface InitialStateCase {
  name: string
  config: Record<string, unknown>
  hasGithubToken: boolean
  expected?: unknown
}

export const initialStateRecorder: Recorder<InitialStateCase, unknown> = {
  path: fileURLToPath(new URL('../../../fixtures/core/config/initial-state.json', import.meta.url)),
  record: ({ config, hasGithubToken }) =>
    JSON.parse(JSON.stringify(buildInitialAppState(config as unknown as Config, { hasGithubToken }))),
  recordedOf: ({ expected }) => expected,
  withRecorded: ({ name, config, hasGithubToken }, expected) => ({ name, config, hasGithubToken, expected })
}
