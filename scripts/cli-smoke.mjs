#!/usr/bin/env node
// Smoke test for the tatsu CLI against a running headless server.
//
// Usage: HARNESS_DATA_DIR=<server data dir> node scripts/cli-smoke.mjs <port>
//
// Runs `tatsu status --json` with no explicit endpoint, so the CLI must
// discover the server through $HARNESS_DATA_DIR/cli-endpoint.json. Asserts
// exit 0, that the reported url ends with :<port>, and that the endpoint
// came from that file. Never prints the token.

import { spawnSync } from 'node:child_process'
import { join } from 'node:path'

const port = process.argv[2]
const dataDir = process.env.HARNESS_DATA_DIR
if (!port || !dataDir) {
  console.error('usage: HARNESS_DATA_DIR=<dir> node scripts/cli-smoke.mjs <port>')
  process.exit(1)
}

const env = { ...process.env }
for (const key of ['TATSU_URL', 'TATSU_TOKEN', 'TATSU_ENDPOINT_FILE']) delete env[key]

const res = spawnSync(process.execPath, ['dist-headless/cli/index.js', 'status', '--json'], {
  env,
  encoding: 'utf8',
  timeout: 15000
})

function fail(msg) {
  console.error(`cli-smoke: ${msg}`)
  if (res.stderr) console.error(res.stderr)
  process.exit(1)
}

if (res.error) fail(`could not run the CLI: ${res.error.message}`)
if (res.status !== 0) fail(`expected exit 0, got ${res.status}`)

let status
try {
  status = JSON.parse(res.stdout)
} catch {
  fail('stdout was not valid JSON')
}

if (typeof status.url !== 'string' || !status.url.endsWith(`:${port}`)) {
  fail(`expected url ending in :${port}, got ${status.url}`)
}
const expectedSource = join(dataDir, 'cli-endpoint.json')
if (status.source !== expectedSource) {
  fail(`expected source ${expectedSource}, got ${status.source}`)
}
console.log(`tatsu status OK (${status.url} via endpoint file)`)
