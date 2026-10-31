// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { NotificationCenter } from './NotificationCenter'
import type { Announcement, AnnouncementsState } from '../../../shared/state/announcements'

const { backendApi, storeState } = vi.hoisted(() => {
  const backendApi = {
    openExternal: vi.fn(),
    dismissAnnouncement: vi.fn(),
    muteAnnouncements: vi.fn(),
    refreshAnnouncements: vi.fn()
  }
  const storeState: {
    announcements: AnnouncementsState
    settings: { dismissedAnnouncementIds: string[]; announcementsMuted: boolean }
  } = {
    announcements: { items: [], lastFetched: null, lastError: null },
    settings: { dismissedAnnouncementIds: [], announcementsMuted: false }
  }
  return { backendApi, storeState }
})

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

vi.mock('../../backend', () => ({ useBackend: () => backendApi }))
vi.mock('../../store', () => ({
  useAnnouncements: () => storeState.announcements,
  useSettings: () => storeState.settings
}))

function announcement(overrides: Partial<Announcement> = {}): Announcement {
  return {
    id: 'a-1',
    title: 'Release 2.10',
    href: 'https://example.test/release',
    publishedAt: '2026-10-01T00:00:00Z',
    ...overrides
  }
}

function setStore(
  announcements: Partial<AnnouncementsState> = {},
  settings: Partial<typeof storeState.settings> = {}
): void {
  storeState.announcements = { items: [], lastFetched: null, lastError: null, ...announcements }
  storeState.settings = { dismissedAnnouncementIds: [], announcementsMuted: false, ...settings }
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((res) => {
    resolve = res
  })
  return { promise, resolve }
}

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  vi.clearAllMocks()
  backendApi.dismissAnnouncement.mockResolvedValue(true)
  backendApi.muteAnnouncements.mockResolvedValue(true)
  backendApi.refreshAnnouncements.mockResolvedValue(true)
  setStore()
  container = document.createElement('div')
  document.body.appendChild(container)
})

afterEach(() => {
  act(() => {
    root.unmount()
  })
  container.remove()
})

async function render(): Promise<void> {
  await act(async () => {
    root = createRoot(container)
    root.render(<NotificationCenter onClose={() => {}} />)
  })
}

async function flush(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0))
  })
}

function click(el: Element | null): void {
  if (!el) throw new Error('element not found')
  act(() => {
    ;(el as HTMLElement).click()
  })
}

function buttonTitled(title: string): HTMLButtonElement {
  const btn = container.querySelector<HTMLButtonElement>(`button[title="${title}"]`)
  if (!btn) throw new Error(`button not found: ${title}`)
  return btn
}

describe('NotificationCenter', () => {
  it('shows the fetch error and the last fetch time when lastError is set (REQ-013)', async () => {
    const fetchedAt = Date.UTC(2026, 9, 24, 12, 0, 0)
    setStore({ items: [announcement()], lastFetched: fetchedAt, lastError: 'fetch timed out' })

    await render()

    const error = container.querySelector('[role="alert"]')
    expect(error?.textContent).toContain('fetch timed out')
    expect(error?.textContent).toContain(new Date(fetchedAt).toLocaleString())
  })

  it('renders no error line when lastError is null', async () => {
    setStore({ items: [announcement()], lastFetched: 1 })

    await render()

    expect(container.querySelector('[role="alert"]')).toBeNull()
  })

  it('reads "Checking for announcements…" while the first fetch has not completed (REQ-014)', async () => {
    setStore({ items: [], lastFetched: null })

    await render()

    expect(container.textContent).toContain('Checking for announcements…')
    expect(container.textContent).not.toContain('No announcements yet.')
  })

  it('reads "No announcements yet." when a fetch completed and returned nothing (REQ-014)', async () => {
    setStore({ items: [], lastFetched: 1 })

    await render()

    expect(container.textContent).toContain('No announcements yet.')
    expect(container.textContent).not.toContain('Checking for announcements…')
  })

  it('dismiss calls the backend with the item id and does not open the item (REQ-019)', async () => {
    setStore({ items: [announcement({ id: 'a-7', href: 'https://example.test/a-7' })], lastFetched: 1 })

    await render()
    click(buttonTitled('Dismiss'))

    expect(backendApi.dismissAnnouncement).toHaveBeenCalledTimes(1)
    expect(backendApi.dismissAnnouncement).toHaveBeenCalledWith('a-7')
    expect(backendApi.openExternal).not.toHaveBeenCalled()
  })

  it('clicking an item opens its href (REQ-009)', async () => {
    setStore({ items: [announcement({ href: 'https://example.test/open-me' })], lastFetched: 1 })

    await render()
    click(container.querySelector('[title="Open"]'))

    expect(backendApi.openExternal).toHaveBeenCalledWith('https://example.test/open-me')
    expect(backendApi.dismissAnnouncement).not.toHaveBeenCalled()
  })

  it('mute toggles the backend with the inverse of the current setting (REQ-019)', async () => {
    setStore({ lastFetched: 1 }, { announcementsMuted: false })
    await render()
    click(buttonTitled('Mute notifications'))
    expect(backendApi.muteAnnouncements).toHaveBeenLastCalledWith(true)

    setStore({ lastFetched: 1 }, { announcementsMuted: true })
    await act(async () => {
      root.render(<NotificationCenter onClose={() => {}} />)
    })
    click(buttonTitled('Unmute notifications'))
    expect(backendApi.muteAnnouncements).toHaveBeenLastCalledWith(false)
  })

  it('refresh shows the spinner until the backend promise resolves (REQ-019)', async () => {
    const pending = deferred<boolean>()
    backendApi.refreshAnnouncements.mockReturnValue(pending.promise)
    setStore({ items: [announcement()], lastFetched: 1 })

    await render()
    expect(buttonTitled('Refresh').querySelector('.animate-spin')).toBeNull()

    click(buttonTitled('Refresh'))
    expect(backendApi.refreshAnnouncements).toHaveBeenCalledTimes(1)
    expect(buttonTitled('Refresh').querySelector('.animate-spin')).not.toBeNull()

    pending.resolve(true)
    await flush()
    expect(buttonTitled('Refresh').querySelector('.animate-spin')).toBeNull()
  })

  it('lists expired items in a collapsed Expired section that expands on click (REQ-015)', async () => {
    const past = new Date(Date.now() - 86_400_000).toISOString()
    setStore({
      items: [
        announcement({ id: 'live', title: 'Still live' }),
        announcement({ id: 'gone', title: 'Already expired', expiresAt: past })
      ],
      lastFetched: 1
    })

    await render()

    expect(container.textContent).toContain('Still live')
    expect(container.textContent).not.toContain('Already expired')
    const toggle = Array.from(container.querySelectorAll('button')).find((b) => b.textContent?.includes('Expired'))
    expect(toggle?.textContent).toContain('1')

    click(toggle ?? null)
    expect(container.textContent).toContain('Already expired')
  })

  it('renders no Expired section when nothing has expired (REQ-015)', async () => {
    setStore({ items: [announcement()], lastFetched: 1 })

    await render()

    expect(container.textContent).not.toContain('Expired')
  })
})
