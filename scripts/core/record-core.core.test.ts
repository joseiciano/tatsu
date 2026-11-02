import { readFileSync, writeFileSync } from 'node:fs'
import { isDeepStrictEqual } from 'node:util'
import { it } from 'vitest'
import { configRecorder } from './recorders/config'
import type { Recorder } from './recorders/types'

const update = process.env.CORE_UPDATE === '1'

type AnyRecorder = Recorder<{ name: string }, unknown>

const recorders = [configRecorder] as unknown as AnyRecorder[]

function diff(path: string, name: string, before: unknown, after: unknown): string {
  const text = (value: unknown): string =>
    typeof value === 'string' ? value : JSON.stringify(value, null, 2)
  const render = (value: unknown): string[] =>
    typeof value === 'object' && value !== null
      ? Object.entries(value).flatMap(([key, field]) => [`${key}:`, ...text(field).split('\n')])
      : text(value).split('\n')
  const lines = (value: unknown, sign: string): string =>
    render(value)
      .map((line) => `${sign} ${line}`)
      .join('\n')
  return `${path} > ${name}\n${lines(before, '-')}\n${lines(after, '+')}`
}

it.runIf(process.env.CORE_RECORD === '1')('records core golden values from the TS code', () => {
  const writes: Array<{ path: string; cases: unknown[] }> = []
  const refusals: string[] = []

  for (const { path, record, recordedOf, withRecorded } of recorders) {
    const loaded = JSON.parse(readFileSync(path, 'utf8')) as Array<{ name: string }>
    let changed = false
    const cases = loaded.map((fixture) => {
      const after = record(fixture)
      const before = recordedOf(fixture)
      if (before === undefined) {
        changed = true
        process.stdout.write(`recorded: ${path} > ${fixture.name}\n`)
        return withRecorded(fixture, after)
      }
      if (isDeepStrictEqual(before, after)) return fixture
      if (!update) {
        refusals.push(diff(path, fixture.name, before, after))
        return fixture
      }
      changed = true
      process.stdout.write(`updated: ${diff(path, fixture.name, before, after)}\n`)
      return withRecorded(fixture, after)
    })
    if (changed) writes.push({ path, cases })
  }

  if (refusals.length > 0) {
    throw new Error(
      `recorded expected values would change; rerun with --update to overwrite:\n\n${refusals.join('\n\n')}`
    )
  }

  for (const { path, cases } of writes) {
    writeFileSync(path, `${JSON.stringify(cases, null, 2)}\n`)
  }
  if (writes.length === 0) process.stdout.write('core fixtures: no change\n')
})
