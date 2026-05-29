import { spawn, type ChildProcessWithoutNullStreams } from 'child_process'
import { randomUUID } from 'crypto'
import { log } from './debug'
import { resolveUserShell, loginShellCommandArgs } from './user-shell'

export interface AcpMessage {
  jsonrpc: '2.0'
  id?: string | number
  method?: string
  params?: unknown
  result?: unknown
  error?: { code: number; message: string; data?: unknown }
}

export interface AcpInitializeResult {
  protocolVersion: number
  agentCapabilities: {
    loadSession?: boolean
    promptCapabilities?: { image?: boolean; embeddedContext?: boolean }
    sessionCapabilities?: { list?: unknown; resume?: unknown; close?: unknown }
    mcpCapabilities?: { http?: boolean; sse?: boolean }
  }
  agentInfo: { name: string; version: string }
}

export interface AcpSessionNewResult {
  sessionId: string
  modes?: { currentModeId?: string; availableModes?: unknown[] }
  configOptions?: unknown[]
}

export interface AcpPromptResult {
  stopReason: 'end_turn' | 'max_tokens' | 'max_turn_requests' | 'refusal' | 'cancelled'
}

export interface AcpSessionUpdate {
  sessionId: string
  update: {
    sessionUpdate: string
    [key: string]: unknown
  }
}

export interface AcpPermissionRequest {
  sessionId: string
  toolCall: {
    toolCallId: string
    title: string
    kind: string
    status: string
  }
  options: Array<{
    optionId: string
    name: string
    kind: string
  }>
}

export type AcpEventHandler = (event: AcpMessage) => void

export class AcpClient {
  private proc: ChildProcessWithoutNullStreams | null = null
  private buf = ''
  private pendingRequests = new Map<string | number, (result: unknown) => void>()
  private eventHandler: AcpEventHandler | null = null
  private worktreePath: string
  private getCommandLine: () => string
  private nextId = 0

  constructor(
    worktreePath: string,
    getCommandLine: () => string
  ) {
    this.worktreePath = worktreePath
    this.getCommandLine = getCommandLine
  }

  onEvent(handler: AcpEventHandler): void {
    this.eventHandler = handler
  }

  start(): void {
    if (this.proc) return
    const cmdLine = this.getCommandLine() || 'opencode acp'
    const shell = resolveUserShell()
    const args = loginShellCommandArgs(cmdLine)
    log('opencode-acp', `spawn cwd=${this.worktreePath} shell=${shell} cmd=${cmdLine}`)

    try {
      this.proc = spawn(shell, args, {
        cwd: this.worktreePath,
        env: process.env as Record<string, string>,
        stdio: ['pipe', 'pipe', 'pipe']
      })
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err)
      log('opencode-acp', `spawn failed`, reason)
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
      log('opencode-acp', `stderr: ${text.slice(0, 200)}`)
    })

    this.proc.on('exit', (code, signal) => {
      log('opencode-acp', `exit code=${code} signal=${signal}`)
      this.proc = null
      this.emit({
        jsonrpc: '2.0',
        method: 'session/exit',
        params: { code, signal }
      })
    })

    this.proc.on('error', (err) => {
      log('opencode-acp', `process error`, err.message)
      this.proc = null
      this.emit({
        jsonrpc: '2.0',
        method: 'error',
        params: { kind: 'process', message: err.message }
      })
    })
  }

  private handleLine(line: string): void {
    let msg: AcpMessage
    try {
      msg = JSON.parse(line) as AcpMessage
    } catch (err) {
      log('opencode-acp', `parse error`, line.slice(0, 200))
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
        log('opencode-acp', `event handler error`,
          err instanceof Error ? err.message : String(err))
      }
    }
  }

  private makeId(): number {
    return this.nextId++
  }

  sendRequest(method: string, params?: unknown): Promise<unknown> {
    return new Promise((resolve) => {
      const id = this.makeId()
      this.pendingRequests.set(id, resolve)
      const msg: AcpMessage = { jsonrpc: '2.0', id, method, params }
      this.write(msg)
      setTimeout(() => {
        if (this.pendingRequests.has(id)) {
          this.pendingRequests.delete(id)
          resolve(undefined)
        }
      }, 30_000)
    })
  }

  sendResponse(id: string | number, result: unknown): void {
    this.write({ jsonrpc: '2.0', id, result })
  }

  sendNotification(method: string, params?: unknown): void {
    this.write({ jsonrpc: '2.0', method, params })
  }

  private write(msg: AcpMessage): void {
    if (!this.proc) return
    try {
      this.proc.stdin.write(JSON.stringify(msg) + '\n')
    } catch (err) {
      log('opencode-acp', `stdin write failed`,
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
