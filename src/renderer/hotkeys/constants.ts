import type { Action, HotkeyBinding, HotkeyCategory } from './types'

export const DEFAULT_HOTKEYS: Record<Action, HotkeyBinding> = {
  nextWorktree: { key: 'ArrowDown', modifiers: { cmd: true } },
  prevWorktree: { key: 'ArrowUp', modifiers: { cmd: true } },
  worktree1: { key: '1', modifiers: { cmd: true } },
  worktree2: { key: '2', modifiers: { cmd: true } },
  worktree3: { key: '3', modifiers: { cmd: true } },
  worktree4: { key: '4', modifiers: { cmd: true } },
  worktree5: { key: '5', modifiers: { cmd: true } },
  worktree6: { key: '6', modifiers: { cmd: true } },
  worktree7: { key: '7', modifiers: { cmd: true } },
  worktree8: { key: '8', modifiers: { cmd: true } },
  worktree9: { key: '9', modifiers: { cmd: true } },
  // Backend switcher hotkeys (multi-backend Tier 1, design §F).
  // Cmd+Shift+1..9 to avoid colliding with worktree1..9. The cycle
  // hotkey from the design (Cmd+`) is already taken by `focusTerminal`,
  // so cycle is deferred — index switching is enough for v1's expected
  // 2-3 backend usage.
  backend1: { key: '1', modifiers: { cmd: true, shift: true } },
  backend2: { key: '2', modifiers: { cmd: true, shift: true } },
  backend3: { key: '3', modifiers: { cmd: true, shift: true } },
  backend4: { key: '4', modifiers: { cmd: true, shift: true } },
  backend5: { key: '5', modifiers: { cmd: true, shift: true } },
  backend6: { key: '6', modifiers: { cmd: true, shift: true } },
  backend7: { key: '7', modifiers: { cmd: true, shift: true } },
  backend8: { key: '8', modifiers: { cmd: true, shift: true } },
  backend9: { key: '9', modifiers: { cmd: true, shift: true } },
  newShellTab: { key: 't', modifiers: { cmd: true } },
  closeTab: { key: 'w', modifiers: { cmd: true } },
  renameTab: { key: 'l', modifiers: { cmd: true } },
  nextTab: { key: 'Tab', modifiers: { ctrl: true } },
  prevTab: { key: 'Tab', modifiers: { ctrl: true, shift: true } },
  newWorktree: { key: 'n', modifiers: { cmd: true } },
  refreshWorktrees: { key: 'r', modifiers: { cmd: true, shift: true } },
  focusTerminal: { key: '`', modifiers: { cmd: true } },
  toggleSidebar: { key: 'b', modifiers: { cmd: true } },
  openPR: { key: 'g', modifiers: { cmd: true, shift: true } },
  openInEditor: { key: 'e', modifiers: { cmd: true, shift: true } },
  toggleCommandCenter: { key: 'k', modifiers: { cmd: true, shift: true } },
  commandPalette: { key: 'k', modifiers: { cmd: true } },
  fileQuickOpen: { key: 'p', modifiers: { cmd: true } },
  splitPaneRight: { key: 'd', modifiers: { cmd: true } },
  splitPaneDown: { key: 'd', modifiers: { cmd: true, shift: true } },
  toggleRightColumn: { key: 'b', modifiers: { cmd: true, shift: true } },
  toggleSingleScreen: { key: 'F12', modifiers: {} },
  togglePerfMonitor: { key: 'p', modifiers: { cmd: true, alt: true } },
  hotkeyCheatsheet: { key: '/', modifiers: { cmd: true, shift: true } },
  openReview: { key: 'r', modifiers: { cmd: true, alt: true } },
  openSettings: { key: ',', modifiers: { cmd: true } },
  uiScaleUp: { key: '+', modifiers: { cmd: true, shift: true } },
  uiScaleDown: { key: '-', modifiers: { cmd: true } },
  uiScaleReset: { key: '=', modifiers: { cmd: true } },
  cycleWorktreeDetail: { key: 'i', modifiers: { cmd: true } },
}

export const ACTION_LABELS: Record<Action, string> = {
  nextWorktree: 'Next worktree',
  prevWorktree: 'Previous worktree',
  worktree1: 'Switch to worktree 1',
  worktree2: 'Switch to worktree 2',
  worktree3: 'Switch to worktree 3',
  worktree4: 'Switch to worktree 4',
  worktree5: 'Switch to worktree 5',
  worktree6: 'Switch to worktree 6',
  worktree7: 'Switch to worktree 7',
  worktree8: 'Switch to worktree 8',
  worktree9: 'Switch to worktree 9',
  backend1: 'Switch to backend 1',
  backend2: 'Switch to backend 2',
  backend3: 'Switch to backend 3',
  backend4: 'Switch to backend 4',
  backend5: 'Switch to backend 5',
  backend6: 'Switch to backend 6',
  backend7: 'Switch to backend 7',
  backend8: 'Switch to backend 8',
  backend9: 'Switch to backend 9',
  newShellTab: 'New shell tab',
  closeTab: 'Close tab',
  renameTab: 'Rename tab',
  nextTab: 'Next tab',
  prevTab: 'Previous tab',
  newWorktree: 'New worktree',
  refreshWorktrees: 'Refresh worktrees',
  focusTerminal: 'Focus terminal',
  toggleSidebar: 'Toggle sidebar',
  openPR: 'Open PR in browser',
  openInEditor: 'Open worktree in editor',
  toggleCommandCenter: 'Toggle command center',
  commandPalette: 'Command palette',
  fileQuickOpen: 'Open file...',
  splitPaneRight: 'Split pane right',
  splitPaneDown: 'Split pane down',
  toggleRightColumn: 'Toggle right column',
  toggleSingleScreen: 'Toggle single screen mode',
  togglePerfMonitor: 'Performance monitor',
  hotkeyCheatsheet: 'Keyboard shortcuts',
  openReview: 'Review changes',
  openSettings: 'Open settings',
  uiScaleUp: 'Increase UI size',
  uiScaleDown: 'Decrease UI size',
  uiScaleReset: 'Reset UI size',
  cycleWorktreeDetail: 'Cycle worktree detail (sidebar)'
}

export const ACTION_CATEGORIES: HotkeyCategory[] = [
  {
    id: 'navigation',
    label: 'Worktree navigation',
    actions: ['nextWorktree', 'prevWorktree'],
    families: [{
      label: 'Switch to worktree N',
      summary: '⌘ 1 … ⌘ 9',
      actions: ['worktree1', 'worktree2', 'worktree3', 'worktree4', 'worktree5', 'worktree6', 'worktree7', 'worktree8', 'worktree9']
    }]
  },
  {
    id: 'backends',
    label: 'Backends',
    actions: [],
    families: [{
      label: 'Switch to backend N',
      summary: '⌘ ⇧ 1 … ⌘ ⇧ 9',
      actions: ['backend1', 'backend2', 'backend3', 'backend4', 'backend5', 'backend6', 'backend7', 'backend8', 'backend9']
    }]
  },
  {
    id: 'worktree-mgmt',
    label: 'Worktree management',
    actions: ['newWorktree', 'refreshWorktrees']
  },
  {
    id: 'tabs',
    label: 'Tabs & panes',
    actions: ['newShellTab', 'closeTab', 'nextTab', 'prevTab', 'focusTerminal', 'splitPaneRight', 'splitPaneDown']
  },
  {
    id: 'layout',
    label: 'Window layout',
    actions: ['toggleSidebar', 'toggleRightColumn', 'uiScaleUp', 'uiScaleDown', 'uiScaleReset', 'cycleWorktreeDetail']
  },
  {
    id: 'commands',
    label: 'Search & commands',
    actions: ['commandPalette', 'fileQuickOpen', 'toggleCommandCenter', 'hotkeyCheatsheet']
  },
  {
    id: 'overlays',
    label: 'App overlays',
    actions: ['openSettings', 'openReview', 'togglePerfMonitor']
  },
  {
    id: 'external',
    label: 'External actions',
    actions: ['openPR', 'openInEditor']
  }
]
