import type { Announcement } from '../../../shared/state/announcements'

export interface ActiveAnnouncements {
  list: Announcement[]
  count: number
}

export function sortAnnouncementsNewestFirst(items: Announcement[]): Announcement[] {
  return [...items].sort((a, b) => (Date.parse(b.publishedAt) || 0) - (Date.parse(a.publishedAt) || 0))
}

function isExpired(a: Announcement, now: number): boolean {
  if (!a.expiresAt) return false
  const exp = Date.parse(a.expiresAt)
  return Number.isFinite(exp) && exp < now
}

export interface PartitionedAnnouncements {
  current: Announcement[]
  expired: Announcement[]
}

export function partitionExpiredAnnouncements(items: Announcement[], now: number): PartitionedAnnouncements {
  const sorted = sortAnnouncementsNewestFirst(items)
  return {
    current: sorted.filter((a) => !isExpired(a, now)),
    expired: sorted.filter((a) => isExpired(a, now))
  }
}

export function getActiveAnnouncements(
  items: Announcement[],
  dismissedIds: readonly string[],
  now: number
): ActiveAnnouncements {
  const dismissed = new Set(dismissedIds)
  const list = partitionExpiredAnnouncements(items, now).current.filter((a) => !dismissed.has(a.id))
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
