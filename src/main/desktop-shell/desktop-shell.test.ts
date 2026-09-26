import { describe, expect, it, vi, beforeEach } from 'vitest'
import { join } from 'path'

const electronApp = vi.hoisted(() => ({
  isPackaged: false,
  getPath: vi.fn(() => '/tmp/harness-app-data'),
  setPath: vi.fn()
}))

vi.mock('electron', () => ({ app: electronApp }))
vi.mock('electron-updater', () => ({ autoUpdater: {} }))

import { applyDevModeOverride } from '.'

const APP_DATA = '/tmp/harness-app-data'

describe('applyDevModeOverride', () => {
  beforeEach(() => {
    electronApp.getPath.mockReset()
    electronApp.getPath.mockReturnValue(APP_DATA)
    electronApp.setPath.mockReset()
  })

  it('uses the Harness user data directory for packaged builds', () => {
    electronApp.isPackaged = true

    applyDevModeOverride()

    expect(electronApp.setPath).toHaveBeenCalledWith('userData', join(APP_DATA, 'Harness'))
  })

  it('uses the Harness (Dev) user data directory for development builds', () => {
    electronApp.isPackaged = false

    applyDevModeOverride()

    expect(electronApp.setPath).toHaveBeenCalledWith('userData', join(APP_DATA, 'Harness (Dev)'))
  })
})
