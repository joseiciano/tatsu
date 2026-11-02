import { readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { expect, it, vi } from 'vitest'
import type { ServerTransport } from '../../src/shared/transport/transport'
import { buildCatalog, type ChannelRecord } from './channel-owners'

const enabled = process.env.WIRE_CHANNELS === '1'
const ROOT = fileURLToPath(new URL('../../', import.meta.url))
const MAIN_DIR = join(ROOT, 'src/main')
const OUT = join(ROOT, 'fixtures/wire/channels.json')

const recorder = vi.hoisted(() => ({
  host: 'headless' as 'headless' | 'desktop' | 'desktop-dev',
  isPackaged: false,
  records: [] as Array<{ kind: 'request' | 'signal'; name: string; host: 'headless' | 'desktop' | 'desktop-dev'; stack: string }>
}))

vi.mock('electron', () => {
  const noop = (): void => {}
  const app = {
    get isPackaged() {
      return recorder.isPackaged
    },
    on: noop,
    whenReady: () => new Promise(() => {}),
    getPath: () => tmpdir(),
    setPath: noop,
    getVersion: () => '0.0.0'
  }
  return {
    app,
    autoUpdater: { on: noop },
    BrowserWindow: { getAllWindows: () => [], getFocusedWindow: () => null, fromWebContents: () => null },
    dialog: {},
    Menu: { setApplicationMenu: noop, buildFromTemplate: () => ({}) },
    nativeImage: {},
    nativeTheme: { on: noop },
    screen: {},
    shell: {},
    session: {},
    ipcMain: { on: noop, handle: noop },
    WebContentsView: class {}
  }
})
vi.mock('electron-updater', () => ({ autoUpdater: { on: () => {} } }))

vi.mock('../../src/main/transport-compound', () => {
  class RecordingTransport {
    private record(kind: 'request' | 'signal', name: string): void {
      recorder.records.push({ kind, name, host: recorder.host, stack: new Error().stack ?? '' })
    }
    onRequest(name: string): void {
      this.record('request', name)
    }
    onSignal(name: string): void {
      this.record('signal', name)
    }
    start(): void {}
    stop(): void {}
    broadcastStateEvent(): void {}
    sendSignal(): void {}
    onClientDisconnect(): void {}
  }
  return { CompoundServerTransport: RecordingTransport }
})
vi.mock('../../src/main/transport-websocket', () => ({
  WebSocketServerTransport: class {
    start(): void {}
    stop(): void {}
    getPort(): number {
      return 0
    }
    getToken(): string {
      return ''
    }
    getHost(): string {
      return '127.0.0.1'
    }
  }
}))
vi.mock('../../src/main/web-client-server', () => ({
  createWebClientServer: () => ({ on: () => {}, listen: () => {}, address: () => null })
}))
vi.mock('../../src/main/path-fix', () => ({ fixPathFromLoginShell: () => Promise.resolve() }))
vi.mock('../../src/main/control-server', () => ({ startControlServer: () => new Promise(() => {}) }))
vi.mock('../../src/main/announcements-poller', () => ({
  AnnouncementsPoller: class {
    start(): void {}
    stop(): void {}
  }
}))
vi.mock('../../src/main/github-auth', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/main/github-auth')>()),
  resolveGitHubToken: () => new Promise(() => {})
}))
vi.mock('../../src/main/hooks', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/main/hooks')>()),
  watchStatusDir: () => () => {}
}))
vi.mock('../../src/main/mcp-config', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/main/mcp-config')>()),
  pruneMcpConfigs: () => {},
  writeMcpConfigForTerminal: () => {}
}))

function assertSandboxed(): void {
  const sandbox = process.env.WIRE_CHANNELS_SANDBOX
  if (!sandbox || process.env.HOME !== sandbox || process.env.HARNESS_DATA_DIR !== sandbox) {
    throw new Error('channel recorder must run through `pnpm gen:channels` (sandboxed HOME and HARNESS_DATA_DIR)')
  }
}

function registeringFile(stack: string): string {
  for (const line of stack.split('\n')) {
    const match = line.match(/(\/[^\s():]+\.ts)/)
    if (!match) continue
    const path = match[1]
    if (!path.startsWith(MAIN_DIR + '/')) continue
    return relative(MAIN_DIR, path)
  }
  throw new Error(`could not find the registering src/main file in stack:\n${stack}`)
}

function toRecords(): ChannelRecord[] {
  return recorder.records.map(({ kind, name, host, stack }) => ({ kind, name, host, file: registeringFile(stack) }))
}

function literalNames(dir: string): Set<string> {
  const names = new Set<string>()
  for (const entry of readdirSync(dir, { withFileTypes: true, recursive: true })) {
    if (!entry.isFile() || !entry.name.endsWith('.ts') || entry.name.endsWith('.test.ts')) continue
    const source = readFileSync(join(entry.parentPath, entry.name), 'utf8')
    for (const match of source.matchAll(/transport\.on(?:Request|Signal)\(\s*'([^']+)'/g)) names.add(match[1])
  }
  return names
}

async function settle(): Promise<void> {
  for (let i = 0; i < 5; i++) await new Promise((resolve) => setTimeout(resolve, 0))
}

it.skipIf(!enabled)('records every channel src/main registers and writes fixtures/wire/channels.json', async () => {
  assertSandboxed()
  process.argv = [process.execPath, 'harness-server', '--port', '0', '--host', '127.0.0.1']

  recorder.host = 'headless'
  await import('../../src/main')
  await settle()
  const headlessCount = recorder.records.length
  expect(headlessCount).toBeGreaterThan(0)

  const { CompoundServerTransport } = await import('../../src/main/transport-compound')
  const { startDesktopShell } = await import('../../src/main/desktop-shell')
  const noop = (): void => {}
  for (const packaged of [true, false]) {
    recorder.host = packaged ? 'desktop' : 'desktop-dev'
    recorder.isPackaged = packaged
    startDesktopShell({
      store: {} as never,
      transport: new CompoundServerTransport([] as ServerTransport[]),
      ptyManager: {} as never,
      browserManager: {} as never,
      worktreesFSM: {} as never,
      config: {} as never,
      runBoot: noop,
      getStopWatchingStatus: () => null,
      setStopWatchingStatus: noop,
      onRepoAdded: noop
    })
  }
  expect(recorder.records.length).toBeGreaterThan(headlessCount)

  const records = toRecords()
  const recorded = new Set(records.map((record) => record.name))
  const missing = [...literalNames(MAIN_DIR)].filter((name) => !recorded.has(name))
  expect(missing, 'literal registrations the boot never reached').toEqual([])

  writeFileSync(OUT, JSON.stringify(buildCatalog(records), null, 2) + '\n')
})
