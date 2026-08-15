import { useMemo, useState } from 'react'
import { useAnnouncements, useSettings } from '../../store'
import { useBackend } from '../../backend'
import { sortAnnouncementsNewestFirst } from './active-announcements'
import { NotificationCenterView } from './NotificationCenterView'

export interface NotificationCenterProps {
  onClose: () => void
}

export function NotificationCenter({ onClose }: NotificationCenterProps): JSX.Element {
  const backend = useBackend()
  const announcements = useAnnouncements()
  const settings = useSettings()
  const [refreshing, setRefreshing] = useState(false)

  const sortedItems = useMemo(
    () => sortAnnouncementsNewestFirst(announcements.items),
    [announcements.items]
  )
  const dismissedIds = useMemo(
    () => new Set(settings.dismissedAnnouncementIds),
    [settings.dismissedAnnouncementIds]
  )

  const handleRefresh = async (): Promise<void> => {
    setRefreshing(true)
    try {
      await backend.refreshAnnouncements()
    } finally {
      setRefreshing(false)
    }
  }

  return (
    <NotificationCenterView
      items={sortedItems}
      dismissedIds={dismissedIds}
      loading={refreshing}
      muted={settings.announcementsMuted}
      onClose={onClose}
      onRefresh={handleRefresh}
      onOpen={(href) => backend.openExternal(href)}
      onDismiss={(id) => void backend.dismissAnnouncement(id)}
      onToggleMute={() => void backend.muteAnnouncements(!settings.announcementsMuted)}
    />
  )
}
