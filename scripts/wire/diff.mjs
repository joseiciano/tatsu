import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('../../', import.meta.url))
const args = process.argv.slice(2)
if (args[0] === '--') args.shift()

function usage(message) {
  console.error(`test:wire-diff: ${message} (usage: pnpm test:wire-diff -- [--seed <n>] [--runs <n>])`)
  process.exit(2)
}

const options = {}
for (let i = 0; i < args.length; i += 2) {
  const flag = args[i]
  const value = args[i + 1]
  if (flag !== '--seed' && flag !== '--runs') usage(`unknown argument ${flag}`)
  if (value === undefined || !/^\d+$/.test(value) || !Number.isSafeInteger(Number(value))) {
    usage(`${flag} needs a non-negative integer`)
  }
  options[flag.slice(2)] = value
}
if (options.seed !== undefined && Number(options.seed) > 0xffffffff) usage('--seed must fit in 32 bits')

const seed = options.seed ?? String(Math.floor(Math.random() * 0x100000000))
const runs = options.runs ?? '100'
console.log(`test:wire-diff: seed ${seed}, runs ${runs}`)

const result = spawnSync(
  process.execPath,
  [
    fileURLToPath(new URL('../../node_modules/vitest/vitest.mjs', import.meta.url)),
    'run',
    '--config',
    'vitest.wire.config.ts',
    'scripts/wire/diff.wire.test.ts',
    '--reporter=default'
  ],
  {
    cwd: root,
    stdio: 'inherit',
    env: { ...process.env, WIRE_DIFF_SEED: seed, WIRE_DIFF_RUNS: runs }
  }
)
process.exit(result.status ?? 1)
