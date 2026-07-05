import type { WorktreeContainerMetadata } from '../../shared/state/worktrees'
import type { RepoContainerConfig } from '../../shared/state/repo-configs'

/** Result of a Docker command execution. */
export interface DockerRunResult {
  stdout: string
  stderr: string
  exitCode: number
}

/** Options passed to a DockerRunner invocation. */
export interface DockerRunOptions {
  cwd?: string
  env?: Record<string, string>
  timeoutMs?: number
  onOutput?: (chunk: string) => void
}

/** Abstraction over `docker` CLI invocation, injected for testability. */
export interface DockerRunner {
  run(args: string[], opts?: DockerRunOptions): Promise<DockerRunResult>
}

/** Fully-resolved container configuration after merging repo config with defaults. */
export interface ResolvedWorktreeContainerConfig {
  image: string
  dockerfile?: string
  managedDockerfile?: string
  buildContext?: string
  workdir: string
  shell: string
  env: Record<string, string>
  ports: number[]
  volumes: Array<{ source: string; target: string; readOnly?: boolean }>
}

/** Container metadata returned after successful creation or when reusing
 *  an existing container. Status is 'running' after fresh creation, or
 *  'starting' when reusing a container that hasn't been verified yet. */
export interface CreatedWorktreeContainer extends WorktreeContainerMetadata {
  status: 'running' | 'starting'
}

/** Public manager interface for worktree container lifecycle.
 *  All Docker interactions go through this surface so tests can inject a fake runner. */
export interface WorktreeContainers {
  checkDockerAvailable(): Promise<{ ok: boolean; error?: string }>
  resolveContainerConfig(repoRoot: string, worktreePath: string, repoConfig?: RepoContainerConfig): ResolvedWorktreeContainerConfig
  ensureImage(config: ResolvedWorktreeContainerConfig): Promise<void>
  createForWorktree(repoRoot: string, worktreePath: string, config: ResolvedWorktreeContainerConfig): Promise<CreatedWorktreeContainer>
  execInContainer(containerId: string, command: string, opts?: { workdir?: string; env?: Record<string, string>; shell?: string; onOutput?: (chunk: string) => void }): Promise<DockerRunResult>
  isContainerRunning(containerId: string): Promise<boolean>
  restartContainer(containerId: string): Promise<void>
  stopContainer(containerId: string): Promise<void>
}
