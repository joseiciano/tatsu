import { describe, expect, it, vi, beforeEach } from 'vitest'
import { join } from 'path'

const electronApp = vi.hoisted(() => ({
  isPackaged: false,
  getPath: vi.fn(() => '/tmp/harness-app-data'),
  setPath: vi.fn()
}))

vi.mock('electron', () => ({ app: electronApp }))
vi.mock('electron-updater', () => ({ autoUpdater: {} }))

import { applyDevModeOverride, focusAndOpenWorkflowsSection, type FocusableWindow } from '.'

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

function fakeWindow(minimized = false): FocusableWindow & { loaded: () => void } {
  let onLoad: (() => void) | null = null
  return {
    isMinimized: vi.fn(() => minimized),
    restore: vi.fn(),
    show: vi.fn(),
    focus: vi.fn(),
    webContents: {
      once: vi.fn((_event: 'did-finish-load', listener: () => void) => {
        onLoad = listener
      })
    },
    loaded: () => onLoad?.()
  }
}

describe('focusAndOpenWorkflowsSection', () => {
  it('restores, shows and focuses an existing window, then signals the renderer', () => {
    const win = fakeWindow(true)
    const sendSignal = vi.fn()
    const createWindow = vi.fn()

    focusAndOpenWorkflowsSection({ getWindow: () => win, createWindow, sendSignal })

    expect(win.restore).toHaveBeenCalledTimes(1)
    expect(win.show).toHaveBeenCalledTimes(1)
    expect(win.focus).toHaveBeenCalledTimes(1)
    expect(createWindow).not.toHaveBeenCalled()
    expect(sendSignal).toHaveBeenCalledWith('workflows:openSection')
  })

  it('does not restore a window that is not minimized', () => {
    const win = fakeWindow(false)

    focusAndOpenWorkflowsSection({ getWindow: () => win, createWindow: vi.fn(), sendSignal: vi.fn() })

    expect(win.restore).not.toHaveBeenCalled()
    expect(win.focus).toHaveBeenCalledTimes(1)
  })

  it('opens a new window when none exists and signals once it has loaded', () => {
    const win = fakeWindow()
    const sendSignal = vi.fn()

    focusAndOpenWorkflowsSection({ getWindow: () => null, createWindow: () => win, sendSignal })

    expect(sendSignal).not.toHaveBeenCalled()
    win.loaded()
    expect(win.focus).toHaveBeenCalledTimes(1)
    expect(sendSignal).toHaveBeenCalledWith('workflows:openSection')
  })
})
