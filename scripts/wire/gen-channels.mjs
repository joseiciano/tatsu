import { spawnSync } from 'node:child_process'
import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('../../', import.meta.url))
const args = process.argv.slice(2).filter((arg) => arg !== '--')
if (args.length > 0) {
  console.error(`gen:channels: unknown argument(s): ${args.join(' ')}`)
  process.exit(2)
}

const sandbox = realpathSync(mkdtempSync(join(tmpdir(), 'tatsu-channels-')))
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
    'vitest.wire.config.ts',
    'scripts/wire/channels.wire.test.ts'
  ],
  {
    cwd: root,
    stdio: 'inherit',
    env: {
      ...env,
      HOME: sandbox,
      HARNESS_DATA_DIR: sandbox,
      TMPDIR: sandbox,
      WIRE_CHANNELS: '1',
      WIRE_CHANNELS_SANDBOX: sandbox
    }
  }
)
rmSync(sandbox, { recursive: true, force: true })
process.exit(result.status ?? 1)
