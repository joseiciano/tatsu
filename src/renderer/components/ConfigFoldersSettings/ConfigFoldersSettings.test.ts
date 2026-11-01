import { describe, expect, it } from 'vitest'

import { CONFIG_FOLDER_GROUPS, findDuplicateRoots } from '.'
import { HARNESS_CONFIG_ROOT_KEYS } from '../../../shared/state/harness-config'

describe('findDuplicateRoots', () => {
  it('returns nothing when every folder is distinct', () => {
    expect(
      findDuplicateRoots({ claudeSkills: '/a/skills', opencodeSkills: '/b/skills', codexHome: undefined })
    ).toEqual([])
  })

  it('groups keys that resolve to the same folder, ignoring a trailing slash', () => {
    expect(
      findDuplicateRoots({
        claudeSkills: '/dotfiles/skills',
        opencodeSkills: '/dotfiles/skills/',
        codexSkills: '/home/.agents/skills'
      })
    ).toEqual([['claudeSkills', 'opencodeSkills']])
  })
})

describe('CONFIG_FOLDER_GROUPS', () => {
  it('lists every root key exactly once', () => {
    const ids = CONFIG_FOLDER_GROUPS.flatMap((group) => group.rows.map((row) => row.id))
    expect([...ids].sort()).toEqual([...HARNESS_CONFIG_ROOT_KEYS].sort())
  })
})
