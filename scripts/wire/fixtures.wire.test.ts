import { describe, expect, it } from 'vitest'
import { caseInput, loadCases, loadRootCases, reduceCase, rootCaseAfter, sliceFiles } from './fixtures'

const files = sliceFiles()

it('finds at least one slice fixture case', () => {
  expect(files.flatMap((file) => loadCases(file.path)).length).toBeGreaterThan(0)
})

for (const { key, path } of files) {
  describe(key, () => {
    for (const fixture of loadCases(path)) {
      it(fixture.name, () => {
        expect(fixture, `"${fixture.name}" has no recorded after; run pnpm fixtures:record`).toHaveProperty('after')
        expect(reduceCase(key, fixture), `${fixture.name}\ninput: ${caseInput(fixture)}`).toStrictEqual(fixture.after)
      })
    }
  })
}

describe('root', () => {
  for (const fixture of loadRootCases()) {
    it(fixture.name, () => {
      expect(fixture, `"${fixture.name}" has no recorded after; run pnpm fixtures:record`).toHaveProperty('after')
      expect(rootCaseAfter(fixture), `${fixture.name}\ninput: ${JSON.stringify(fixture.before, null, 2)}`).toStrictEqual(
        fixture.after
      )
    })
  }
})
