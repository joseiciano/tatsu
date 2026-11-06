export const TATSU_REPO_OWNER = 'joseiciano'
export const TATSU_REPO_NAME = 'tatsu'
export const TATSU_REPO_URL = `https://github.com/${TATSU_REPO_OWNER}/${TATSU_REPO_NAME}`
export const TATSU_NEW_ISSUE_URL = `${TATSU_REPO_URL}/issues/new`
export const TATSU_ISSUES_URL = `${TATSU_REPO_URL}/issues`
export const TATSU_RELEASES_URL = `${TATSU_REPO_URL}/releases`
export const TATSU_ANNOUNCEMENTS_FEED_URL = `https://raw.githubusercontent.com/${TATSU_REPO_OWNER}/${TATSU_REPO_NAME}/main/site/public/announcements.json`

export const ENABLE_COST = false
export const ENABLE_TIMELINE = false
export const ENABLE_MY_WEEK = false
export const ENABLE_NOTIFICATION_CENTER = true

export function tatsuReleaseNotesUrl(version: string): string {
  const v = version.startsWith('v') ? version : `v${version}`
  return `${TATSU_RELEASES_URL}/tag/${v}`
}
