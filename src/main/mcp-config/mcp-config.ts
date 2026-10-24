import { mkdirSync, writeFileSync, existsSync, readdirSync, unlinkSync, chmodSync } from 'fs'
import { join } from 'path'
import { getControlServerInfo } from '../control-server'
import type { CallerScope } from '../control-server'
import type { HarnessMcpServerSpec } from '../agents'
import { resolveBundledMcpScript, userDataDir } from '../paths'
import { log } from '../debug'

function getConfigDir(): string {
  const dir = join(userDataDir(), 'mcp-configs')
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 })
  return dir
}

export type { HarnessMcpServerSpec }

export function harnessMcpServerSpec(
  configPath: string,
  execPath: string = process.execPath,
  bridgePath: string = getBridgeScriptPath()
): HarnessMcpServerSpec {
  return { command: execPath, args: [bridgePath, '--config', configPath], env: { ELECTRON_RUN_AS_NODE: '1' } }
}

export function getBridgeScriptPath(): string {
  return resolveBundledMcpScript('mcp-bridge.js')
}

function sanitize(id: string): string {
  return id.replace(/[^a-zA-Z0-9._-]/g, '_')
}

/**
 * Write a per-terminal MCP config file pointing Claude Code at the bundled
 * harness-control MCP server. Returns the absolute path, or null if the
 * control server isn't running.
 *
 * Injects scope env vars (HARNESS_WORKTREE_ID, HARNESS_REPO_ROOT,
 * HARNESS_IS_MAIN, HARNESS_SESSION_ID) so the bridge can advertise
 * scope-appropriate tool descriptions at tools/list time. The server side
 * still re-resolves scope from the terminal id on every call — the env
 * vars are a hint, not the source of truth.
 *
 * Uses `ELECTRON_RUN_AS_NODE=1` so the Electron binary executes the bridge
 * script as a plain Node process — no separate Node install required.
 */
export function writeMcpConfigForTerminal(
  terminalId: string,
  scope: CallerScope | null
): string | null {
  const info = getControlServerInfo()
  if (!info) {
    log('mcp', 'control server not ready — skipping MCP config write')
    return null
  }
  const env: Record<string, string> = {
    ELECTRON_RUN_AS_NODE: '1',
    HARNESS_PORT: String(info.port),
    HARNESS_TOKEN: info.token,
    HARNESS_TERMINAL_ID: terminalId,
    HARNESS_SESSION_ID: terminalId
  }
  if (scope) {
    env.HARNESS_WORKTREE_ID = scope.worktreePath
    env.HARNESS_REPO_ROOT = scope.repoRoot
    if (scope.isMain) env.HARNESS_IS_MAIN = '1'
  }
  const config = {
    mcpServers: {
      'harness-control': {
        command: process.execPath,
        args: [getBridgeScriptPath()],
        env
      }
    }
  }
  let configPath: string
  try {
    configPath = join(getConfigDir(), `${sanitize(terminalId)}.json`)
    writeFileSync(configPath, JSON.stringify(config, null, 2), { mode: 0o600 })
  } catch (err) {
    log('mcp', 'failed to write config', err instanceof Error ? err.message : err)
    return null
  }
  try {
    chmodSync(configPath, 0o600)
  } catch (err) {
    log('mcp', 'failed to chmod config', err instanceof Error ? err.message : err)
    return null
  }
  return configPath
}

/** Remove mcp config files for terminals not present in `keepIds`. */
export function pruneMcpConfigs(keepIds: Set<string>): void {
  try {
    const dir = getConfigDir()
    const keep = new Set(Array.from(keepIds).map((id) => `${sanitize(id)}.json`))
    for (const file of readdirSync(dir)) {
      if (!keep.has(file)) {
        try {
          unlinkSync(join(dir, file))
        } catch {
          /* ignore */
        }
      }
    }
  } catch {
    /* ignore */
  }
}
