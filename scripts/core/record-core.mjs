import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('../../', import.meta.url))
const args = process.argv.slice(2)
if (args[0] === '--') args.shift()
const unknown = args.filter((arg) => arg !== '--update')
if (unknown.length > 0) {
  console.error(`fixtures:record-core: unknown argument(s): ${unknown.join(' ')} (only --update is accepted)`)
  process.exit(2)
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
    env: { ...process.env, CORE_RECORD: '1', CORE_UPDATE: args.includes('--update') ? '1' : '' }
  }
)
process.exit(result.status ?? 1)
