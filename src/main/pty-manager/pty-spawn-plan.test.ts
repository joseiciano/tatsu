import { describe, it, expect } from 'vitest'
import { buildPtySpawnPlan, type PtySpawnInput, type WorktreeContainerResolver } from './pty-spawn-plan'

describe('buildPtySpawnPlan', () => {
  function hostInput(overrides: Partial<PtySpawnInput> = {}): PtySpawnInput {
    return {
      id: 'term-1',
      cwd: '/worktrees/my-project',
      command: '',
      args: [],
      extraEnv: {},
      isShell: true,
      ...overrides
    }
  }

  it('non-container worktree spawns host command with terminal ids in env', () => {
    const plan = buildPtySpawnPlan(hostInput())
    expect(plan.kind).toBe('spawn')
    if (plan.kind !== 'spawn') return
    expect(plan.command).toBe('/bin/zsh')
    expect(plan.cwd).toBe('/worktrees/my-project')
    expect(plan.isContainer).toBe(false)
    expect(plan.env.HARNESS_TERMINAL_ID).toBe('term-1')
    expect(plan.env.CLAUDE_HARNESS_ID).toBe('term-1')
    expect(plan.env.SHELL).toBeDefined()
  })

  it('non-container worktree preserves explicit command', () => {
    const plan = buildPtySpawnPlan(hostInput({ command: '/usr/bin/bash', args: ['-l'] }))
    expect(plan.kind).toBe('spawn')
    if (plan.kind !== 'spawn') return
    expect(plan.command).toBe('/usr/bin/bash')
    expect(plan.args).toEqual(['-l'])
  })

  it('container interactive shell spawns docker exec with -it flags', () => {
    const resolver: WorktreeContainerResolver = () => ({
      worktreePath: '/worktrees/my-project',
      name: 'tatsu-wt-my-project-abc',
      shell: '/bin/bash',
      workdir: '/workspace',
      status: 'running',
      error: undefined
    })
    const plan = buildPtySpawnPlan(hostInput({ resolver }))
    expect(plan.kind).toBe('spawn')
    if (plan.kind !== 'spawn') return
    expect(plan.isContainer).toBe(true)
    expect(plan.command).toBe('docker')
    expect(plan.args).toContain('-it')
    expect(plan.args).toContain('--workdir')
    expect(plan.args).toContain('/workspace')
    expect(plan.args).toContain('tatsu-wt-my-project-abc')
    expect(plan.args).toContain('/bin/bash')
    // Host cwd preserved for Docker process context
    expect(plan.cwd).toBe('/worktrees/my-project')
    // Terminal ids passed into container via -e
    const args = plan.args
    expect(args).toContain('-e')
    const harnessIdx = args.indexOf('-e')
    expect(args[harnessIdx + 1]).toMatch(/HARNESS_TERMINAL_ID=term-1/)
    const claudeIdx = args.indexOf('-e', harnessIdx + 1)
    expect(args[claudeIdx + 1]).toMatch(/CLAUDE_HARNESS_ID=term-1/)
  })

  it('container command shell converts -ilc <cmd> to <shell> -c <cmd>', () => {
    const resolver: WorktreeContainerResolver = () => ({
      worktreePath: '/worktrees/my-project',
      name: 'tatsu-wt-my-project-abc',
      shell: '/bin/bash',
      workdir: '/workspace',
      status: 'running',
      error: undefined
    })
    const plan = buildPtySpawnPlan(hostInput({
      resolver,
      command: '',
      args: ['-ilc', 'npm run dev'],
      isShell: true
    }))
    expect(plan.kind).toBe('spawn')
    if (plan.kind !== 'spawn') return
    expect(plan.isContainer).toBe(true)
    expect(plan.command).toBe('docker')
    // Should NOT contain host zsh flags
    expect(plan.args).not.toContain('-ilc')
    // Should contain <shell> -c <cmd>
    expect(plan.args).toContain('/bin/bash')
    const shellIdx = plan.args.indexOf('/bin/bash')
    expect(plan.args[shellIdx + 1]).toBe('-c')
    expect(plan.args[shellIdx + 2]).toBe('npm run dev')
  })

  it('container command shell converts -lc <cmd> to <shell> -c <cmd>', () => {
    const resolver: WorktreeContainerResolver = () => ({
      worktreePath: '/worktrees/my-project',
      name: 'tatsu-wt-my-project-abc',
      shell: '/bin/sh',
      workdir: '/workspace',
      status: 'running',
      error: undefined
    })
    const plan = buildPtySpawnPlan(hostInput({
      resolver,
      args: ['-lc', 'claude --help'],
      isShell: true
    }))
    expect(plan.kind).toBe('spawn')
    if (plan.kind !== 'spawn') return
    expect(plan.args).toContain('/bin/sh')
    const shellIdx = plan.args.indexOf('/bin/sh')
    expect(plan.args[shellIdx + 1]).toBe('-c')
    expect(plan.args[shellIdx + 2]).toBe('claude --help')
  })

  it('child host cwd maps to container child cwd', () => {
    const resolver: WorktreeContainerResolver = () => ({
      worktreePath: '/worktrees/my-project',
      name: 'tatsu-wt-my-project-abc',
      shell: '/bin/sh',
      workdir: '/workspace',
      status: 'running',
      error: undefined
    })
    const plan = buildPtySpawnPlan(hostInput({
      resolver,
      cwd: '/worktrees/my-project/src'
    }))
    expect(plan.kind).toBe('spawn')
    if (plan.kind !== 'spawn') return
    expect(plan.args).toContain('--workdir')
    const wdIdx = plan.args.indexOf('--workdir')
    expect(plan.args[wdIdx + 1]).toBe('/workspace/src')
  })

  it('grandchild host cwd maps correctly', () => {
    const resolver: WorktreeContainerResolver = () => ({
      worktreePath: '/worktrees/my-project',
      name: 'tatsu-wt-my-project-abc',
      shell: '/bin/sh',
      workdir: '/workspace',
      status: 'running',
      error: undefined
    })
    const plan = buildPtySpawnPlan(hostInput({
      resolver,
      cwd: '/worktrees/my-project/packages/foo'
    }))
    expect(plan.kind).toBe('spawn')
    if (plan.kind !== 'spawn') return
    const wdIdx = plan.args.indexOf('--workdir')
    expect(plan.args[wdIdx + 1]).toBe('/workspace/packages/foo')
  })

  it('stopped container returns error with restart hint', () => {
    const resolver: WorktreeContainerResolver = () => ({
      worktreePath: '/worktrees/my-project',
      name: 'tatsu-wt-my-project-abc',
      shell: '/bin/sh',
      workdir: '/workspace',
      status: 'stopped',
      error: undefined
    })
    const plan = buildPtySpawnPlan(hostInput({ resolver }))
    expect(plan.kind).toBe('error')
    if (plan.kind !== 'error') return
    expect(plan.message).toMatch(/stopped/i)
    expect(plan.message).toMatch(/restart|recreate/i)
  })

  it('error container returns error with clear message', () => {
    const resolver: WorktreeContainerResolver = () => ({
      worktreePath: '/worktrees/my-project',
      name: 'tatsu-wt-my-project-abc',
      shell: '/bin/sh',
      workdir: '/workspace',
      status: 'error',
      error: 'Docker daemon unavailable'
    })
    const plan = buildPtySpawnPlan(hostInput({ resolver }))
    expect(plan.kind).toBe('error')
    if (plan.kind !== 'error') return
    expect(plan.message).toMatch(/error/i)
    expect(plan.message).toMatch(/Docker daemon unavailable/)
  })

  it('starting container returns error with hint', () => {
    const resolver: WorktreeContainerResolver = () => ({
      worktreePath: '/worktrees/my-project',
      name: 'tatsu-wt-my-project-abc',
      shell: '/bin/sh',
      workdir: '/workspace',
      status: 'starting',
      error: undefined
    })
    const plan = buildPtySpawnPlan(hostInput({ resolver }))
    expect(plan.kind).toBe('error')
    if (plan.kind !== 'error') return
    expect(plan.message).toMatch(/not running|starting/i)
  })

  it('invalid env key returns clear error', () => {
    const plan = buildPtySpawnPlan(hostInput({ extraEnv: { 'BAD-KEY': 'val' } }))
    expect(plan.kind).toBe('error')
    if (plan.kind !== 'error') return
    expect(plan.message).toMatch(/invalid.*env.*key/i)
    expect(plan.message).toMatch(/BAD-KEY/)
  })

  it('no resolver or resolver returning undefined falls back to host', () => {
    const plan = buildPtySpawnPlan(hostInput({ resolver: undefined }))
    expect(plan.kind).toBe('spawn')
    if (plan.kind !== 'spawn') return
    expect(plan.isContainer).toBe(false)
  })

  it('resolver returning undefined for a cwd falls back to host', () => {
    const resolver: WorktreeContainerResolver = () => undefined
    const plan = buildPtySpawnPlan(hostInput({ resolver }))
    expect(plan.kind).toBe('spawn')
    if (plan.kind !== 'spawn') return
    expect(plan.isContainer).toBe(false)
  })

  it('extraEnv forwarded to container via -e KEY only (value not in args)', () => {
    const resolver: WorktreeContainerResolver = () => ({
      worktreePath: '/worktrees/my-project',
      name: 'tatsu-wt-my-project-abc',
      shell: '/bin/sh',
      workdir: '/workspace',
      status: 'running',
      error: undefined
    })
    const plan = buildPtySpawnPlan(hostInput({
      resolver,
      extraEnv: { MY_VAR: 'hello', SECRET_KEY: 's3cret' }
    }))
    expect(plan.kind).toBe('spawn')
    if (plan.kind !== 'spawn') return
    // extraEnv keys should appear as bare -e KEY (no =value) in docker args
    const eArgs = plan.args.filter((a, i) => plan.args[i - 1] === '-e')
    expect(eArgs).toContain('MY_VAR')
    expect(eArgs).toContain('SECRET_KEY')
    // Secret values must NOT appear in args (visible in host process argv)
    expect(plan.args).not.toContain('MY_VAR=hello')
    expect(plan.args).not.toContain('SECRET_KEY=s3cret')
    // Values must be in the host docker process env instead
    expect(plan.env.MY_VAR).toBe('hello')
    expect(plan.env.SECRET_KEY).toBe('s3cret')
  })

  it('TERM and COLORTERM injected into container env', () => {
    const resolver: WorktreeContainerResolver = () => ({
      worktreePath: '/worktrees/my-project',
      name: 'tatsu-wt-my-project-abc',
      shell: '/bin/sh',
      workdir: '/workspace',
      status: 'running',
      error: undefined
    })
    const plan = buildPtySpawnPlan(hostInput({ resolver }))
    expect(plan.kind).toBe('spawn')
    if (plan.kind !== 'spawn') return
    const eArgs = plan.args.filter((a, i) => plan.args[i - 1] === '-e')
    expect(eArgs.some(e => e.startsWith('TERM='))).toBe(true)
    expect(eArgs.some(e => e.startsWith('COLORTERM='))).toBe(true)
  })

  it('container shell defaults to /bin/sh when metadata shell empty', () => {
    const resolver: WorktreeContainerResolver = () => ({
      worktreePath: '/worktrees/my-project',
      name: 'tatsu-wt-my-project-abc',
      shell: '',
      workdir: '/workspace',
      status: 'running',
      error: undefined
    })
    const plan = buildPtySpawnPlan(hostInput({ resolver }))
    expect(plan.kind).toBe('spawn')
    if (plan.kind !== 'spawn') return
    expect(plan.args).toContain('/bin/sh')
  })

  it('fish shell gets -c flag', () => {
    const resolver: WorktreeContainerResolver = () => ({
      worktreePath: '/worktrees/my-project',
      name: 'tatsu-wt-my-project-abc',
      shell: '/usr/bin/fish',
      workdir: '/workspace',
      status: 'running',
      error: undefined
    })
    const plan = buildPtySpawnPlan(hostInput({
      resolver,
      args: ['-ilc', 'echo hello'],
      isShell: true
    }))
    expect(plan.kind).toBe('spawn')
    if (plan.kind !== 'spawn') return
    const shellIdx = plan.args.indexOf('/usr/bin/fish')
    expect(plan.args[shellIdx + 1]).toBe('-c')
    expect(plan.args[shellIdx + 2]).toBe('echo hello')
  })

  it('cwd outside worktree path returns error', () => {
    const resolver: WorktreeContainerResolver = () => ({
      worktreePath: '/worktrees/my-project',
      name: 'tatsu-wt-my-project-abc',
      shell: '/bin/sh',
      workdir: '/workspace',
      status: 'running',
      error: undefined
    })
    const plan = buildPtySpawnPlan(hostInput({
      resolver,
      cwd: '/worktrees/other'
    }))
    expect(plan.kind).toBe('error')
    if (plan.kind !== 'error') return
    expect(plan.message).toMatch(/not inside|outside/i)
  })

  it('non-shell command passes through unchanged to container', () => {
    const resolver: WorktreeContainerResolver = () => ({
      worktreePath: '/worktrees/my-project',
      name: 'tatsu-wt-my-project-abc',
      shell: '/bin/sh',
      workdir: '/workspace',
      status: 'running',
      error: undefined
    })
    const plan = buildPtySpawnPlan(hostInput({
      resolver,
      command: 'claude',
      args: ['--help'],
      isShell: false
    }))
    expect(plan.kind).toBe('spawn')
    if (plan.kind !== 'spawn') return
    expect(plan.args).toContain('claude')
    expect(plan.args).toContain('--help')
  })
})
