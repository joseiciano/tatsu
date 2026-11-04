#!/usr/bin/env node
// Workflow end-to-end smoke for the headless server, run by smoke-headless.sh.
//
// Usage: node scripts/workflow-smoke.mjs <token> <port> <repoPath> <curl:yes|no>
//
// Expects the server to have booted with Labs workflows on, hooks consent
// accepted, claudeCommand, codexCommand and opencodeCommand pointing at
// shims for scripts/fake-agent.mjs, a scratch CODEX_HOME that trusts Tatsu's
// hooks and the repo, and the personal definitions `smoke` (Claude step then
// shell step), `smoke-codex` (Codex step then shell step), `smoke-opencode`
// (opencode step then shell step), `smoke-diamond` (Claude plan, two
// read-only Claude branches, shell join), `smoke-retry` (one
// `test -f flag` shell step) and `smoke-full`, plus the committed repo
// definition `.harness/workflows/smoke-repo.yaml`. Adds <repoPath> as a repo,
// runs every scenario and exits non-zero on the first failed assertion or
// on a 60 s timeout per scenario.

import { WebSocket } from 'ws'
import { execFileSync } from 'child_process'
import { appendFileSync, writeFileSync } from 'fs'
import { join } from 'path'

const [token, portArg, repoPath, curlArg] = process.argv.slice(2)
if (!token || !portArg || !repoPath || !['yes', 'no'].includes(curlArg)) {
  console.error('usage: node scripts/workflow-smoke.mjs <token> <port> <repoPath> <curl:yes|no>')
  process.exit(1)
}
const curlPresent = curlArg === 'yes'
const SCENARIO_TIMEOUT_MS = 60_000
const STARTING_ERROR = 'Tatsu is still starting; try again'
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const OPENCODE_SESSION = /^ses_[0-9A-Za-z]{1,64}$/
const sessionRecorded = []

const ws = new WebSocket(`ws://127.0.0.1:${Number(portArg)}?token=${encodeURIComponent(token)}`)
let state = null
const buffered = []
const listeners = new Set()
const pending = new Map()
let nextId = 1

function applyEvent(event) {
  if (event.type === 'worktrees/listChanged') state.worktrees.list = event.payload
  else if (event.type === 'hooks/consentChanged') state.hooks.consent = event.payload
  else if (event.type === 'hooks/codexTrustChanged') state.hooks.codexTrust = event.payload
  else if (event.type === 'workflows/attemptSessionRecorded') sessionRecorded.push(event.payload.attemptId)
  else if (event.type === 'workflows/definitionsLoaded') {
    const { scope, repoRoot, definitions } = event.payload
    const inGroup = (d) => d.scope === scope && (scope !== 'repo' || d.repoRoot === repoRoot)
    const kept = Object.values(state.workflows.definitions).filter((d) => !inGroup(d))
    state.workflows.definitions = Object.fromEntries([...kept, ...definitions.filter(inGroup)].map((d) => [d.id, d]))
  } else if (event.type === 'workflows/definitionSaved') {
    state.workflows.definitions = { ...state.workflows.definitions, [event.payload.id]: event.payload }
  } else if (event.type === 'workflows/definitionDeleted') {
    const { [event.payload.defId]: _removed, ...rest } = state.workflows.definitions
    state.workflows.definitions = rest
  }
}

ws.on('message', (raw) => {
  const frame = JSON.parse(raw.toString())
  if (frame.t === 'snapres' || frame.t === 'res') {
    const waiter = pending.get(frame.id)
    if (!waiter) return
    pending.delete(frame.id)
    if (frame.ok) waiter.resolve(frame.t === 'snapres' ? frame.snapshot : frame.value)
    else waiter.reject(new Error(`${waiter.name} failed: ${JSON.stringify(frame.error)}`))
    return
  }
  if (frame.t !== 'state') return
  if (!state) {
    buffered.push(frame.event)
    return
  }
  applyEvent(frame.event)
  for (const listener of [...listeners]) listener(frame.event)
})

function send(frame, name) {
  const id = String(nextId++)
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject, name })
    ws.send(JSON.stringify({ ...frame, id }))
  })
}

const request = (name, ...args) => send({ t: 'req', name, args }, name)

function fail(message, extra) {
  console.error(`::error::workflow smoke: ${message}`)
  if (extra !== undefined) console.error(JSON.stringify(extra, null, 2))
  process.exit(1)
}

function waitFor(label, check, timeoutMs = SCENARIO_TIMEOUT_MS) {
  return new Promise((resolve, reject) => {
    let busy = false
    let dirty = false
    const done = (fn, value) => {
      clearTimeout(timer)
      listeners.delete(onEvent)
      fn(value)
    }
    const evaluate = async () => {
      if (busy) {
        dirty = true
        return
      }
      busy = true
      try {
        do {
          dirty = false
          const value = await check()
          if (value !== undefined) return done(resolve, value)
        } while (dirty)
      } catch (err) {
        return done(reject, err)
      } finally {
        busy = false
      }
    }
    const onEvent = () => void evaluate()
    const timer = setTimeout(() => done(reject, new Error(`timed out after ${timeoutMs} ms waiting for ${label}`)), timeoutMs)
    listeners.add(onEvent)
    void evaluate()
  })
}

// The runner refuses starts until its boot reconcile settles (up to 10 s);
// no state event marks that, so `starting` is retried on a short backoff.
async function startRun(defId, worktreePath) {
  const deadline = Date.now() + SCENARIO_TIMEOUT_MS
  for (;;) {
    const response = await request('workflows:startRun', { defId, worktreePath, inputs: {} })
    if (response && typeof response.runId === 'string') return response.runId
    if (response?.error !== STARTING_ERROR || Date.now() > deadline) fail(`startRun ${defId} refused`, response)
    await new Promise((resolve) => setTimeout(resolve, 200))
  }
}

function runSettled(runId) {
  return waitFor(`run ${runId} to settle`, async () => {
    const record = await request('workflows:getRun', runId)
    if (!record) return undefined
    if (['done', 'failed', 'cancelled'].includes(record.status)) return record
    if (record.status === 'paused') return record
    return undefined
  })
}

function attemptsFor(record, stepId) {
  return record.attempts.filter((attempt) => attempt.stepId === stepId)
}

function expectThat(condition, message, record) {
  if (!condition) fail(message, record)
}

const FULL_UNCONFIRMED_ERROR = 'This workflow has a full-access step; confirm full access to start it'

async function scenarioFullRefused(worktreePath) {
  const deadline = Date.now() + SCENARIO_TIMEOUT_MS
  for (;;) {
    const response = await request('workflows:startRun', { defId: 'personal:smoke-full', worktreePath, inputs: {} })
    if (response?.error === FULL_UNCONFIRMED_ERROR) break
    if (response?.error !== STARTING_ERROR || Date.now() > deadline) fail('scenario 0 full-access start was not refused', response)
    await new Promise((resolve) => setTimeout(resolve, 200))
  }
  console.log('scenario 0 OK: full-access start without allowFull refused')
}

async function scenarioAgentThenShell(worktreePath) {
  const runId = await startRun('personal:smoke', worktreePath)
  const record = await runSettled(runId)
  expectThat(record.status === 'done', `scenario 1 run ended ${record.status}/${record.pausedReason ?? ''}`, record)
  const [plan] = attemptsFor(record, 'plan')
  const [echo] = attemptsFor(record, 'echo')
  expectThat(plan?.status === 'done', 'scenario 1 plan attempt is not done', record)
  expectThat(plan.metrics.completedBy === 'tool', `plan completedBy ${plan.metrics.completedBy}`, record)
  expectThat(plan.result?.summary?.startsWith('PLAN-OK '), 'plan summary lacks PLAN-OK', record)
  const expectedContinuations = curlPresent ? 1 : 0
  expectThat(
    plan.metrics.continuations === expectedContinuations,
    `plan continuations ${plan.metrics.continuations}, expected ${expectedContinuations}`,
    record
  )
  if (!curlPresent) console.log('::warning::curl is missing; the Stop hook failed open and no continuation was asked for')
  expectThat(echo?.status === 'done', 'scenario 1 echo attempt is not done', record)
  expectThat(echo.result?.summary?.includes(plan.result.summary), 'echo summary lacks the plan summary', record)
  console.log(
    'scenario 1 OK: run=%s done; plan completedBy=%s continuations=%d summary=%j; echo summary contains it',
    runId,
    plan.metrics.completedBy,
    plan.metrics.continuations,
    plan.result.summary
  )
}

async function scenarioCodexThenShell(worktreePath) {
  const runId = await startRun('personal:smoke-codex', worktreePath)
  const record = await runSettled(runId)
  expectThat(record.status === 'done', `codex scenario run ended ${record.status}/${record.pausedReason ?? ''}`, record)
  const [plan] = attemptsFor(record, 'plan')
  const [echo] = attemptsFor(record, 'echo')
  expectThat(plan?.status === 'done', 'codex plan attempt is not done', record)
  expectThat(plan.metrics.completedBy === 'tool', `codex plan completedBy ${plan.metrics.completedBy}`, record)
  const expectedContinuations = curlPresent ? 1 : 0
  expectThat(
    plan.metrics.continuations === expectedContinuations,
    `codex plan continuations ${plan.metrics.continuations}, expected ${expectedContinuations}`,
    record
  )
  expectThat(typeof plan.sessionId === 'string' && UUID.test(plan.sessionId), 'codex plan has no discovered session id', record)
  expectThat(plan.result?.summary === `PLAN-OK ${plan.sessionId}`, 'codex plan summary does not carry its session id', record)
  const recorded = sessionRecorded.filter((attemptId) => attemptId === plan.attemptId).length
  expectThat(recorded === 1, `attemptSessionRecorded dispatched ${recorded} times for the codex plan`, record)
  expectThat(echo?.status === 'done', 'codex scenario echo attempt is not done', record)
  expectThat(echo.result?.summary?.includes(plan.result.summary), 'codex echo summary lacks the plan summary', record)
  console.log(
    'scenario codex OK: run=%s done; plan completedBy=%s continuations=%d session=%s; echo summary contains it',
    runId,
    plan.metrics.completedBy,
    plan.metrics.continuations,
    plan.sessionId
  )
}

async function scenarioOpencodeThenShell(worktreePath) {
  const runId = await startRun('personal:smoke-opencode', worktreePath)
  const record = await runSettled(runId)
  expectThat(record.status === 'done', `opencode scenario run ended ${record.status}/${record.pausedReason ?? ''}`, record)
  const [plan] = attemptsFor(record, 'plan')
  const [echo] = attemptsFor(record, 'echo')
  expectThat(plan?.status === 'done', 'opencode plan attempt is not done', record)
  expectThat(plan.metrics.completedBy === 'tool', `opencode plan completedBy ${plan.metrics.completedBy}`, record)
  expectThat(plan.metrics.continuations === 1, `opencode plan continuations ${plan.metrics.continuations}, expected 1`, record)
  expectThat(
    typeof plan.sessionId === 'string' && OPENCODE_SESSION.test(plan.sessionId),
    'opencode plan has no discovered session id',
    record
  )
  expectThat(plan.result?.summary === `PLAN-OK ${plan.sessionId}`, 'opencode plan summary does not carry its session id', record)
  const recorded = sessionRecorded.filter((attemptId) => attemptId === plan.attemptId).length
  expectThat(recorded === 1, `attemptSessionRecorded dispatched ${recorded} times for the opencode plan`, record)
  expectThat(echo?.status === 'done', 'opencode scenario echo attempt is not done', record)
  expectThat(echo.result?.summary?.includes(plan.result.summary), 'opencode echo summary lacks the plan summary', record)
  console.log(
    'scenario opencode OK: run=%s done; plan completedBy=%s continuations=%d session=%s; echo summary contains it',
    runId,
    plan.metrics.completedBy,
    plan.metrics.continuations,
    plan.sessionId
  )
}

async function scenarioDiamond(worktreePath) {
  const runId = await startRun('personal:smoke-diamond', worktreePath)
  const record = await runSettled(runId)
  expectThat(record.status === 'done', `diamond scenario run ended ${record.status}/${record.pausedReason ?? ''}`, record)
  const [plan, left, right, join] = ['plan', 'left', 'right', 'join'].map((stepId) => attemptsFor(record, stepId))
  for (const [stepId, attempts] of Object.entries({ plan, left, right, join })) {
    expectThat(attempts.length === 1 && attempts[0].status === 'done', `diamond ${stepId} has ${attempts.length} attempts, expected one done`, record)
  }
  expectThat(left[0].startedAt >= plan[0].endedAt && right[0].startedAt >= plan[0].endedAt, 'a diamond branch started before plan ended', record)
  expectThat(right[0].startedAt >= left[0].endedAt, 'the right branch started before the left branch ended', record)
  expectThat(join[0].startedAt >= right[0].endedAt, 'the join started before both branches ended', record)
  const joined = join[0].result?.summary ?? ''
  expectThat(joined.includes(left[0].result.summary) && joined.includes(right[0].result.summary), 'the join summary lacks a branch summary', record)
  console.log('scenario diamond OK: run=%s done; plan -> left -> right -> join; join summary %j', runId, joined)
}

async function scenarioFailRetry(worktreePath) {
  const deadline = Date.now() + SCENARIO_TIMEOUT_MS
  const runId = await startRun('personal:smoke-retry', worktreePath)
  const paused = await runSettled(runId)
  expectThat(
    paused.status === 'paused' && paused.pausedReason === 'step-failed',
    `scenario 2 expected paused/step-failed, got ${paused.status}/${paused.pausedReason ?? ''}`,
    paused
  )
  writeFileSync(join(worktreePath, 'flag'), '')
  const retried = await request('workflows:retryStep', runId, 'check')
  expectThat(retried?.ok === true, 'retryStep refused', retried)
  const record = await waitFor(
    `run ${runId} to finish after retry`,
    async () => {
      const r = await request('workflows:getRun', runId)
      return r && ['done', 'failed', 'cancelled'].includes(r.status) ? r : undefined
    },
    Math.max(0, deadline - Date.now())
  )
  const attempts = attemptsFor(record, 'check')
  const last = attempts[attempts.length - 1]
  expectThat(record.status === 'done', `scenario 2 run ended ${record.status}`, record)
  expectThat(attempts.length === 2 && last.n === 2 && last.status === 'done', 'scenario 2 expected a done attempt n=2', record)
  console.log('scenario 2 OK: run=%s paused step-failed, retried, done with attempt n=%d', runId, last.n)
}

const UNTRUSTED_ERROR = 'Trust this definition before running it'
const STALE_TRUST_ERROR = 'The workflow definition changed on disk; review it again before trusting it'

function repoDefinition(name) {
  return Object.values(state.workflows.definitions).find((d) => d.scope === 'repo' && d.name === name)
}

async function scenarioRepoTrust(worktreePath) {
  const defId = repoDefinition('smoke-repo').id
  const refused = await request('workflows:startRun', { defId, worktreePath, inputs: {} })
  expectThat(refused?.error === UNTRUSTED_ERROR, 'untrusted repo definition was not refused', refused)

  const detail = await request('workflows:getDefinition', defId)
  expectThat(/^[0-9a-f]{64}$/.test(detail?.summary?.hash ?? ''), 'repo definition detail has no hash', detail)
  const wrong = detail.summary.hash.replace(/^./, (c) => (c === '0' ? '1' : '0'))
  const stale = await request('workflows:trustDefinition', defId, wrong)
  expectThat(stale?.error === STALE_TRUST_ERROR, 'trustDefinition with a stale hash was not refused', stale)
  const stillRefused = await request('workflows:startRun', { defId, worktreePath, inputs: {} })
  expectThat(stillRefused?.error === UNTRUSTED_ERROR, 'a refused trust still let the run start', stillRefused)

  const trusted = await request('workflows:trustDefinition', defId, detail.summary.hash)
  expectThat(trusted?.ok === true, 'trustDefinition with the current hash was refused', trusted)
  const runId = await startRun(defId, worktreePath)
  const record = await runSettled(runId)
  expectThat(record.status === 'done', `repo trust run ended ${record.status}/${record.pausedReason ?? ''}`, record)
  expectThat(record.defHash === detail.summary.hash, 'run defHash is not the trusted hash', record)
  const [check] = attemptsFor(record, 'check')
  expectThat(check?.result?.summary?.includes('REPO-TRUSTED'), 'repo shell step summary lacks REPO-TRUSTED', record)

  const file = '.harness/workflows/smoke-repo.yaml'
  appendFileSync(join(worktreePath, file), '# edited after trust\n')
  try {
    const edited = await request('workflows:startRun', { defId, worktreePath, inputs: {} })
    expectThat(edited?.error === UNTRUSTED_ERROR, 'a repo definition edited after trust was not refused', edited)
  } finally {
    execFileSync('git', ['checkout', '--', file], { cwd: worktreePath })
  }
  console.log(
    'scenario repo-trust OK: untrusted refused, stale hash refused, trusted run=%s done, edit after trust refused',
    runId
  )
}

async function main() {
  await new Promise((resolve, reject) => {
    ws.once('open', resolve)
    ws.once('error', reject)
  })
  const snapshot = await send({ t: 'snapreq' }, 'snapshot')
  state = snapshot.state
  state.worktrees.list ??= []
  state.workflows.definitions ??= {}
  for (const event of buffered.splice(0)) applyEvent(event)

  const added = await request('repo:addAtPath', repoPath)
  if (added?.kind !== 'added') fail('repo:addAtPath did not add the repo', added)
  await request('workflows:reloadDefinitions')

  const definitionIds = [
    'personal:smoke',
    'personal:smoke-codex',
    'personal:smoke-opencode',
    'personal:smoke-diamond',
    'personal:smoke-retry',
    'personal:smoke-full'
  ]
  const worktreePath = await waitFor('the repo, hooks consent, Codex hook trust and definitions', () => {
    const wt = state.worktrees.list.find((w) => w.path === added.repoRoot || w.path === repoPath)
    const ready =
      wt &&
      state.hooks.consent === 'accepted' &&
      state.hooks.codexTrust?.state === 'ok' &&
      definitionIds.every((id) => state.workflows.definitions[id]) &&
      repoDefinition('smoke-repo')
    return ready ? wt.path : undefined
  })
  for (const id of definitionIds) {
    const issues = state.workflows.definitions[id].issues
    if (issues.length > 0) fail(`definition ${id} has issues`, issues)
  }

  await scenarioFullRefused(worktreePath)
  await scenarioAgentThenShell(worktreePath)
  await scenarioCodexThenShell(worktreePath)
  await scenarioOpencodeThenShell(worktreePath)
  await scenarioDiamond(worktreePath)
  await scenarioFailRetry(worktreePath)
  await scenarioRepoTrust(worktreePath)
  ws.close()
  process.exit(0)
}

ws.on('error', (err) => fail(`ws error: ${err.message}`))
main().catch((err) => fail(err instanceof Error ? err.message : String(err)))
