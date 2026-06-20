import { mkdirSync, writeFileSync, existsSync, readdirSync, unlinkSync } from 'fs'
import { join } from 'path'
import { getControlServerInfo } from '../control-server'
import type { CallerScope } from '../control-server'
import { resolveBundledMcpScript, userDataDir } from '../paths'
import { log } from '../debug'

function getConfigDir(): string {
  const dir = join(userDataDir(), 'mcp-configs')
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  return dir
}

export function getBridgeScriptPath(): string {
  return resolveBundledMcpScript('mcp-bridge.js')
}

function sanitize(id: string): string {
  return id.replace(/[^a-zA-Z0-9._-]/g, '_')
}

/**
 * Write a per-terminal MCP config file pointing Claude Code at the bundled
 * tatsu-control MCP server. Returns the absolute path, or null if the
 * control server isn't running.
 *
 * Injects scope env vars (TATSU_WORKTREE_ID, TATSU_REPO_ROOT,
 * TATSU_IS_MAIN, TATSU_SESSION_ID) so the bridge can advertise
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
  const configPath = join(getConfigDir(), `${sanitize(terminalId)}.json`)
  const env: Record<string, string> = {
    ELECTRON_RUN_AS_NODE: '1',
    TATSU_PORT: String(info.port),
    TATSU_TOKEN: info.token,
    TATSU_TERMINAL_ID: terminalId,
    TATSU_SESSION_ID: terminalId,
    // backward-compat aliases for old control-server/bridge versions
    HARNESS_PORT: String(info.port),
    HARNESS_TOKEN: info.token,
    HARNESS_TERMINAL_ID: terminalId,
    HARNESS_SESSION_ID: terminalId
  }
  if (scope) {
    env.TATSU_WORKTREE_ID = scope.worktreePath
    env.TATSU_REPO_ROOT = scope.repoRoot
    if (scope.isMain) env.TATSU_IS_MAIN = '1'
    // backward-compat aliases
    env.HARNESS_WORKTREE_ID = scope.worktreePath
    env.HARNESS_REPO_ROOT = scope.repoRoot
    if (scope.isMain) env.HARNESS_IS_MAIN = '1'
  }
  const config = {
    mcpServers: {
      'tatsu-control': {
        command: process.execPath,
        args: [getBridgeScriptPath()],
        env
      }
    }
  }
  try {
    writeFileSync(configPath, JSON.stringify(config, null, 2))
    return configPath
  } catch (err) {
    log('mcp', 'failed to write config', err instanceof Error ? err.message : err)
    return null
  }
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
