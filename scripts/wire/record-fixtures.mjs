import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('../../', import.meta.url))
const args = process.argv.slice(2)
if (args[0] === '--') args.shift()
const unknown = args.filter((arg) => arg !== '--update')
if (unknown.length > 0) {
  console.error(`fixtures:record: unknown argument(s): ${unknown.join(' ')} (only --update is accepted)`)
  process.exit(2)
}

const result = spawnSync(
  process.execPath,
  [
    fileURLToPath(new URL('../../node_modules/vitest/vitest.mjs', import.meta.url)),
    'run',
    '--config',
    'vitest.wire.config.ts',
    'scripts/wire/record-fixtures.wire.test.ts'
  ],
  {
    cwd: root,
    stdio: 'inherit',
    env: { ...process.env, WIRE_RECORD: '1', WIRE_UPDATE: args.includes('--update') ? '1' : '' }
  }
)
process.exit(result.status ?? 1)
