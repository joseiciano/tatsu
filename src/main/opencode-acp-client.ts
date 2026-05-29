import { spawn, type ChildProcessWithoutNullStreams } from 'child_process'
import { randomUUID } from 'crypto'
import { log } from './debug'

export interface AcpMessage {
  jsonrpc: '2.0'
  id?: string
  method?: string
  params?: unknown
  result?: unknown
  error?: { code: number; message: string; data?: unknown }
}

export type AcpEventHandler = (event: AcpMessage) => void

export class AcpClient {
  private proc: ChildProcessWithoutNullStreams | null = null
  private buf = ''
  private pendingRequests = new Map<string, (result: unknown) => void>()
  private eventHandler: AcpEventHandler | null = null
  private sessionId: string
  private worktreePath: string
  private getOpencodeCommand: () => string

  constructor(
    sessionId: string,
    worktreePath: string,
    getOpencodeCommand: () => string
  ) {
    this.sessionId = sessionId
    this.worktreePath = worktreePath
    this.getOpencodeCommand = getOpencodeCommand
  }

  onEvent(handler: AcpEventHandler): void {
    this.eventHandler = handler
  }

  start(): void {
    if (this.proc) return
    const cmd = this.getOpencodeCommand() || 'opencode'
    const args = ['acp', '--session', this.sessionId]
    log('opencode-acp', `spawn sessionId=${this.sessionId} cwd=${this.worktreePath}`)

    try {
      this.proc = spawn(cmd, args, {
        cwd: this.worktreePath,
        env: process.env as Record<string, string>,
        stdio: ['pipe', 'pipe', 'pipe']
      })
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err)
      log('opencode-acp', `spawn failed sessionId=${this.sessionId}`, reason)
      this.emit({
        jsonrpc: '2.0',
        method: 'error',
        params: { kind: 'spawn', message: reason }
      })
      return
    }

    this.proc.stdout.on('data', (chunk: Buffer) => {
      this.buf += chunk.toString('utf8')
      let idx: number
      while ((idx = this.buf.indexOf('\n')) >= 0) {
        const line = this.buf.slice(0, idx).trim()
        this.buf = this.buf.slice(idx + 1)
        if (!line) continue
        this.handleLine(line)
      }
    })

    this.proc.stderr.on('data', (chunk: Buffer) => {
      const text = chunk.toString('utf8')
      log('opencode-acp', `stderr sessionId=${this.sessionId}: ${text.slice(0, 200)}`)
    })

    this.proc.on('exit', (code, signal) => {
      log('opencode-acp', `exit sessionId=${this.sessionId} code=${code} signal=${signal}`)
      this.proc = null
      this.emit({
        jsonrpc: '2.0',
        method: 'session/exit',
        params: { code, signal }
      })
    })
  }

  private handleLine(line: string): void {
    let msg: AcpMessage
    try {
      msg = JSON.parse(line) as AcpMessage
    } catch (err) {
      log('opencode-acp', `parse error sessionId=${this.sessionId}`, line.slice(0, 200))
      return
    }

    if (msg.id !== undefined && this.pendingRequests.has(msg.id)) {
      const resolve = this.pendingRequests.get(msg.id)!
      this.pendingRequests.delete(msg.id)
      resolve(msg.result)
      return
    }

    this.emit(msg)
  }

  private emit(msg: AcpMessage): void {
    if (this.eventHandler) {
      try {
        this.eventHandler(msg)
      } catch (err) {
        log('opencode-acp', `event handler error sessionId=${this.sessionId}`,
          err instanceof Error ? err.message : String(err))
      }
    }
  }

  sendRequest(method: string, params?: unknown): Promise<unknown> {
    return new Promise((resolve) => {
      const id = randomUUID()
      this.pendingRequests.set(id, resolve)
      const msg: AcpMessage = { jsonrpc: '2.0', id, method, params }
      this.write(msg)
      // Timeout after 30s
      setTimeout(() => {
        if (this.pendingRequests.has(id)) {
          this.pendingRequests.delete(id)
          resolve(undefined)
        }
      }, 30_000)
    })
  }

  sendNotification(method: string, params?: unknown): void {
    this.write({ jsonrpc: '2.0', method, params })
  }

  private write(msg: AcpMessage): void {
    if (!this.proc) return
    try {
      this.proc.stdin.write(JSON.stringify(msg) + '\n')
    } catch (err) {
      log('opencode-acp', `stdin write failed sessionId=${this.sessionId}`,
        err instanceof Error ? err.message : String(err))
    }
  }

  kill(): void {
    if (!this.proc) return
    try {
      this.proc.stdin.end()
    } catch { /* ignore */ }
    try {
      this.proc.kill('SIGTERM')
    } catch { /* ignore */ }
    this.proc = null
  }
}
