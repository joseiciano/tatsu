export const TATSU_REPO_OWNER = 'frenchie4111'
export const TATSU_REPO_NAME = 'harness'
export const TATSU_REPO_URL = `https://github.com/${TATSU_REPO_OWNER}/${TATSU_REPO_NAME}`
export const TATSU_NEW_ISSUE_URL = `${TATSU_REPO_URL}/issues/new`
export const TATSU_ISSUES_URL = `${TATSU_REPO_URL}/issues`
export const TATSU_RELEASES_URL = `${TATSU_REPO_URL}/releases`

export const TATSU_SITE_URL = 'https://harness.mikelyons.org'
export const TATSU_SITE_RELEASES_URL = `${TATSU_SITE_URL}/releases.html`

export function tatsuReleaseNotesUrl(version: string): string {
  const v = version.startsWith('v') ? version : `v${version}`
  return `${TATSU_SITE_RELEASES_URL}#${v}`
}
