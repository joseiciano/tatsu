import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('../../', import.meta.url))
const args = process.argv.slice(2)
if (args[0] === '--') args.shift()

function usage(message) {
  console.error(`test:core-diff: ${message} (usage: pnpm test:core-diff -- [--script fixtures/core/scripts/<name>.json])`)
  process.exit(2)
}

let script
for (let i = 0; i < args.length; i += 2) {
  if (args[i] !== '--script') usage(`unknown argument ${args[i]}`)
  if (args[i + 1] === undefined) usage('--script needs a path')
  script = resolve(process.cwd(), args[i + 1])
  if (!existsSync(script)) usage(`no such script ${args[i + 1]}`)
}

const result = spawnSync(
  process.execPath,
  [
    fileURLToPath(new URL('../../node_modules/vitest/vitest.mjs', import.meta.url)),
    'run',
    '--config',
    'vitest.core.config.ts',
    'scripts/core/diff.core.test.ts',
    '--reporter=default'
  ],
  {
    cwd: root,
    stdio: 'inherit',
    env: { ...process.env, CORE_DIFF_SCRIPT: script ?? '' }
  }
)
process.exit(result.status ?? 1)
