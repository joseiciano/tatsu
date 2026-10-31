#!/usr/bin/env node
// Drives one isolated headless Tatsu instance over its WebSocket transport.
//
//   control.mjs start [--data <dir>]      launch; prints the run dir
//   control.mjs doctor                    is this instance worth driving?
//   control.mjs req <name> [jsonArg...]   RPC (transport.onRequest handlers)
//   control.mjs signal <name> [jsonArg...]fire-and-forget (transport.onSignal)
//   control.mjs get <dot.path>            print part of the state snapshot
//     req, get and wait take --save <name> to also write the result to artifacts/<name>.json
//   control.mjs wait <dot.path> <jsExpr> [--timeout ms]
//                                         poll until jsExpr (over `v`) is true
//   control.mjs save <dot.path> <name>    write state subset to artifacts/<name>.json
//   control.mjs log [n]                   tail the server log
//   control.mjs stop [--keep-data]        SIGTERM our pid, delete data dir, keep artifacts
//
// TATSU_VERIFY_RUN names the run dir (default: the newest under
// $TMPDIR/tatsu-acp-verify). Each run owns its data dir and ephemeral port, so
// runs never touch ~/.harness or each other.

import { spawn } from 'node:child_process'
import {
  existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { WebSocket } from 'ws'

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..')
const runsRoot = join(tmpdir(), 'tatsu-acp-verify')
const [cmd, ...rest] = process.argv.slice(2)

function flag(name, fallback) {
  const i = rest.indexOf(name)
  if (i === -1) return fallback
  const v = rest[i + 1]
  rest.splice(i, v === undefined || v.startsWith('--') ? 1 : 2)
  return v === undefined || v.startsWith('--') ? true : v
}

function runDir() {
  if (process.env.TATSU_VERIFY_RUN) return process.env.TATSU_VERIFY_RUN
  if (!existsSync(runsRoot)) die('no run yet; control.mjs start')
  const runs = readdirSync(runsRoot)
    .map((d) => join(runsRoot, d))
    .filter((d) => existsSync(join(d, 'instance.json')))
    .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)
  if (!runs.length) die('no run yet; control.mjs start')
  return runs[0]
}

function instance() {
  const dir = runDir()
  return { dir, ...JSON.parse(readFileSync(join(dir, 'instance.json'), 'utf8')) }
}

function die(msg) {
  console.error(`[control] ${msg}`)
  process.exit(1)
}

function alive(pid) {
  try { process.kill(pid, 0); return true } catch { return false }
}

function parseArgs(args) {
  return args.map((a) => {
    try { return JSON.parse(a) } catch { return a }
  })
}

function dig(obj, path) {
  if (!path || path === '.') return obj
  return path.split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj)
}

function connect(inst) {
  return new Promise((ok, fail) => {
    const ws = new WebSocket(`ws://127.0.0.1:${inst.port}?token=${encodeURIComponent(inst.token)}`)
    let id = 0
    const pending = new Map()
    ws.on('message', (raw) => {
      const f = JSON.parse(raw.toString())
      if ((f.t === 'res' || f.t === 'snapres') && pending.has(f.id)) {
        const { resolve: r, reject } = pending.get(f.id)
        pending.delete(f.id)
        f.ok ? r(f.t === 'res' ? f.value : f.snapshot) : reject(new Error(f.error ?? 'request failed'))
      }
    })
    ws.on('error', fail)
    ws.on('open', () => ok({
      req: (name, args) => new Promise((r, j) => {
        const i = String(++id)
        pending.set(i, { resolve: r, reject: j })
        ws.send(JSON.stringify({ t: 'req', id: i, name, args }))
      }),
      signal: (name, args) => ws.send(JSON.stringify({ t: 'send', name, args })),
      snapshot: () => new Promise((r, j) => {
        const i = String(++id)
        pending.set(i, { resolve: r, reject: j })
        ws.send(JSON.stringify({ t: 'snapreq', id: i }))
      }),
      close: () => ws.close()
    }))
  })
}

async function start() {
  const bundle = join(repo, 'dist-headless', 'main', 'index.js')
  if (!existsSync(bundle)) die(`${bundle} missing; run pnpm build:headless`)
  const id = new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14)
  const dir = process.env.TATSU_VERIFY_RUN ?? join(runsRoot, id)
  const data = flag('--data', join(dir, 'data'))
  mkdirSync(join(dir, 'artifacts'), { recursive: true })
  mkdirSync(data, { recursive: true })
  const logPath = join(dir, 'server.log')
  const out = (await import('node:fs')).openSync(logPath, 'a')
  const child = spawn(process.execPath, [bundle, '--port', '0', '--host', '127.0.0.1'], {
    cwd: repo,
    env: { ...process.env, HARNESS_DATA_DIR: data },
    stdio: ['ignore', out, out],
    detached: true
  })
  child.unref()
  let url = ''
  for (let i = 0; i < 100 && !url; i++) {
    await new Promise((r) => setTimeout(r, 200))
    const m = readFileSync(logPath, 'utf8').match(/http:\/\/127\.0\.0\.1:(\d+)\/\?token=([a-f0-9]+)/)
    if (m) url = m[0]
    if (!alive(child.pid)) break
  }
  if (!url) {
    console.error(readFileSync(logPath, 'utf8'))
    die('server did not advertise a URL within 20s')
  }
  const m = url.match(/:(\d+)\/\?token=([a-f0-9]+)/)
  writeFileSync(join(dir, 'instance.json'), JSON.stringify({
    pid: child.pid, port: Number(m[1]), token: m[2], url, data, log: logPath,
    bundleMtime: statSync(bundle).mtimeMs, startedAt: new Date().toISOString()
  }, null, 2))
  console.log(dir)
}

async function doctor() {
  const inst = instance()
  const problems = []
  if (!alive(inst.pid)) problems.push(`pid ${inst.pid} is not running`)
  const bundle = join(repo, 'dist-headless', 'main', 'index.js')
  if (existsSync(bundle) && statSync(bundle).mtimeMs !== inst.bundleMtime) {
    problems.push('dist-headless was rebuilt after this instance started')
  }
  let snap = null
  if (!problems.length) {
    try {
      const c = await connect(inst)
      snap = await c.snapshot()
      c.close()
    } catch (e) {
      problems.push(`WS ${e.message}`)
    }
  }
  const report = {
    run: inst.dir,
    pid: inst.pid,
    url: inst.url,
    dataDir: inst.data,
    version: JSON.parse(readFileSync(join(repo, 'package.json'), 'utf8')).version,
    seq: snap?.seq ?? null,
    experimentalChatAgentsEnabled: snap?.state.settings.experimentalChatAgentsEnabled ?? null,
    repoRoots: snap?.state.worktrees.repoRoots ?? null,
    runtimes: snap?.state.runtimes?.byAgent ?? null,
    chatSessions: snap ? Object.keys(snap.state.jsonClaude.sessions) : null,
    problems
  }
  console.log(JSON.stringify(report, null, 2))
  if (problems.length) process.exit(1)
}

function saveArtifact(inst, name, source, value) {
  const file = join(inst.dir, 'artifacts', `${name}.json`)
  writeFileSync(file, JSON.stringify({ capturedAt: new Date().toISOString(), ...source, value }, null, 2))
  console.error(`[control] saved ${file}`)
  return file
}

async function withConn(fn) {
  const inst = instance()
  const c = await connect(inst)
  try { return await fn(c, inst) } finally { c.close() }
}

async function main() {
  switch (cmd) {
    case 'start': return start()
    case 'doctor': return doctor()
    case 'req': {
      const saveAs = flag('--save', null)
      const [name, ...args] = rest
      if (!name) die('req <name> [jsonArg...]')
      const v = await withConn((c, inst) => c.req(name, parseArgs(args)).then((v) => {
        if (saveAs) saveArtifact(inst, saveAs, { request: name, args: parseArgs(args) }, v)
        return v
      }))
      console.log(JSON.stringify(v ?? null, null, 2))
      return
    }
    case 'signal': {
      const [name, ...args] = rest
      if (!name) die('signal <name> [jsonArg...]')
      await withConn(async (c) => { c.signal(name, parseArgs(args)); await new Promise((r) => setTimeout(r, 100)) })
      console.log('sent')
      return
    }
    case 'get': {
      const saveAs = flag('--save', null)
      const v = await withConn(async (c, inst) => {
        const v = dig((await c.snapshot()).state, rest[0])
        if (saveAs) saveArtifact(inst, saveAs, { path: rest[0] }, v)
        return v
      })
      console.log(JSON.stringify(v ?? null, null, 2))
      return
    }
    case 'wait': {
      const timeout = Number(flag('--timeout', 30000))
      const saveAs = flag('--save', null)
      const [path, expr] = rest
      if (!path || !expr) die('wait <dot.path> <jsExpr> [--timeout ms]')
      const test = new Function('v', `return (${expr})`)
      const deadline = Date.now() + timeout
      let last
      await withConn(async (c, inst) => {
        while (Date.now() < deadline) {
          last = dig((await c.snapshot()).state, path)
          if (test(last)) {
            if (saveAs) saveArtifact(inst, saveAs, { path, until: expr }, last)
            console.log(JSON.stringify(last, null, 2))
            return
          }
          await new Promise((r) => setTimeout(r, 500))
        }
        console.error(JSON.stringify(last, null, 2))
        die(`timed out after ${timeout}ms waiting for ${expr} at ${path}`)
      })
      return
    }
    case 'save': {
      const [path, name] = rest
      if (!path || !name) die('save <dot.path> <name>')
      const file = await withConn(async (c, inst) =>
        saveArtifact(inst, name, { path }, dig((await c.snapshot()).state, path))
      )
      console.log(file)
      return
    }
    case 'log': {
      const inst = instance()
      const lines = readFileSync(inst.log, 'utf8').trimEnd().split('\n')
      console.log(lines.slice(-Number(rest[0] ?? 40)).join('\n'))
      return
    }
    case 'stop': {
      const keep = flag('--keep-data', false)
      const inst = instance()
      if (alive(inst.pid)) {
        process.kill(inst.pid, 'SIGTERM')
        for (let i = 0; i < 25 && alive(inst.pid); i++) await new Promise((r) => setTimeout(r, 200))
        if (alive(inst.pid)) { process.kill(inst.pid, 'SIGKILL'); console.error('[control] needed SIGKILL') }
      }
      if (!keep) rmSync(inst.data, { recursive: true, force: true })
      writeFileSync(join(inst.dir, 'instance.json'), JSON.stringify({ ...inst, stoppedAt: new Date().toISOString(), dataRemoved: !keep }, null, 2))
      console.log(`stopped; artifacts kept in ${join(inst.dir, 'artifacts')}`)
      return
    }
    default:
      die('commands: start doctor req signal get wait save log stop')
  }
}

main().catch((e) => die(e.stack ?? e))
