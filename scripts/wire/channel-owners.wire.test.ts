import { describe, expect, it } from 'vitest'
import { buildCatalog, type ChannelRecord } from './channel-owners'

const fromMain = (name: string, kind: ChannelRecord['kind'] = 'request'): ChannelRecord => ({
  kind,
  name,
  host: 'headless',
  file: 'index.ts'
})

describe('buildCatalog', () => {
  it('fails on a channel no rule owns', () => {
    expect(() => buildCatalog([fromMain('mystery:doThing')])).toThrow(/no owner for request channel mystery:doThing/)
  })

  it('fails when a removed adopt-from-disk channel is registered', () => {
    const record: ChannelRecord = {
      kind: 'request',
      name: 'harnessConfig:adoptFromDisk',
      host: 'headless',
      file: 'harness-config-transport/harness-config-transport.ts'
    }
    expect(() => buildCatalog([record])).toThrow(/removed channels/)
  })

  it('owns a channel by its registering package, with name rules winning over the package', () => {
    const catalog = buildCatalog([
      { kind: 'request', name: 'repo:add', host: 'desktop', file: 'desktop-shell/desktop-shell.ts' },
      { kind: 'signal', name: 'browser:setBounds', host: 'desktop', file: 'desktop-shell/desktop-shell.ts' }
    ])
    expect(catalog).toEqual({
      requests: [{ name: 'repo:add', owner: 'tauri-shell' }],
      signals: [{ name: 'browser:setBounds', owner: 'browser' }]
    })
  })

  it('keeps the headless fallback owner beside the desktop owner for the updater channels', () => {
    const catalog = buildCatalog([
      fromMain('updater:quitAndInstall'),
      { kind: 'request', name: 'updater:quitAndInstall', host: 'desktop', file: 'desktop-shell/desktop-shell.ts' }
    ])
    expect(catalog.requests).toEqual([
      { name: 'updater:quitAndInstall', owner: 'tauri-shell', headlessOwner: 'headless-web' }
    ])
  })

  it('fails when two modules register the same channel and no fallback rule covers it', () => {
    expect(() =>
      buildCatalog([
        fromMain('repo:list'),
        { kind: 'request', name: 'repo:list', host: 'desktop', file: 'desktop-shell/desktop-shell.ts' }
      ])
    ).toThrow(/conflicting owners for repo:list/)
  })

  it('marks a channel registered only by the unpackaged desktop shell as dev-only', () => {
    const catalog = buildCatalog([
      { kind: 'request', name: 'updater:devSimulate', host: 'desktop-dev', file: 'desktop-shell/desktop-shell.ts' }
    ])
    expect(catalog.requests).toEqual([{ name: 'updater:devSimulate', owner: 'tauri-shell', devOnly: true }])
  })

  it('sorts each list by name', () => {
    const catalog = buildCatalog([fromMain('worktree:list'), fromMain('activity:get'), fromMain('pty:write', 'signal')])
    expect(catalog.requests.map((entry) => entry.name)).toEqual(['activity:get', 'worktree:list'])
    expect(catalog.signals.map((entry) => entry.name)).toEqual(['pty:write'])
  })
})
