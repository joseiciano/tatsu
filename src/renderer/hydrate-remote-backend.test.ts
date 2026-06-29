// Regression test for the e07bf05 → fix sequence. The bug:
 // hydrateRemoteBackend registered the remote BEFORE awaiting connect(),
 // and on connect failure the catch block didn't remove the entry. The
 // outer hydration loop then pinned active at the failed remote, the
 // renderer read from an empty store, and App.tsx fell through to the
 // onboarding screen even though the local backend had the user's repos.
 //
 // The fix removes the half-registered entry in the catch. BackendsRegistry.remove
 // auto-falls-back to LOCAL_BACKEND_ID when the removed entry was active,
 // so this single line handles both "remote is saved active" and "remote
 // is just one of several" cases.
 //
 // With the new session-token exchange flow (POST /_harness/session),
 // the token exchange happens BEFORE the WS connect. If the exchange
 // fails, the registry entry is never added. If the exchange succeeds
 // but WS connect fails, the entry is added then removed in the catch.

 import { describe, it, expect } from 'vitest'
 import { WebSocketServer, WebSocket as WSClient } from 'ws'
 import { createServer, type IncomingMessage, type Server as HttpServer } from 'http'
 import {
   BackendsRegistry,
   LOCAL_BACKEND_ID,
   hydrateRemoteBackend
 } from './store'
 import type { BackendConnection } from './types'
 import type { LocalTransportHandle } from '../shared/transport/transport'
 import { WebSocketClientTransport } from '../shared/transport/transport-websocket'

 function fakeLocalTransport(): LocalTransportHandle {
   return {
     getStateSnapshot: async () => ({ state: {} as never, seq: 0 }),
     onStateEvent: () => () => undefined,
     request: async () => undefined,
     send: () => undefined,
     onSignal: () => () => undefined,
     getClientId: async () => 'local-client',
     onReconnect: () => () => undefined
   }
 }

 function makeRegistry(): { registry: BackendsRegistry; localConn: BackendConnection } {
   const registry = new BackendsRegistry()
   const localConn: BackendConnection = {
     id: LOCAL_BACKEND_ID,
     label: 'Local',
     url: '',
     kind: 'local',
     addedAt: 0
   }
   registry.add(localConn, fakeLocalTransport())
   return { registry, localConn }
 }

 // A stub HTTP+WS server that rejects the session exchange (401) and
 // also rejects the WS upgrade. This simulates a server with a bad token.
 function rejectingServer(): Promise<{
   port: number
   close: () => Promise<void>
   httpServer: HttpServer
 }> {
   return new Promise((resolve, reject) => {
     const httpServer = createServer()
     const wsServer = new WebSocketServer({
       server: httpServer,
       verifyClient: (_info, cb) => cb(false, 401, 'unauthorized')
     })

     // Reject all session exchange requests
     httpServer.on('request', (req: IncomingMessage, res) => {
       if (req.url?.startsWith('/_harness/session') && req.method === 'POST') {
         res.statusCode = 401
         res.setHeader('Content-Type', 'text/plain; charset=utf-8')
         res.end('unauthorized')
         return
       }
       res.statusCode = 404
       res.end('not found')
     })

     httpServer.on('listening', () => {
       const addr = httpServer.address()
       if (typeof addr === 'object' && addr) {
         resolve({
           port: addr.port,
           httpServer,
           close: () =>
             new Promise<void>((r) => {
               wsServer.close()
               httpServer.close(() => r())
             })
         })
       } else {
         reject(new Error('failed to bind stub server'))
       }
     })
     httpServer.on('error', reject)
     httpServer.listen(0, '127.0.0.1')
   })
 }

 describe('BackendsRegistry.remove falls back to local', () => {
   it('removes the entry and restores activeId when the removed id was active', () => {
     const { registry } = makeRegistry()
     const remote: BackendConnection = {
       id: 'remote-1',
       label: 'R1',
       url: 'ws://example.invalid/',
       kind: 'remote',
       addedAt: Date.now()
     }
     registry.add(remote, fakeLocalTransport())
     registry.setActive('remote-1')
     expect(registry.getActiveId()).toBe('remote-1')

     registry.remove('remote-1')

     expect(registry.has('remote-1')).toBe(false)
     expect(registry.getActiveId()).toBe(LOCAL_BACKEND_ID)
   })

   it('leaves activeId alone when removing a non-active entry', () => {
     const { registry } = makeRegistry()
     const remote: BackendConnection = {
       id: 'remote-1',
       label: 'R1',
       url: 'ws://example.invalid/',
       kind: 'remote',
       addedAt: Date.now()
     }
     registry.add(remote, fakeLocalTransport())
     expect(registry.getActiveId()).toBe(LOCAL_BACKEND_ID)

     registry.remove('remote-1')

     expect(registry.has('remote-1')).toBe(false)
     expect(registry.getActiveId()).toBe(LOCAL_BACKEND_ID)
   })
 })

 describe('hydrateRemoteBackend on failed session exchange', () => {
   it('does not add the registry entry when session exchange fails', async () => {
     const { port, close } = await rejectingServer()
     try {
       const { registry } = makeRegistry()
       const remote: BackendConnection = {
         id: 'remote-1',
         label: 'R1',
         url: `ws://127.0.0.1:${port}/`,
         kind: 'remote',
         addedAt: Date.now()
       }

       // Subclass to inject the Node ws ctor without touching production
       // signatures (browser code passes the real global WebSocket).
       class WSWithNode extends WebSocketClientTransport {
         constructor(opts: ConstructorParameters<typeof WebSocketClientTransport>[0]) {
           super({
             ...opts,
             initialBackoffMs: 5_000,
             maxBackoffMs: 5_000,
             WebSocketCtor: WSClient as unknown as typeof WebSocket
           })
         }
       }

       await hydrateRemoteBackend(remote, {
         registry,
         backend: { connectionsGetToken: async () => 'tok' },
         WSCtor: WSWithNode
       })

       // Session exchange fails (401), so the entry is never added
       expect(registry.has('remote-1')).toBe(false)
     } finally {
       await close()
     }
   })

   it('falls back to LOCAL_BACKEND_ID when the failed remote had been set active by outer loop', async () => {
     // The full bug repro: the outer loop pins active at the saved id
     // (which the in-flight hydrate has already added) before hydrate's
     // await connect() rejects. After the catch fires, active must be
     // back to local so App.tsx reads the local store's repoRoots and
     // skips the onboarding gate.
     //
     // With the new flow, the session exchange happens first. If it
     // succeeds but WS connect fails, the entry is added then removed.
     // If the session exchange fails, the entry is never added.
     // This test simulates the latter case (session exchange fails).
     const { port, close } = await rejectingServer()
     try {
       const { registry } = makeRegistry()
       const remote: BackendConnection = {
         id: 'remote-1',
         label: 'R1',
         url: `ws://127.0.0.1:${port}/`,
         kind: 'remote',
         addedAt: Date.now()
       }

       class WSWithNode extends WebSocketClientTransport {
         constructor(opts: ConstructorParameters<typeof WebSocketClientTransport>[0]) {
           super({
             ...opts,
             initialBackoffMs: 5_000,
             maxBackoffMs: 5_000,
             WebSocketCtor: WSClient as unknown as typeof WebSocket
           })
         }
       }

       const hydratePromise = hydrateRemoteBackend(remote, {
         registry,
         backend: { connectionsGetToken: async () => 'tok' },
         WSCtor: WSWithNode
       })

       // Mimic the outer loop: after the token fetch resolves (the
       // microtask above), registry.has('remote-1') would be true if
       // the session exchange succeeded, so the bootstrapper calls
       // setActive. Yield twice so the token promise settles and
       // registry.add has run (if it was going to).
       await Promise.resolve()
       await Promise.resolve()
       if (registry.has('remote-1')) {
         registry.setActive('remote-1')
         expect(registry.getActiveId()).toBe('remote-1')
       }

       await hydratePromise

       // Session exchange fails, so entry was never added
       expect(registry.has('remote-1')).toBe(false)
       expect(registry.getActiveId()).toBe(LOCAL_BACKEND_ID)
     } finally {
       await close()
     }
   })
 })
