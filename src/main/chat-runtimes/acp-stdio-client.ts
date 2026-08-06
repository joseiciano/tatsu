// Reusable ACP stdio JSON-RPC client. Spawns an agent subprocess over
// newline-delimited (NDJSON) JSON-RPC 2.0 — NOT the Content-Length framing
// used by LSP/MCP. Handles split frames, multiple frames per chunk, and
// malformed JSON without crashing. This is transport-only: ACP protocol
// semantics (initialize / session/new / session/prompt / session/update)
// live in AcpStdioRuntime (./acp-stdio.ts), not here.

import { spawn, type ChildProcess, type SpawnOptions } from 'child_process'

export interface AcpStdioClientOptions {
  /** Command + args for the agent subprocess, e.g. ['opencode', 'acp']. */
  command: string[]
  cwd?: string
  env?: NodeJS.ProcessEnv
  /** Injectable spawn for tests. Defaults to child_process.spawn. */
  spawn?: (cmd: string, args: string[], opts: SpawnOptions) => ChildProcess
  /** Name/version advertised in the ACP `initialize` clientInfo. */
  clientInfo?: { name: string; version: string }
  /** Per-request timeout in ms. 0 (default) disables timeouts. */
  requestTimeoutMs?: number
}

type RequestHandler = (
  method: string,
  params: unknown
) => unknown | Promise<unknown> | undefined
type NotificationHandler = (method: string, params: unknown) => void
type ExitHandler = (code: number | null, signal: NodeJS.Signals | null) => void

interface PendingRequest {
  resolve: (result: any) => void
  reject: (err: Error) => void
  timer: ReturnType<typeof setTimeout> | null
}

export class AcpStdioClient {
  private child: ChildProcess
  private buffer = ''
  private seq = 0
  private pending = new Map<number, PendingRequest>()
  private requestHandler: RequestHandler | null = null
  private notificationHandler: NotificationHandler | null = null
  private exitHandler: ExitHandler | null = null
  private errorHandler: ((err: Error) => void) | null = null
  private malformedHandler: ((raw: string) => void) | null = null
  private exitInfo: { code: number | null; signal: NodeJS.Signals | null } | null =
    null
  private exitWaiters: Array<(info: { code: number | null; signal: NodeJS.Signals | null }) => void> =
    []
  private killed = false
  private requestTimeoutMs: number
  readonly pid: number | undefined

  constructor(opts: AcpStdioClientOptions) {
    this.requestTimeoutMs = opts.requestTimeoutMs ?? 0
    const [cmd, ...args] = opts.command
    const spawnFn =
      opts.spawn ?? ((c: string, a: string[], o: SpawnOptions) => spawn(c, a, o))
    this.child = spawnFn(cmd, args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      cwd: opts.cwd,
      env: { ...process.env, ...(opts.env ?? {}) }
    })
    this.pid = this.child.pid

    this.child.stdout?.on('data', (chunk: Buffer | string) => {
      this._onData(chunk)
    })
    // stderr is agent diagnostics; not part of the protocol — ignore it.
    this.child.stderr?.on('data', () => {})
    this.child.on('exit', (code, signal) => this._onExit(code, signal))
    this.child.on('error', (err) => {
      this.errorHandler?.(err)
      this._rejectAll(
        new Error(`ACP stdio subprocess error: ${err.message}`)
      )
    })
    this.child.stdin?.on('error', (err) => this.errorHandler?.(err))
  }

  /** True once the subprocess has exited (clean or not). */
  get isDead(): boolean {
    return this.exitInfo !== null
  }

  /** Register a handler for server→client requests (e.g. session/request_permission).
   *  Returning `undefined` makes the client reply with JSON-RPC -32601. */
  onRequest(handler: RequestHandler): void {
    this.requestHandler = handler
  }

  /** Register a handler for server→client notifications (e.g. session/update). */
  onNotification(handler: NotificationHandler): void {
    this.notificationHandler = handler
  }

  onExit(handler: ExitHandler): void {
    this.exitHandler = handler
  }

  onError(handler: (err: Error) => void): void {
    this.errorHandler = handler
  }

  /** Called with the raw line whenever a frame fails to JSON.parse. */
  onMalformedFrame(handler: (raw: string) => void): void {
    this.malformedHandler = handler
  }

  /** Resolves when the subprocess exits, or immediately if already dead. */
  waitForExit(): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
    if (this.exitInfo) return Promise.resolve(this.exitInfo)
    return new Promise((resolve) => this.exitWaiters.push(resolve))
  }

  /** Send a JSON-RPC request and await the matching response. `timeoutMs`
   *  overrides the instance `requestTimeoutMs` for this call: a positive value
   *  forces a finite per-request timeout, `0` disables it entirely (used by
   *  the runtime for long-running `session/prompt`). Omitting it falls back to
   *  the instance default. */
  request<T = unknown>(method: string, params: unknown, timeoutMs?: number): Promise<T> {
    const id = ++this.seq
    return new Promise<T>((resolve, reject) => {
      const eff = timeoutMs ?? this.requestTimeoutMs
      const timer =
        eff > 0
          ? setTimeout(() => {
              this.pending.delete(id)
              reject(new Error(`ACP request '${method}' timed out`))
            }, eff)
          : null
      this.pending.set(id, { resolve, reject, timer })
      this._write({ jsonrpc: '2.0', id, method, params })
    })
  }

  /** Send a fire-and-forget JSON-RPC notification (no id, no response). */
  notify(method: string, params: unknown): void {
    this._write({ jsonrpc: '2.0', method, params })
  }

  /** Kill the subprocess and reject any in-flight requests. */
  kill(): void {
    if (this.killed) return
    this.killed = true
    try {
      this.child.stdin?.end()
    } catch {
      // ignore
    }
    this.child.kill()
  }

  // ------------------------------------------------------------------
  // Private
  // ------------------------------------------------------------------

  private _write(msg: unknown): void {
    if (this.killed) {
      throw new Error('ACP stdio client is closed')
    }
    try {
      this.child.stdin?.write(JSON.stringify(msg) + '\n')
    } catch (err) {
      this.errorHandler?.(
        err instanceof Error ? err : new Error(String(err))
      )
    }
  }

  private _onData(chunk: Buffer | string): void {
    this.buffer += chunk.toString()
    let idx: number
    while ((idx = this.buffer.indexOf('\n')) !== -1) {
      const line = this.buffer.slice(0, idx)
      this.buffer = this.buffer.slice(idx + 1)
      this._handleLine(line)
    }
  }

  private _handleLine(raw: string): void {
    const line = raw.trim()
    if (!line) return
    let msg: any
    try {
      msg = JSON.parse(line)
    } catch {
      this.malformedHandler?.(raw)
      return
    }
    if (!msg || typeof msg !== 'object') return
    if (typeof msg.method === 'string') {
      if (msg.id !== undefined) {
        this._handleServerRequest(msg)
      } else {
        this.notificationHandler?.(msg.method, msg.params)
      }
      return
    }
    if (msg.id !== undefined) {
      this._handleResponse(msg)
    }
  }

  private async _handleServerRequest(msg: any): Promise<void> {
    const id = msg.id
    try {
      const result = this.requestHandler
        ? await this.requestHandler(msg.method, msg.params)
        : undefined
      if (result === undefined) {
        // Unknown method per JSON-RPC 2.0: respond with -32601.
        this._write({
          jsonrpc: '2.0',
          id,
          error: { code: -32601, message: `Method not found: ${msg.method}` }
        })
        return
      }
      this._write({ jsonrpc: '2.0', id, result })
    } catch (err) {
      this._write({
        jsonrpc: '2.0',
        id,
        error: {
          code: -32603,
          message: err instanceof Error ? err.message : String(err)
        }
      })
    }
  }

  private _handleResponse(msg: any): void {
    const pending = this.pending.get(msg.id)
    if (!pending) return
    this.pending.delete(msg.id)
    if (pending.timer) clearTimeout(pending.timer)
    if (msg.error) {
      pending.reject(
        new Error(
          msg.error.message ?? `ACP request failed (code ${msg.error.code ?? 'unknown'})`
        )
      )
    } else {
      pending.resolve(msg.result)
    }
  }

  private _onExit(code: number | null, signal: NodeJS.Signals | null): void {
    this.exitInfo = { code, signal }
    const waiters = this.exitWaiters.splice(0)
    for (const w of waiters) w(this.exitInfo)
    this._rejectAll(
      new Error(`ACP subprocess exited (code ${code}, signal ${signal ?? 'none'})`)
    )
    this.exitHandler?.(code, signal)
  }

  private _rejectAll(err: Error): void {
    for (const [id, p] of Array.from(this.pending.entries())) {
      this.pending.delete(id)
      if (p.timer) clearTimeout(p.timer)
      p.reject(err)
    }
  }
}

/** Default spawn helper used when no injectable spawn is provided. */
export function spawnAcpChild(
  cmd: string,
  args: string[],
  opts: SpawnOptions
): ChildProcess {
  return spawn(cmd, args, opts)
}
