import { readdirSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { toAgentKind } from '../../../src/main/agent-kind'
import { recordHandlerCase } from './handler-boot'
import type { HandlerCase, HandlerExpected } from './handler-types'
import type { Recorder } from './types'

const HANDLERS_DIR = fileURLToPath(new URL('../../../fixtures/core/handlers/', import.meta.url))

function handlerRecorder(path: string): Recorder<HandlerCase, HandlerExpected> {
  return {
    path,
    record: recordHandlerCase,
    recordedOf: ({ expected }) => expected,
    withRecorded: ({ expected: _old, ...fixture }, expected) => ({ ...fixture, expected })
  }
}

export function handlerRecorders(): Array<Recorder<HandlerCase, HandlerExpected>> {
  return readdirSync(HANDLERS_DIR)
    .filter((file) => file.endsWith('.json'))
    .sort()
    .map((file) => handlerRecorder(join(HANDLERS_DIR, file)))
}

export interface AgentKindCase {
  name: string
  input?: string
  expected?: string
}

export const agentKindRecorder: Recorder<AgentKindCase, string> = {
  path: fileURLToPath(new URL('../../../fixtures/core/helpers/agent-kind.json', import.meta.url)),
  record: ({ input }) => toAgentKind(input),
  recordedOf: ({ expected }) => expected,
  withRecorded: ({ expected: _old, ...fixture }, expected) => ({ ...fixture, expected })
}
