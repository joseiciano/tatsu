import { describe, expect, it } from 'vitest'
import { scrubCredentials } from '.'

describe('scrubCredentials', () => {
  it('removes URL userinfo and GitHub token shapes', () => {
    expect(
      scrubCredentials(
        "fatal: unable to access 'https://x-access-token:ghs_abcdefghijklmnopqrstuvwx@github.com/acme/widgets.git/'"
      )
    ).toBe("fatal: unable to access 'https://github.com/acme/widgets.git/'")
    expect(scrubCredentials('ssh://git@host/repo and token ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123')).toBe(
      'ssh://host/repo and token [redacted]'
    )
    expect(scrubCredentials('git@github.com:acme/widgets.git')).toBe('git@github.com:acme/widgets.git')
  })
})
