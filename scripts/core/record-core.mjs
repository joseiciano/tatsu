import { spawnSync } from 'node:child_process'
import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('../../', import.meta.url))
const args = process.argv.slice(2)
if (args[0] === '--') args.shift()
const unknown = args.filter((arg) => arg !== '--update')
if (unknown.length > 0) {
  console.error(`fixtures:record-core: unknown argument(s): ${unknown.join(' ')} (only --update is accepted)`)
  process.exit(2)
}

const sandbox = realpathSync(mkdtempSync(join(tmpdir(), 'tatsu-core-record-')))
const env = { ...process.env }
for (const key of ['CLAUDE_CONFIG_DIR', 'CODEX_HOME', 'OPENCODE_CONFIG_DIR', 'GITHUB_TOKEN', 'HARNESS_WS_TRANSPORT', 'HARNESS_WS_PORT', 'HARNESS_WS_HOST']) {
  delete env[key]
}

const result = spawnSync(
  process.execPath,
  [
    fileURLToPath(new URL('../../node_modules/vitest/vitest.mjs', import.meta.url)),
    'run',
    '--config',
    'vitest.core.config.ts',
    'scripts/core/record-core.core.test.ts'
  ],
  {
    cwd: root,
    stdio: 'inherit',
    env: {
      ...env,
      HOME: sandbox,
      HARNESS_DATA_DIR: sandbox,
      TMPDIR: sandbox,
      CORE_SANDBOX: sandbox,
      CORE_RECORD: '1',
      CORE_UPDATE: args.includes('--update') ? '1' : ''
    }
  }
)
rmSync(sandbox, { recursive: true, force: true })
process.exit(result.status ?? 1)
