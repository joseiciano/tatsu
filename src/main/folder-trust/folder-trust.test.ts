import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mkdtemp, mkdir, writeFile, readFile, realpath, rm, stat, symlink, utimes, readdir } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'

vi.mock('../debug', () => ({ log: vi.fn() }))

import { log } from '../debug'
import {
  checkClaudeFolderTrust,
  checkCodexFolderTrust,
  checkFolderTrust,
  claudeGlobalConfigPath,
  codexConfigPath,
  resolveCodexHome
} from '.'

let rawTmp: string
let T: string

beforeEach(async () => {
  vi.mocked(log).mockClear()
  rawTmp = await mkdtemp(join(tmpdir(), 'folder-trust-'))
  T = await realpath(rawTmp)
})

afterEach(async () => {
  await rm(rawTmp, { recursive: true, force: true })
})

async function makeRepo(root: string, name: string): Promise<string> {
  await mkdir(join(root, name, '.git'), { recursive: true })
  return realpath(join(root, name))
}

async function makeWorktree(mainGitDir: string, wtPath: string, id: string): Promise<string> {
  const gitDir = join(mainGitDir, 'worktrees', id)
  await mkdir(gitDir, { recursive: true })
  await writeFile(join(gitDir, 'commondir'), '../..\n')
  await mkdir(wtPath, { recursive: true })
  await writeFile(join(wtPath, '.git'), `gitdir: ${gitDir}\n`)
  return realpath(wtPath)
}

async function makeBare(root: string, name: string): Promise<string> {
  const dir = join(root, name)
  await mkdir(join(dir, 'worktrees'), { recursive: true })
  await writeFile(join(dir, 'HEAD'), 'ref: refs/heads/main\n')
  return realpath(dir)
}

async function writeClaude(path: string, projects: Record<string, unknown>): Promise<void> {
  await writeFile(
    path,
    JSON.stringify({ numStartups: 1, oauthAccount: { emailAddress: 'x@example.com' }, projects })
  )
}

async function writeCodex(path: string, entries: Record<string, string>): Promise<void> {
  let body = '[features]\nhooks = true\n'
  for (const [key, value] of Object.entries(entries)) {
    body += `\n[projects."${key}"]\ntrust_level = "${value}"\n`
  }
  await writeFile(path, body)
}

describe('checkClaudeFolderTrust', () => {
  it('trusts a repo whose own path is accepted (exact)', async () => {
    const app = await makeRepo(T, 'app')
    const configPath = join(T, 'claude.json')
    await writeClaude(configPath, { [app]: { hasTrustDialogAccepted: true } })

    const result = await checkClaudeFolderTrust(app, { env: {}, claudeConfigPath: configPath })

    expect(result).toEqual({
      agent: 'claude',
      path: app,
      status: 'trusted',
      via: 'exact',
      matchedKey: app,
      reason: null,
      configPath
    })
  })

  it('trusts a non-git leaf through a trusted ancestor', async () => {
    await mkdir(join(T, 'outer', 'inner', 'leaf'), { recursive: true })
    const outer = join(T, 'outer')
    const leaf = join(T, 'outer', 'inner', 'leaf')
    const configPath = join(T, 'claude.json')
    await writeClaude(configPath, { [outer]: { hasTrustDialogAccepted: true } })

    const result = await checkClaudeFolderTrust(leaf, { env: {}, claudeConfigPath: configPath })

    expect(result).toEqual({
      agent: 'claude',
      path: leaf,
      status: 'trusted',
      via: 'ancestor',
      matchedKey: outer,
      reason: null,
      configPath
    })
  })

  it('trusts an untracked subdir of a trusted repo via its canonical root', async () => {
    const app = await makeRepo(T, 'app')
    await mkdir(join(app, 'sub'))
    const configPath = join(T, 'claude.json')
    await writeClaude(configPath, { [app]: { hasTrustDialogAccepted: true } })

    const result = await checkClaudeFolderTrust(join(app, 'sub'), {
      env: {},
      claudeConfigPath: configPath
    })

    expect(result).toMatchObject({ status: 'trusted', via: 'repo-root', matchedKey: app, reason: null })
  })

  it('trusts a sibling linked worktree when only the main checkout is trusted', async () => {
    const app = await makeRepo(T, 'app')
    const wt = await makeWorktree(join(app, '.git'), join(T, 'app-worktrees', 'feat'), 'feat')
    const configPath = join(T, 'claude.json')
    await writeClaude(configPath, { [app]: { hasTrustDialogAccepted: true } })

    const result = await checkClaudeFolderTrust(wt, { env: {}, claudeConfigPath: configPath })

    expect(result).toEqual({
      agent: 'claude',
      path: wt,
      status: 'trusted',
      via: 'repo-root',
      matchedKey: app,
      reason: null,
      configPath
    })
  })

  it('trusts a worktree of a bare repo when the bare directory itself is trusted', async () => {
    const bare = await makeBare(T, 'bare')
    const wt = await makeWorktree(bare, join(bare, 'wt'), 'wt')
    const configPath = join(T, 'claude.json')
    await writeClaude(configPath, { [bare]: { hasTrustDialogAccepted: true } })

    const result = await checkClaudeFolderTrust(wt, { env: {}, claudeConfigPath: configPath })

    expect(result).toMatchObject({ status: 'trusted', via: 'repo-root', matchedKey: bare })
  })

  it('reports no-entry when only an unrelated folder is trusted', async () => {
    await mkdir(join(T, 'plain'))
    const plain = join(T, 'plain')
    const configPath = join(T, 'claude.json')
    await writeClaude(configPath, { [join(T, 'other')]: { hasTrustDialogAccepted: true } })

    const result = await checkClaudeFolderTrust(plain, { env: {}, claudeConfigPath: configPath })

    expect(result).toEqual({
      agent: 'claude',
      path: plain,
      status: 'untrusted',
      via: null,
      matchedKey: null,
      reason: 'no-entry',
      configPath
    })
  })

  it('does not inherit trust across a nested git toplevel', async () => {
    await mkdir(join(T, 'outer'))
    const outer = join(T, 'outer')
    const nested = await makeRepo(outer, 'nested')
    const configPath = join(T, 'claude.json')
    await writeClaude(configPath, { [outer]: { hasTrustDialogAccepted: true } })

    const result = await checkClaudeFolderTrust(nested, { env: {}, claudeConfigPath: configPath })

    expect(result).toMatchObject({ status: 'untrusted', via: null, matchedKey: null, reason: 'no-entry' })
  })

  it('keeps walking past an explicit hasTrustDialogAccepted: false entry', async () => {
    await mkdir(join(T, 'outer', 'leaf'), { recursive: true })
    const outer = join(T, 'outer')
    const leaf = join(T, 'outer', 'leaf')
    const configPath = join(T, 'claude.json')
    await writeClaude(configPath, {
      [leaf]: { hasTrustDialogAccepted: false },
      [outer]: { hasTrustDialogAccepted: true }
    })

    const result = await checkClaudeFolderTrust(leaf, { env: {}, claudeConfigPath: configPath })

    expect(result).toMatchObject({ status: 'trusted', via: 'ancestor', matchedKey: outer })
  })

  it('only counts the literal boolean true', async () => {
    const app = await makeRepo(T, 'app')
    const configPath = join(T, 'claude.json')
    await writeClaude(configPath, { [app]: { hasTrustDialogAccepted: 'true' } })

    const result = await checkClaudeFolderTrust(app, { env: {}, claudeConfigPath: configPath })

    expect(result).toMatchObject({ status: 'untrusted', reason: 'no-entry', matchedKey: null })
  })

  it('reports config-missing and echoes the config path when the file does not exist', async () => {
    const app = await makeRepo(T, 'app')
    const configPath = join(T, 'absent.json')

    const result = await checkClaudeFolderTrust(app, { env: {}, claudeConfigPath: configPath })

    expect(result).toEqual({
      agent: 'claude',
      path: app,
      status: 'untrusted',
      via: null,
      matchedKey: null,
      reason: 'config-missing',
      configPath
    })
  })

  it('reports unknown/config-malformed for unparseable JSON and logs once without file contents', async () => {
    const app = await makeRepo(T, 'app')
    const configPath = join(T, 'claude.json')
    await writeFile(configPath, '{not json')

    const result = await checkClaudeFolderTrust(app, { env: {}, claudeConfigPath: configPath })

    expect(result).toMatchObject({ status: 'unknown', via: null, reason: 'config-malformed', configPath })
    expect(vi.mocked(log)).toHaveBeenCalledTimes(1)
    expect(vi.mocked(log).mock.calls[0][0]).toBe('folder-trust')
    expect(JSON.stringify(vi.mocked(log).mock.calls)).not.toContain('not json')
  })

  it.each([
    { name: 'array top level', body: '[]', status: 'unknown', reason: 'config-malformed' },
    { name: 'empty object', body: '{}', status: 'untrusted', reason: 'no-entry' },
    { name: 'projects not an object', body: '{"projects": 5}', status: 'untrusted', reason: 'no-entry' }
  ])('maps $name to $status/$reason', async ({ body, status, reason }) => {
    const app = await makeRepo(T, 'app')
    const configPath = join(T, 'claude.json')
    await writeFile(configPath, body)

    const result = await checkClaudeFolderTrust(app, { env: {}, claudeConfigPath: configPath })

    expect(result).toMatchObject({ status, reason, via: null })
  })

  it('resolves a symlinked path to its target before matching', async () => {
    const app = await makeRepo(T, 'app')
    await symlink(app, join(T, 'link'))
    const configPath = join(T, 'claude.json')
    await writeClaude(configPath, { [app]: { hasTrustDialogAccepted: true } })

    const result = await checkClaudeFolderTrust(join(T, 'link'), {
      env: {},
      claudeConfigPath: configPath
    })

    expect(result).toMatchObject({ path: app, status: 'trusted', matchedKey: app })
  })

  it('matches a config key that has a trailing slash', async () => {
    const app = await makeRepo(T, 'app')
    const configPath = join(T, 'claude.json')
    await writeClaude(configPath, { [`${app}/`]: { hasTrustDialogAccepted: true } })

    const result = await checkClaudeFolderTrust(app, { env: {}, claudeConfigPath: configPath })

    expect(result).toMatchObject({ status: 'trusted', via: 'exact', matchedKey: `${app}/` })
  })

  it('matches an NFD config key against an NFC path', async () => {
    const nfc = join(T, 'café')
    await mkdir(nfc)
    const configPath = join(T, 'claude.json')
    await writeClaude(configPath, { [join(T, 'café')]: { hasTrustDialogAccepted: true } })

    const result = await checkClaudeFolderTrust(nfc, { env: {}, claudeConfigPath: configPath })

    expect(result).toMatchObject({ status: 'trusted', via: 'exact', matchedKey: join(T, 'cafe\u0301') })
  })

  it.each([
    { value: '1', trusted: true },
    { value: 'true', trusted: true },
    { value: 'TRUE', trusted: true },
    { value: 'yes', trusted: true },
    { value: '0', trusted: false },
    { value: 'false', trusted: false },
    { value: 'False', trusted: false },
    { value: '', trusted: false }
  ])('CLAUDE_CODE_SANDBOXED=$value -> trusted: $trusted', async ({ value, trusted }) => {
    const app = await makeRepo(T, 'app')
    const configPath = join(T, 'absent.json')

    const result = await checkClaudeFolderTrust(app, {
      env: { CLAUDE_CODE_SANDBOXED: value },
      claudeConfigPath: configPath
    })

    if (trusted) {
      expect(result).toMatchObject({ status: 'trusted', via: 'env', matchedKey: null, reason: null })
    } else {
      expect(result).toMatchObject({ status: 'untrusted', via: null, reason: 'config-missing' })
    }
  })

  it('re-reads the config on every call so a newly accepted dialog is seen', async () => {
    const app = await makeRepo(T, 'app')
    const configPath = join(T, 'claude.json')
    await writeClaude(configPath, {})
    const before = await checkClaudeFolderTrust(app, { env: {}, claudeConfigPath: configPath })

    await writeClaude(configPath, { [app]: { hasTrustDialogAccepted: true } })
    const after = await checkClaudeFolderTrust(app, { env: {}, claudeConfigPath: configPath })

    expect(before.status).toBe('untrusted')
    expect(after.status).toBe('trusted')
  })
})

describe('checkCodexFolderTrust', () => {
  it('trusts an exact entry', async () => {
    const app = await makeRepo(T, 'app')
    const configPath = join(T, 'config.toml')
    await writeCodex(configPath, { [app]: 'trusted' })

    const result = await checkCodexFolderTrust(app, { env: {}, codexConfigPath: configPath })

    expect(result).toEqual({
      agent: 'codex',
      path: app,
      status: 'trusted',
      via: 'exact',
      matchedKey: app,
      reason: null,
      configPath
    })
  })

  it('trusts a linked worktree through its root git project', async () => {
    const app = await makeRepo(T, 'app')
    const wt = await makeWorktree(join(app, '.git'), join(T, 'app-worktrees', 'feat'), 'feat')
    const configPath = join(T, 'config.toml')
    await writeCodex(configPath, { [app]: 'trusted' })

    const result = await checkCodexFolderTrust(wt, { env: {}, codexConfigPath: configPath })

    expect(result).toMatchObject({ path: wt, status: 'trusted', via: 'repo-root', matchedKey: app })
  })

  it('trusts a subdirectory of a normal repo through its root git project', async () => {
    const app = await makeRepo(T, 'app')
    await mkdir(join(app, 'sub'))
    const configPath = join(T, 'config.toml')
    await writeCodex(configPath, { [app]: 'trusted' })

    const result = await checkCodexFolderTrust(join(app, 'sub'), {
      env: {},
      codexConfigPath: configPath
    })

    expect(result).toMatchObject({ status: 'trusted', via: 'repo-root', matchedKey: app })
  })

  it('does not trust a bare-repo worktree through the bare dir or its parent', async () => {
    const bare = await makeBare(T, 'bare')
    const wt = await makeWorktree(bare, join(bare, 'wt'), 'wt')
    const configPath = join(T, 'config.toml')
    await writeCodex(configPath, { [T]: 'trusted', [bare]: 'trusted' })

    const result = await checkCodexFolderTrust(wt, { env: {}, codexConfigPath: configPath })

    expect(result).toMatchObject({ status: 'untrusted', via: null, matchedKey: null, reason: 'no-entry' })
  })

  it('trusts a bare-repo worktree by its exact entry', async () => {
    const bare = await makeBare(T, 'bare')
    const wt = await makeWorktree(bare, join(bare, 'wt'), 'wt')
    const configPath = join(T, 'config.toml')
    await writeCodex(configPath, { [wt]: 'trusted' })

    const result = await checkCodexFolderTrust(wt, { env: {}, codexConfigPath: configPath })

    expect(result).toMatchObject({ status: 'trusted', via: 'exact', matchedKey: wt })
  })

  it('lets an exact untrusted entry win over a trusted repo root', async () => {
    const app = await makeRepo(T, 'app')
    const wt = await makeWorktree(join(app, '.git'), join(T, 'app-worktrees', 'feat'), 'feat')
    const configPath = join(T, 'config.toml')
    await writeCodex(configPath, { [app]: 'trusted', [wt]: 'untrusted' })

    const result = await checkCodexFolderTrust(wt, { env: {}, codexConfigPath: configPath })

    expect(result).toEqual({
      agent: 'codex',
      path: wt,
      status: 'untrusted',
      via: null,
      matchedKey: wt,
      reason: 'explicitly-untrusted',
      configPath
    })
  })

  it('reports explicitly-untrusted when the repo root is marked untrusted', async () => {
    const app = await makeRepo(T, 'app')
    const wt = await makeWorktree(join(app, '.git'), join(T, 'app-worktrees', 'feat'), 'feat')
    const configPath = join(T, 'config.toml')
    await writeCodex(configPath, { [app]: 'untrusted' })

    const result = await checkCodexFolderTrust(wt, { env: {}, codexConfigPath: configPath })

    expect(result).toMatchObject({ status: 'untrusted', matchedKey: app, reason: 'explicitly-untrusted' })
  })

  it('ignores an unrecognized trust_level and falls through to the repo root', async () => {
    const app = await makeRepo(T, 'app')
    const wt = await makeWorktree(join(app, '.git'), join(T, 'app-worktrees', 'feat'), 'feat')
    const configPath = join(T, 'config.toml')
    await writeCodex(configPath, { [app]: 'trusted', [wt]: 'maybe' })

    const result = await checkCodexFolderTrust(wt, { env: {}, codexConfigPath: configPath })

    expect(result).toMatchObject({ status: 'trusted', via: 'repo-root', matchedKey: app })
  })

  it('does not inherit trust from a parent of a non-git dir', async () => {
    await mkdir(join(T, 'outer', 'leaf'), { recursive: true })
    const configPath = join(T, 'config.toml')
    await writeCodex(configPath, { [join(T, 'outer')]: 'trusted' })

    const result = await checkCodexFolderTrust(join(T, 'outer', 'leaf'), {
      env: {},
      codexConfigPath: configPath
    })

    expect(result).toMatchObject({ status: 'untrusted', matchedKey: null, reason: 'no-entry' })
  })

  it('reports config-missing when config.toml does not exist', async () => {
    const app = await makeRepo(T, 'app')
    const configPath = join(T, 'absent.toml')

    const result = await checkCodexFolderTrust(app, { env: {}, codexConfigPath: configPath })

    expect(result).toEqual({
      agent: 'codex',
      path: app,
      status: 'untrusted',
      via: null,
      matchedKey: null,
      reason: 'config-missing',
      configPath
    })
  })

  it('reports unknown/config-malformed for invalid TOML and logs once without file contents', async () => {
    const app = await makeRepo(T, 'app')
    const configPath = join(T, 'config.toml')
    await writeFile(configPath, '[projects."leaksentinel"')

    const result = await checkCodexFolderTrust(app, { env: {}, codexConfigPath: configPath })

    expect(result).toMatchObject({ status: 'unknown', via: null, reason: 'config-malformed' })
    expect(vi.mocked(log)).toHaveBeenCalledTimes(1)
    expect(vi.mocked(log).mock.calls[0][0]).toBe('folder-trust')
    expect(JSON.stringify(vi.mocked(log).mock.calls)).not.toContain('leaksentinel')
  })

  it('reports no-entry when the config has no projects table', async () => {
    const app = await makeRepo(T, 'app')
    const configPath = join(T, 'config.toml')
    await writeCodex(configPath, {})

    const result = await checkCodexFolderTrust(app, { env: {}, codexConfigPath: configPath })

    expect(result).toMatchObject({ status: 'untrusted', reason: 'no-entry' })
  })
})

describe('config paths', () => {
  it.each([
    { name: 'no env', env: {}, expected: '/h/.claude.json' },
    { name: 'CLAUDE_CONFIG_DIR set', env: { CLAUDE_CONFIG_DIR: '/c' }, expected: '/c/.claude.json' },
    { name: 'CLAUDE_CONFIG_DIR whitespace-only', env: { CLAUDE_CONFIG_DIR: '   ' }, expected: '/h/.claude.json' }
  ])('claudeGlobalConfigPath: $name', ({ env, expected }) => {
    expect(claudeGlobalConfigPath(env, '/h')).toBe(expected)
  })

  it('claudeGlobalConfigPath prefers a legacy .config.json inside CLAUDE_CONFIG_DIR', async () => {
    await writeFile(join(T, '.config.json'), '{}')

    expect(claudeGlobalConfigPath({ CLAUDE_CONFIG_DIR: T }, '/h')).toBe(join(T, '.config.json'))
  })

  it('claudeGlobalConfigPath prefers a legacy ~/.claude/.config.json when CLAUDE_CONFIG_DIR is unset', async () => {
    await mkdir(join(T, '.claude'))
    await writeFile(join(T, '.claude', '.config.json'), '{}')

    expect(claudeGlobalConfigPath({}, T)).toBe(join(T, '.claude', '.config.json'))
  })

  it.each([
    { name: 'unset', env: {}, expected: '/h/.codex' },
    { name: 'whitespace-only', env: { CODEX_HOME: '   ' }, expected: '/h/.codex' },
    { name: 'empty', env: { CODEX_HOME: '' }, expected: '/h/.codex' }
  ])('resolveCodexHome with CODEX_HOME $name falls back to <home>/.codex', ({ env, expected }) => {
    expect(resolveCodexHome(env, '/h')).toBe(expected)
  })

  it('resolveCodexHome does not canonicalize the default <home>/.codex', async () => {
    await mkdir(join(rawTmp, '.codex'))

    expect(resolveCodexHome({}, rawTmp)).toBe(join(rawTmp, '.codex'))
  })

  it('codexConfigPath appends config.toml to the resolved home', () => {
    expect(codexConfigPath({}, '/h')).toBe('/h/.codex/config.toml')
  })

  it('resolveCodexHome returns a non-existent CODEX_HOME as given', () => {
    const nope = join(T, 'nope')

    expect(resolveCodexHome({ CODEX_HOME: nope }, '/h')).toBe(nope)
  })

  it('resolveCodexHome canonicalizes a symlinked CODEX_HOME', async () => {
    await mkdir(join(T, 'real'))
    await symlink(join(T, 'real'), join(T, 'link'))
    const env = { CODEX_HOME: join(T, 'link') }

    expect(resolveCodexHome(env, '/h')).toBe(join(T, 'real'))
    expect(codexConfigPath(env, '/h')).toBe(join(T, 'real', 'config.toml'))
  })

  it('resolveCodexHome canonicalizes an unresolved tmpdir-based CODEX_HOME', () => {
    expect(resolveCodexHome({ CODEX_HOME: rawTmp }, '/h')).toBe(T)
  })

  it('checkFolderTrust reports each agent from its own config', async () => {
    const app = await makeRepo(T, 'app')
    const claudeConfigPath = join(T, 'claude.json')
    const codexPath = join(T, 'config.toml')
    await writeClaude(claudeConfigPath, { [app]: { hasTrustDialogAccepted: true } })
    await writeCodex(codexPath, { [app]: 'untrusted' })

    const result = await checkFolderTrust(app, {
      env: {},
      claudeConfigPath,
      codexConfigPath: codexPath
    })

    expect(Object.keys(result).sort()).toEqual(['claude', 'codex'])
    expect(result.claude).toMatchObject({ agent: 'claude', status: 'trusted', configPath: claudeConfigPath })
    expect(result.codex).toMatchObject({
      agent: 'codex',
      status: 'untrusted',
      reason: 'explicitly-untrusted',
      configPath: codexPath
    })
  })
})

describe('read-only', () => {
  it('never modifies the config files or creates files in the config dir', async () => {
    const app = await makeRepo(T, 'app')
    const wt = await makeWorktree(join(app, '.git'), join(T, 'app-worktrees', 'feat'), 'feat')
    const bare = await makeBare(T, 'bare')
    const bareWt = await makeWorktree(bare, join(bare, 'wt'), 'wt')
    await mkdir(join(T, 'outer', 'leaf'), { recursive: true })
    const configDir = join(T, 'config')
    await mkdir(configDir)
    const claudePath = join(configDir, '.claude.json')
    const codexPath = join(configDir, 'config.toml')
    await writeClaude(claudePath, {
      [app]: { hasTrustDialogAccepted: true },
      [join(T, 'outer')]: { hasTrustDialogAccepted: true }
    })
    await writeCodex(codexPath, { [app]: 'trusted', [bareWt]: 'untrusted' })
    const past = new Date('2001-01-01T00:00:00Z')
    await utimes(claudePath, past, past)
    await utimes(codexPath, past, past)
    const claudeBytes = await readFile(claudePath)
    const codexBytes = await readFile(codexPath)
    const claudeMtime = (await stat(claudePath)).mtimeMs
    const codexMtime = (await stat(codexPath)).mtimeMs
    const entriesBefore = (await readdir(configDir)).sort()

    const opts = { env: {}, claudeConfigPath: claudePath, codexConfigPath: codexPath }
    for (const p of [app, wt, bareWt, join(T, 'outer', 'leaf'), join(T, 'missing-dir')]) {
      await checkClaudeFolderTrust(p, opts)
      await checkCodexFolderTrust(p, opts)
      await checkFolderTrust(p, opts)
    }
    await checkFolderTrust(app, {
      env: {},
      claudeConfigPath: join(configDir, 'absent.json'),
      codexConfigPath: join(configDir, 'absent.toml')
    })
    claudeGlobalConfigPath({ CLAUDE_CONFIG_DIR: configDir }, '/h')
    codexConfigPath({ CODEX_HOME: configDir }, '/h')

    expect((await readFile(claudePath)).equals(claudeBytes)).toBe(true)
    expect((await readFile(codexPath)).equals(codexBytes)).toBe(true)
    expect((await stat(claudePath)).mtimeMs).toBe(claudeMtime)
    expect((await stat(codexPath)).mtimeMs).toBe(codexMtime)
    expect((await readdir(configDir)).sort()).toEqual(entriesBefore)
  })
})
