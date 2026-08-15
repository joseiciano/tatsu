import type { Announcement } from '../../../shared/state/announcements'

export interface ActiveAnnouncements {
  list: Announcement[]
  count: number
}

export function sortAnnouncementsNewestFirst(items: Announcement[]): Announcement[] {
  return [...items].sort((a, b) => (Date.parse(b.publishedAt) || 0) - (Date.parse(a.publishedAt) || 0))
}

export function getActiveAnnouncements(
  items: Announcement[],
  dismissedIds: readonly string[],
  now: number
): ActiveAnnouncements {
  const dismissed = new Set(dismissedIds)
  const list = sortAnnouncementsNewestFirst(
    items.filter((a) => {
      if (dismissed.has(a.id)) return false
      if (a.expiresAt) {
        const exp = Date.parse(a.expiresAt)
        if (Number.isFinite(exp) && exp < now) return false
      }
      return true
    })
  )
  return { list, count: list.length }
}

export function countUnreadAnnouncements(
  items: Announcement[],
  dismissedIds: readonly string[],
  muted: boolean,
  now: number
): number {
  if (muted) return 0
  return getActiveAnnouncements(items, dismissedIds, now).count
}
