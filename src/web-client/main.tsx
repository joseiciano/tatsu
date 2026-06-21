// Web-client entry point. Drives the existing renderer App over a
// WebSocket connection to a remote Tatsu main process.
//
// All it does:
//   1. Open the WS to the harness-server we were served from.
//   2. Expose the WS as `window.__tatsu_local_transport` so the
//      renderer's BackendsRegistry can wire it as the (only) backend.
//   3. Mark `window.__TATSU_WEB__ = true` for the few legacy paths
//      that still read it (boot-error UI).
//   4. Skip `window.__tatsu_electron_helpers` — drag-drop file
//      paths and window controls are no-ops in the browser.
//   5. Dynamic-import the renderer; `initStore()` then calls
//      `initBackend()` which builds the renderer's backend singleton
//      over the WS handle.
//      Identical code path to Electron — the only difference is which
//      transport sits behind the local-backend handle.

import '../renderer/styles.css'
import type { ProfilerOnRenderCallback } from 'react'
import type { LocalTransportHandle } from '../renderer/types'
import { WebSocketClientTransport } from '../shared/transport/transport-websocket'

declare global {
  interface Window {
    /** True when the renderer is running in the WS-connected web client
     *  (vs. the Electron preload). Components can branch on this to hide
     *  Electron-only affordances. */
    __TATSU_WEB__?: boolean
    /** @deprecated Use __TATSU_WEB__ */
    __HARNESS_WEB__?: boolean
    /** Primary local-backend transport handle name. @deprecated __harness_local_transport kept for compat. */
    __tatsu_local_transport?: import('../renderer/types').LocalTransportHandle
    /** @deprecated Use __tatsu_local_transport */
    __harness_local_transport?: import('../renderer/types').LocalTransportHandle
    __tatsu_electron_helpers?: import('../shared/transport/transport').ElectronOnlyHelpers
    /** @deprecated Use __tatsu_electron_helpers */
    __harness_electron_helpers?: import('../shared/transport/transport').ElectronOnlyHelpers
  }
}

function readToken(): string | null {
  const url = new URL(window.location.href)
  return url.searchParams.get('token')
}


async function boot(): Promise<void> {
  const token = readToken()
  if (!token) {
    document.body.innerHTML =
      '<pre style="padding:24px;color:#fff;background:#222;font-family:monospace;">' +
      'No Tatsu auth token. Open this page from the URL printed by the main process,\n' +
      'e.g. http://&lt;host&gt;:37291/?token=&lt;token&gt;.</pre>'
    return
  }

  const wsProto = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
  const wsUrl = `${wsProto}//${window.location.host}/`

  const transport = new WebSocketClientTransport({ url: wsUrl, token })
  // Connect up front so the first getStateSnapshot() call inside the
  // dynamically imported renderer modules doesn't race the open
  // handshake.
  await transport.connect()

  window.__TATSU_WEB__ = true
  window.__HARNESS_WEB__ = true
  // Web client is always single-backend — it talks to one server (the
  // one it was served from). Expose that WS transport as the registry's
  // local backend; the renderer's `initBackend()` (called from
  // initStore) builds the backend singleton over it. Same shape, same code path
  // as Electron — just with a WS transport in place of the local IPC
  // handle.
  const localTransport: LocalTransportHandle = {
    getStateSnapshot: () => transport.getStateSnapshot(),
    onStateEvent: (cb) => transport.onStateEvent((event, seq) => cb(event, seq)),
    request: (name, ...args) => transport.request(name, ...args),
    send: (name, ...args) => transport.send(name, ...args),
    onSignal: (name, handler) => transport.onSignal(name, handler),
    getClientId: () => transport.getClientId(),
    onReconnect: (cb) => transport.onReconnect(cb)
  }
  window.__tatsu_local_transport = localTransport
  // No Electron helpers in the browser — the renderer's build-backend
  // gracefully no-ops drag-drop file paths and window controls when
  // this is absent.
  window.__harness_local_transport = window.__tatsu_local_transport
  window.__tatsu_electron_helpers = undefined
  window.__harness_electron_helpers = undefined

  // Dynamic-import the renderer modules so initStore (which builds
  // the backend singleton over the local transport) runs before App / XTerminal /
  // etc. read it. XTerminal's font cache is now lazy (initFontCache
  // fires on first mount) so the import-order constraint is softer
  // than it used to be, but we keep dynamic imports here for symmetry
  // with how the Electron renderer awaits initStore before mount.
  const [react, reactDom, appMod, storeMod, monacoMod, metricsMod, errorBoundaryMod] =
    await Promise.all([
      import('react'),
      import('react-dom/client'),
      import('../renderer/App'),
      import('../renderer/store'),
      import('../renderer/monaco-setup'),
      import('../renderer/render-metrics'),
      import('../renderer/components/ErrorBoundary')
    ])

  await storeMod.initStore()
  monacoMod.defineTatsuTheme()

  const onRender: ProfilerOnRenderCallback = (_id, _phase, actualDuration) => {
    metricsMod.renderMetrics.record(actualDuration)
  }

  const App = appMod.default
  const ErrorBoundary = errorBoundaryMod.ErrorBoundary

  reactDom
    .createRoot(document.getElementById('root')!)
    .render(
      <ErrorBoundary label="app:root" showReload>
        <react.Profiler id="app" onRender={onRender}>
          <App />
        </react.Profiler>
      </ErrorBoundary>
    )
}

void boot().catch((err) => {
  // eslint-disable-next-line no-console
  console.error('[tatsu-web] boot failed', err)
  document.body.innerHTML =
    '<pre style="padding:24px;color:#fff;background:#400;font-family:monospace;">' +
    `Tatsu web client failed to boot: ${String(err?.message ?? err)}</pre>`
})
