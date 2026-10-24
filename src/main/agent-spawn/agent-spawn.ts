import type { AgentKind, TerminalsState } from '../../shared/state/terminals'
import { findLeafByTabId, getLeaves } from '../../shared/state/terminals'
import type {
  SpawnOutcome,
  TerminalAttachResult,
  TerminalCreateResult,
  TerminalSpawnSpec
} from '../../shared/terminal-spawn-types'
import { assertNeverAgentKind, toAgentKind } from '../agent-kind'
import type { AgentModule, AgentSpawnOpts } from '../agents'
import { getAgent as defaultGetAgent } from '../agents'
import { buildClaudeLaunchSettings } from '../claude-launch'
import { log } from '../debug'
import { DEFAULT_SPAWN_COLS, DEFAULT_SPAWN_ROWS } from './constants'
import type {
  AgentSpawnConfig,
  AgentSpawner,
  AgentSpawnerDeps,
  AgentSpawnRequest,
  ShellSpawnRequest
} from './types'

function positive(value: number | undefined, fallback: number): number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : fallback
}

function configuredEnv(kind: AgentKind, config: AgentSpawnConfig): Record<string, string> {
  const vars =
    kind === 'claude'
      ? config.claudeEnvVars
      : kind === 'codex'
        ? config.codexEnvVars
        : kind === 'opencode'
          ? config.opencodeEnvVars
          : kind === 'pi'
            ? config.piEnvVars
            : assertNeverAgentKind(kind)
  return { ...(vars ?? {}) }
}

export function resolveSpawnSize(
  state: TerminalsState,
  worktreePath: string,
  terminalId: string
): { cols: number; rows: number } {
  const tree = state.panes[worktreePath]
  if (tree) {
    const own = findLeafByTabId(tree, terminalId)
    const leaves = own ? [own, ...getLeaves(tree).filter((l) => l !== own)] : getLeaves(tree)
    for (const leaf of leaves) {
      for (const tab of leaf.tabs) {
        if (tab.id === terminalId) continue
        const size = state.sessions[tab.id]?.size
        if (size) return { cols: size.cols, rows: size.rows }
      }
    }
  }
  return { cols: DEFAULT_SPAWN_COLS, rows: DEFAULT_SPAWN_ROWS }
}

export function agentSessionName(
  worktree: { repoRoot: string; branch: string } | undefined,
  enabled: boolean
): string | undefined {
  if (!enabled || !worktree) return undefined
  const repoLabel = worktree.repoRoot.split('/').pop() || worktree.repoRoot
  return `${repoLabel}/${worktree.branch}`
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}

export function parseSpawnSpec(raw: unknown): TerminalSpawnSpec | null {
  if (!raw || typeof raw !== 'object') return null
  const r = raw as Record<string, unknown>
  const terminalId = r.terminalId
  const cwd = r.cwd
  if (typeof terminalId !== 'string' || !terminalId) return null
  if (typeof cwd !== 'string' || !cwd) return null
  if (r.kind === 'shell') {
    return { kind: 'shell', terminalId, cwd, command: optionalString(r.command) }
  }
  if (r.kind === 'agent') {
    return {
      kind: 'agent',
      terminalId,
      cwd,
      agentKind: toAgentKind(optionalString(r.agentKind)),
      sessionId: optionalString(r.sessionId),
      initialPrompt: optionalString(r.initialPrompt),
      teleportSessionId: optionalString(r.teleportSessionId),
      sessionName: optionalString(r.sessionName),
      modelOverride: optionalString(r.modelOverride)
    }
  }
  return null
}

export function createAgentSpawner(deps: AgentSpawnerDeps): AgentSpawner {
  const getAgent = deps.getAgent ?? defaultGetAgent

  function buildAgentSpawnOpts(req: AgentSpawnRequest): { agent: AgentModule; kind: AgentKind; opts: AgentSpawnOpts } {
    const config = deps.getConfig()
    const kind = req.agentKind
    const agent = getAgent(kind)
    const command =
      kind === 'claude'
        ? config.claudeCommand || agent.defaultCommand
        : kind === 'codex'
          ? config.codexCommand || agent.defaultCommand
          : kind === 'opencode'
            ? config.opencodeCommand || agent.defaultCommand
            : kind === 'pi'
              ? config.piCommand || agent.defaultCommand
              : assertNeverAgentKind(kind)
    const mcpConfigPath = kind === 'pi' ? null : deps.writeMcpConfig(req.terminalId)
    const mcpServer = mcpConfigPath ? deps.mcpServerSpec(mcpConfigPath) : null

    const override = req.modelOverride && req.modelOverride.trim() ? req.modelOverride.trim() : undefined
    let systemPrompt: string | undefined
    let tuiFullscreen: boolean | undefined
    let model: string | null
    if (kind === 'claude') {
      const launch = buildClaudeLaunchSettings({
        cwd: req.cwd,
        worktrees: deps.store.getSnapshot().state.worktrees.list,
        config,
        modelOverride: override
      })
      systemPrompt = launch.systemPrompt
      tuiFullscreen = launch.tuiFullscreen
      model = launch.model ?? null
    } else if (kind === 'codex') {
      model = override || config.codexModel || null
    } else if (kind === 'opencode') {
      model = override || config.opencodeModel || null
    } else if (kind === 'pi') {
      model = override || config.piModel || null
    } else {
      model = assertNeverAgentKind(kind)
    }

    const opts: AgentSpawnOpts = {
      command,
      cwd: req.cwd,
      sessionId: req.sessionId,
      initialPrompt: req.initialPrompt,
      teleportSessionId: req.teleportSessionId,
      sessionName: req.sessionName,
      mcpConfigPath,
      mcpServer,
      model,
      systemPrompt,
      tuiFullscreen
    }
    return { agent, kind, opts }
  }

  function agentEnv(kind: AgentKind, agent: AgentModule, opts: AgentSpawnOpts): Record<string, string> {
    const base = configuredEnv(kind, deps.getConfig())
    const mcp: Record<string, string> = opts.mcpConfigPath ? { HARNESS_MCP_CONFIG: opts.mcpConfigPath } : {}
    return { ...base, ...mcp, ...(agent.spawnEnv?.(opts, base, deps.inheritedEnv ?? process.env) ?? {}) }
  }

  function buildAgentLaunch(req: AgentSpawnRequest): { command: string; env: Record<string, string> } {
    const { agent, kind, opts } = buildAgentSpawnOpts(req)
    return { command: agent.buildSpawnArgs(opts), env: agentEnv(kind, agent, opts) }
  }

  function buildAgentCommand(req: AgentSpawnRequest): string {
    return buildAgentLaunch(req).command
  }

  function spawn(
    terminalId: string,
    kind: AgentKind | 'shell',
    clientId: string | undefined,
    reqCols: number | undefined,
    reqRows: number | undefined,
    create: (cols: number, rows: number) => boolean
  ): SpawnOutcome {
    const finish = (outcome: SpawnOutcome, cols: number, rows: number): SpawnOutcome => {
      log('agent-spawn', `${outcome} id=${terminalId} kind=${kind} cols=${cols} rows=${rows} client=${clientId ?? 'main'}`)
      return outcome
    }
    const cols = positive(reqCols, DEFAULT_SPAWN_COLS)
    const rows = positive(reqRows, DEFAULT_SPAWN_ROWS)
    if (deps.pty.hasTerminal(terminalId)) {
      if (clientId) {
        deps.store.dispatch({ type: 'terminals/clientJoined', payload: { terminalId, clientId } })
      }
      return finish('attached', cols, rows)
    }
    if (!create(cols, rows)) return finish('failed', cols, rows)
    if (clientId) {
      deps.store.dispatch({
        type: 'terminals/controlTaken',
        payload: { terminalId, clientId, cols, rows }
      })
    } else {
      deps.store.dispatch({ type: 'terminals/sizeChanged', payload: { terminalId, cols, rows } })
    }
    return finish('spawned', cols, rows)
  }

  function spawnAgentTerminal(req: AgentSpawnRequest, clientId?: string): SpawnOutcome {
    return spawn(req.terminalId, req.agentKind, clientId, req.cols, req.rows, (cols, rows) => {
      const launch = buildAgentLaunch(req)
      return deps.pty.create(req.terminalId, req.cwd, '', ['-ilc', launch.command], launch.env, false, cols, rows)
    })
  }

  function spawnShellTerminal(req: ShellSpawnRequest, clientId?: string): SpawnOutcome {
    return spawn(req.terminalId, 'shell', clientId, req.cols, req.rows, (cols, rows) =>
      deps.pty.create(
        req.terminalId,
        req.cwd,
        '',
        req.command ? ['-ilc', req.command] : ['-il'],
        undefined,
        true,
        cols,
        rows
      )
    )
  }

  function attach(terminalId: string, clientId?: string): TerminalAttachResult {
    const alive = deps.pty.hasTerminal(terminalId)
    if (alive && clientId) {
      deps.store.dispatch({ type: 'terminals/clientJoined', payload: { terminalId, clientId } })
    }
    return { alive, history: deps.pty.getHistory(terminalId) }
  }

  function createOrAttach(
    spec: TerminalSpawnSpec,
    clientId: string,
    cols?: number,
    rows?: number
  ): TerminalCreateResult {
    const outcome =
      spec.kind === 'agent'
        ? spawnAgentTerminal({ ...spec, cols, rows }, clientId)
        : spawnShellTerminal({ ...spec, cols, rows }, clientId)
    return { outcome, history: outcome === 'attached' ? deps.pty.getHistory(spec.terminalId) : '' }
  }

  return { buildAgentCommand, buildAgentLaunch, spawnAgentTerminal, spawnShellTerminal, attach, createOrAttach }
}
