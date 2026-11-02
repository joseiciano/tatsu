import { writeFileSync } from 'node:fs'
import { isDeepStrictEqual } from 'node:util'
import { it } from 'vitest'
import {
  ROOT_FIXTURES,
  loadCases,
  loadRootCases,
  reduceCase,
  rootCaseAfter,
  sliceFiles,
  type FixtureCase,
  type RootCase
} from './fixtures'

const update = process.env.WIRE_UPDATE === '1'

interface RecordedCase {
  name: string
  after?: unknown
}

interface FixtureFile<C extends RecordedCase> {
  path: string
  cases: C[]
  after: (fixture: C) => unknown
  recorded: (fixture: C, after: unknown) => C
}

function recordedSlice(fixture: FixtureCase, after: unknown): FixtureCase {
  const { name, now, before, event } = fixture
  return { name, now, before, event, after }
}

function recordedRoot(fixture: RootCase, after: unknown): RootCase {
  const { name, kind, before } = fixture
  return { name, kind, before, after } as RootCase
}

function fixtureFiles(): Array<FixtureFile<RecordedCase>> {
  const slices = sliceFiles().map(
    ({ key, path }): FixtureFile<FixtureCase> => ({
      path,
      cases: loadCases(path),
      after: (fixture) => reduceCase(key, fixture),
      recorded: recordedSlice
    })
  )
  const root: FixtureFile<RootCase> = {
    path: ROOT_FIXTURES,
    cases: loadRootCases(),
    after: rootCaseAfter,
    recorded: recordedRoot
  }
  return [...slices, root] as unknown as Array<FixtureFile<RecordedCase>>
}

function diff(path: string, fixture: RecordedCase, after: unknown): string {
  const lines = (value: unknown, sign: string): string =>
    JSON.stringify(value, null, 2)
      .split('\n')
      .map((line) => `${sign} ${line}`)
      .join('\n')
  return `${path} > ${fixture.name}\n${lines(fixture.after, '-')}\n${lines(after, '+')}`
}

it.runIf(process.env.WIRE_RECORD === '1')('records fixture after values from the TS reducers', () => {
  const writes: Array<{ path: string; cases: RecordedCase[] }> = []
  const refusals: string[] = []

  for (const { path, cases: loaded, after: afterOf, recorded } of fixtureFiles()) {
    let changed = false
    const cases = loaded.map((fixture) => {
      const after = afterOf(fixture)
      if (!('after' in fixture)) {
        changed = true
        process.stdout.write(`recorded: ${path} > ${fixture.name}\n`)
        return recorded(fixture, after)
      }
      if (isDeepStrictEqual(fixture.after, after)) return fixture
      if (!update) {
        refusals.push(diff(path, fixture, after))
        return fixture
      }
      changed = true
      process.stdout.write(`updated: ${diff(path, fixture, after)}\n`)
      return recorded(fixture, after)
    })
    if (changed) writes.push({ path, cases })
  }

  if (refusals.length > 0) {
    throw new Error(
      `recorded after values would change; rerun with --update to overwrite:\n\n${refusals.join('\n\n')}`
    )
  }

  for (const { path, cases } of writes) {
    writeFileSync(path, `${JSON.stringify(cases, null, 2)}\n`)
  }
  if (writes.length === 0) process.stdout.write('fixtures: no change\n')
})
