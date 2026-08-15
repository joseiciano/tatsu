import { describe, it, expect } from 'vitest'
import { getActiveAnnouncements, sortAnnouncementsNewestFirst, countUnreadAnnouncements } from './active-announcements'
import type { Announcement } from '../../../shared/state/announcements'

const NOW = Date.parse('2026-08-01T00:00:00Z')

function mk(partial: Partial<Announcement> & { id: string }): Announcement {
  return {
    title: 'T',
    href: 'https://example.com',
    publishedAt: '2026-01-01T00:00:00Z',
    ...partial
  }
}

describe('getActiveAnnouncements', () => {
  it('returns no active announcements from an empty feed', () => {
    const result = getActiveAnnouncements([], [], NOW)
    expect(result.count).toBe(0)
    expect(result.list).toEqual([])
  })

  it('filters out dismissed announcements', () => {
    const items = [mk({ id: 'a' }), mk({ id: 'b' })]
    const result = getActiveAnnouncements(items, ['a'], NOW)
    expect(result.list.map((a) => a.id)).toEqual(['b'])
    expect(result.count).toBe(1)
  })

  it('filters out expired announcements', () => {
    const items = [
      mk({ id: 'a', expiresAt: '2026-07-01T00:00:00Z' }),
      mk({ id: 'b', expiresAt: '2026-09-01T00:00:00Z' })
    ]
    const result = getActiveAnnouncements(items, [], NOW)
    expect(result.list.map((a) => a.id)).toEqual(['b'])
    expect(result.count).toBe(1)
  })

  it('keeps announcements that expire exactly at now', () => {
    const items = [mk({ id: 'a', expiresAt: '2026-08-01T00:00:00Z' })]
    const result = getActiveAnnouncements(items, [], NOW)
    expect(result.count).toBe(1)
    expect(result.list[0].id).toBe('a')
  })

  it('keeps announcements with no expiry', () => {
    const items = [mk({ id: 'a' })]
    const result = getActiveAnnouncements(items, [], NOW)
    expect(result.count).toBe(1)
  })

  it('count matches the filtered list length', () => {
    const items = [
      mk({ id: 'a', expiresAt: '2026-07-01T00:00:00Z' }),
      mk({ id: 'b' }),
      mk({ id: 'c', publishedAt: '2026-06-01T00:00:00Z' })
    ]
    const result = getActiveAnnouncements(items, ['b'], NOW)
    expect(result.count).toBe(1)
    expect(result.list.map((a) => a.id)).toEqual(['c'])
  })
})

describe('sortAnnouncementsNewestFirst', () => {
  it('sorts announcements newest first by publishedAt', () => {
    const items = [
      mk({ id: 'old', publishedAt: '2026-01-01T00:00:00Z' }),
      mk({ id: 'new', publishedAt: '2026-07-01T00:00:00Z' }),
      mk({ id: 'mid', publishedAt: '2026-04-01T00:00:00Z' })
    ]
    expect(sortAnnouncementsNewestFirst(items).map((a) => a.id)).toEqual(['new', 'mid', 'old'])
  })

  it('does not mutate the input array', () => {
    const items = [mk({ id: 'old', publishedAt: '2026-01-01T00:00:00Z' }), mk({ id: 'new', publishedAt: '2026-07-01T00:00:00Z' })]
    sortAnnouncementsNewestFirst(items)
    expect(items.map((a) => a.id)).toEqual(['old', 'new'])
  })
})

describe('countUnreadAnnouncements', () => {
  it('counts only non-dismissed, non-expired announcements', () => {
    const items = [
      mk({ id: 'a' }),
      mk({ id: 'b', expiresAt: '2026-07-01T00:00:00Z' }),
      mk({ id: 'c', publishedAt: '2026-06-01T00:00:00Z' })
    ]
    expect(countUnreadAnnouncements(items, ['a'], false, NOW)).toBe(1)
  })

  it('returns 0 when muted', () => {
    const items = [mk({ id: 'a' })]
    expect(countUnreadAnnouncements(items, [], true, NOW)).toBe(0)
  })

  it('returns 0 for an empty feed', () => {
    expect(countUnreadAnnouncements([], [], false, NOW)).toBe(0)
  })
})
