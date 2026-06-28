import type { WorktreeContainerMetadata } from '../../shared/state/worktrees'
import type { RepoContainerConfig } from '../../shared/state/repo-configs'

export interface DockerRunResult {
  stdout: string
  stderr: string
  exitCode: number
}

export interface DockerRunOptions {
  cwd?: string
  env?: Record<string, string>
  timeoutMs?: number
}

export interface DockerRunner {
  run(args: string[], opts?: DockerRunOptions): Promise<DockerRunResult>
}

export interface ResolvedWorktreeContainerConfig {
  image: string
  dockerfile?: string
  workdir: string
  shell: string
  env: Record<string, string>
  ports: number[]
  volumes: Array<{ source: string; target: string }>
}

export interface CreatedWorktreeContainer extends WorktreeContainerMetadata {
  status: 'running'
}

export interface WorktreeContainers {
  checkDockerAvailable(): Promise<{ ok: boolean; error?: string }>
  resolveContainerConfig(repoRoot: string, worktreePath: string, repoConfig?: RepoContainerConfig): ResolvedWorktreeContainerConfig
  ensureImage(config: ResolvedWorktreeContainerConfig): Promise<void>
  createForWorktree(repoRoot: string, worktreePath: string, config: ResolvedWorktreeContainerConfig): Promise<CreatedWorktreeContainer>
  execInContainer(containerId: string, command: string, opts?: { workdir?: string; env?: Record<string, string>; shell?: string }): Promise<DockerRunResult>
  stopContainer(containerId: string): Promise<void>
}