import { writeFileSync } from 'node:fs'
import { isDeepStrictEqual } from 'node:util'
import { it } from 'vitest'
import { loadCases, reduceCase, sliceFiles, type FixtureCase } from './fixtures'

const update = process.env.WIRE_UPDATE === '1'

function recorded(fixture: FixtureCase, after: unknown): FixtureCase {
  const { name, now, before, event } = fixture
  return { name, now, before, event, after }
}

function diff(path: string, fixture: FixtureCase, after: unknown): string {
  const lines = (value: unknown, sign: string): string =>
    JSON.stringify(value, null, 2)
      .split('\n')
      .map((line) => `${sign} ${line}`)
      .join('\n')
  return `${path} > ${fixture.name}\n${lines(fixture.after, '-')}\n${lines(after, '+')}`
}

it.runIf(process.env.WIRE_RECORD === '1')('records fixture after values from the TS reducers', () => {
  const writes: Array<{ path: string; cases: FixtureCase[] }> = []
  const refusals: string[] = []

  for (const { key, path } of sliceFiles()) {
    let changed = false
    const cases = loadCases(path).map((fixture) => {
      const after = reduceCase(key, fixture)
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
