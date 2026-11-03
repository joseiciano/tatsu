#!/usr/bin/env node
// Smoke-only fixture: makes a scratch CODEX_HOME look like the user already
// ran /hooks in Codex and trusted the scratch repo. Tatsu itself never writes
// trusted_hash or trust_level; this script exists so the headless smoke and
// the verify skill can run a fake Codex step.
//
// Usage: CODEX_HOME=<scratch>/... node scripts/codex-trust-fixture.mjs <scratch> <worktree>
//
// Installs Tatsu's Codex hooks with Tatsu's own installHooks(), then appends
// one [hooks.state."<key>"] trusted_hash entry per installed hook, computed by
// Tatsu's own codexHookTrustReport(), and a [projects."<worktree>"] trust
// level. Refuses to run unless CODEX_HOME resolves inside <scratch>.

import { appendFileSync, realpathSync } from 'fs'
import { dirname, join, sep } from 'path'
import { fileURLToPath } from 'url'
import { runnerImport } from 'vite'

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..')
const [scratchArg, worktreeArg] = process.argv.slice(2)

function fail(message) {
  console.error(`codex-trust-fixture: ${message}`)
  process.exit(1)
}

if (!scratchArg || !worktreeArg) fail('usage: codex-trust-fixture.mjs <scratch> <worktree>')
const scratch = realpathSync(scratchArg)
const codexHomeEnv = process.env.CODEX_HOME?.trim()
if (!codexHomeEnv) fail('CODEX_HOME is not set')
const codexHome = realpathSync(codexHomeEnv)
if (!codexHome.startsWith(scratch + sep)) fail(`CODEX_HOME ${codexHome} is not under ${scratch}`)
const worktree = realpathSync(worktreeArg)

const load = async (path) => (await runnerImport(join(REPO, path), { configFile: false, root: REPO, logLevel: 'error' })).module

const codex = await load('src/main/agents/codex.ts')
const trust = await load('src/main/codex-hook-trust/index.ts')
const folders = await load('src/main/folder-trust/index.ts')

if (codex.codexHomeDir() !== codexHome) fail(`Tatsu resolves CODEX_HOME to ${codex.codexHomeDir()}, expected ${codexHome}`)
const configPath = folders.codexConfigPath()
if (!configPath.startsWith(scratch + sep)) fail(`config.toml ${configPath} is not under ${scratch}`)

codex.installHooks()
const report = await codex.codexHookTrustReport()
if (!report.readable || report.entries.length === 0) fail('installed hooks are not readable')

const lines = [`\n[projects.${JSON.stringify(worktree)}]`, 'trust_level = "trusted"']
for (const entry of report.entries) lines.push(`\n[hooks.state.${JSON.stringify(entry.key)}]`, `trusted_hash = ${JSON.stringify(entry.hash)}`)
appendFileSync(configPath, lines.join('\n') + '\n')

const summary = trust.summarizeCodexHookTrust(await codex.codexHookTrustReport(), codex.hookEvents)
if (summary.state !== 'ok') fail(`hook trust is ${JSON.stringify(summary)} after seeding`)
const folder = await folders.checkCodexFolderTrust(worktree)
if (folder.status !== 'trusted') fail(`folder trust is ${folder.status} after seeding`)
console.log(`codex-trust-fixture: ${report.entries.length} hooks trusted, ${worktree} trusted in ${configPath}`)
