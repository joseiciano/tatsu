#!/usr/bin/env node
// Browser leg of the headless smoke, run by smoke-headless.sh after
// workflow-smoke.mjs: loads the web client in headless Chrome and drives the
// Phase 2 workflow UI against the fake-agent server.
//
// Usage: node scripts/browser-smoke.mjs <token> <port> <worktreePath> <evidenceDir> <curl:yes|no>
//
// Browser: HARNESS_PLAYWRIGHT_BROWSER when set (used exclusively; a missing
// or non-executable path counts as unresolved), else playwright's
// channel:'chrome'. Exits 77 only when no browser launches, so the caller
// can skip locally and fail under CI; every later failure exits 1 and saves
// a screenshot plus an ARIA snapshot to <evidenceDir>.

import { accessSync, appendFileSync, constants, mkdirSync, writeFileSync } from 'fs'
import { join } from 'path'
import { chromium } from 'playwright-core'
import { WebSocket } from 'ws'

const NO_BROWSER_EXIT = 77
const SCENARIO_TIMEOUT_MS = 60_000

const [token, portArg, worktreePath, evidenceDir, curlArg] = process.argv.slice(2)
if (!token || !portArg || !worktreePath || !evidenceDir || !['yes', 'no'].includes(curlArg)) {
  console.error('usage: node scripts/browser-smoke.mjs <token> <port> <worktreePath> <evidenceDir> <curl:yes|no>')
  process.exit(1)
}
const port = Number(portArg)
const appUrl = `http://127.0.0.1:${port}/?token=${encodeURIComponent(token)}`
mkdirSync(evidenceDir, { recursive: true })

function log(message) {
  const line = `[browser-smoke] ${message}`
  console.log(line)
  appendFileSync(join(evidenceDir, 'journal.log'), `${new Date().toISOString()} ${line}\n`)
}

function launchOptions() {
  const explicit = process.env.HARNESS_PLAYWRIGHT_BROWSER?.trim()
  if (!explicit) return { headless: true, channel: 'chrome' }
  try {
    accessSync(explicit, constants.X_OK)
  } catch {
    return null
  }
  return { headless: true, executablePath: explicit }
}

async function launchBrowser() {
  const options = launchOptions()
  if (!options) {
    console.error(`browser-smoke: HARNESS_PLAYWRIGHT_BROWSER=${process.env.HARNESS_PLAYWRIGHT_BROWSER} is not an executable`)
    process.exit(NO_BROWSER_EXIT)
  }
  try {
    const browser = await chromium.launch(options)
    log(`browser: ${options.executablePath ?? `channel:${options.channel}`} ${browser.version()}`)
    return browser
  } catch (err) {
    console.error(`browser-smoke: no browser launched: ${err instanceof Error ? err.message.split('\n')[0] : err}`)
    process.exit(NO_BROWSER_EXIT)
  }
}

function connect() {
  const ws = new WebSocket(`ws://127.0.0.1:${port}?token=${encodeURIComponent(token)}`)
  const pending = new Map()
  let nextId = 1
  ws.on('message', (raw) => {
    const frame = JSON.parse(raw.toString())
    if (frame.t !== 'res' && frame.t !== 'snapres') return
    const waiter = pending.get(frame.id)
    if (!waiter) return
    pending.delete(frame.id)
    if (frame.ok) waiter.resolve(frame.t === 'snapres' ? frame.snapshot : frame.value)
    else waiter.reject(new Error(`${waiter.name} failed: ${JSON.stringify(frame.error)}`))
  })
  const opened = new Promise((resolve, reject) => {
    ws.once('open', resolve)
    ws.once('error', reject)
  })
  const send = (frame, name) => {
    const id = String(nextId++)
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject, name })
      ws.send(JSON.stringify({ ...frame, id }))
    })
  }
  return {
    opened,
    request: (name, ...args) => send({ t: 'req', name, args }, name),
    snapshot: () => send({ t: 'snapreq' }, 'snapshot'),
    close: () => ws.close()
  }
}

async function scenario(page, name, body) {
  let step = 0
  const shot = async (label) => {
    step += 1
    const file = join(evidenceDir, `${name}-${String(step).padStart(2, '0')}-${label}.png`)
    await page.screenshot({ path: file })
    log(`${name}: screenshot ${file}`)
  }
  try {
    await body(shot)
    log(`${name} OK`)
  } catch (err) {
    const file = join(evidenceDir, `${name}-FAIL.png`)
    await page.screenshot({ path: file }).catch(() => {})
    const tree = await page.locator('body').ariaSnapshot().catch((e) => `ariaSnapshot failed: ${e}`)
    writeFileSync(join(evidenceDir, `${name}-FAIL-aria.txt`), tree)
    console.error(`::error::browser smoke ${name}: ${err instanceof Error ? err.message : String(err)}`)
    console.error(`browser smoke failure screenshot: ${file}`)
    throw err
  }
}

function worktreeRow(page) {
  return page.getByText(worktreePath.split('/').slice(-2).join('/'), { exact: true })
}

function stepStrip(page, label) {
  return page.getByRole('img', { name: `Workflow steps: ${label}`, exact: true })
}

function needsYouRow(page, workflowName) {
  return page
    .getByRole('region', { name: /^NEEDS YOU/ })
    .getByRole('listitem')
    .filter({ hasText: workflowName })
}

async function startFromLaunchSheet(page, defName, shot) {
  const row = worktreeRow(page)
  await row.scrollIntoViewIfNeeded()
  await row.click({ button: 'right' })
  await page.getByRole('menu').waitFor()
  await shot('context-menu')
  await page.getByRole('menuitem', { name: 'Run workflow here…' }).click()
  const sheet = page.getByRole('dialog', { name: 'Run workflow' })
  await sheet.getByLabel('Workflow').selectOption({ label: defName })
  await shot('launch-sheet')
  await sheet.getByRole('button', { name: 'Start' }).click()
  await sheet.waitFor({ state: 'hidden' })
}

async function liveRunId(backend, defName) {
  const { state } = await backend.snapshot()
  const live = Object.entries(state.workflows.runs).filter(
    ([, run]) => run.defId === `personal:${defName}` && ['queued', 'running', 'paused'].includes(run.status)
  )
  if (live.length !== 1) throw new Error(`expected one live ${defName} run, found ${live.length}`)
  return live[0][0]
}

async function waitForRunStatus(backend, runId, status) {
  const deadline = Date.now() + SCENARIO_TIMEOUT_MS
  for (;;) {
    const record = await backend.request('workflows:getRun', runId)
    if (record?.status === status) return record
    if (Date.now() > deadline) throw new Error(`run ${runId} is ${record?.status}, expected ${status}`)
    await new Promise((resolve) => setTimeout(resolve, 200))
  }
}

async function flowHangCancel(page, backend) {
  await scenario(page, 'hang-cancel', async (shot) => {
    await startFromLaunchSheet(page, 'browser-hang', shot)
    await stepStrip(page, 'hang running').waitFor()
    await shot('strip-running')

    await page.getByRole('button', { name: 'Close tab ⚙ hang · Claude', exact: true }).click()
    const confirm = page.getByRole('alertdialog', { name: 'Cancel step “hang”?' })
    await confirm.waitFor()
    await shot('cancel-confirm')
    await confirm.getByRole('button', { name: 'Cancel step and close tab' }).click()
    await confirm.waitFor({ state: 'hidden' })

    const row = needsYouRow(page, 'browser-hang')
    await row.filter({ hasText: 'Cancelled by user · hang' }).waitFor()
    await stepStrip(page, 'hang paused').waitFor()
    await shot('needs-you-cancelled')

    const runId = await liveRunId(backend, 'browser-hang')
    const record = await backend.request('workflows:getRun', runId)
    const attempt = record.attempts.find((a) => a.stepId === 'hang')
    if (record.pausedReason !== 'step-failed' || attempt?.status !== 'cancelled') {
      throw new Error(`expected paused step-failed with a cancelled attempt, got ${record.pausedReason}/${attempt?.status}`)
    }
    const cancelled = await backend.request('workflows:cancelRun', runId)
    if (cancelled?.ok !== true) throw new Error(`cancelRun refused: ${JSON.stringify(cancelled)}`)
    await waitForRunStatus(backend, runId, 'cancelled')
    await row.waitFor({ state: 'detached' })
    await page.getByRole('img', { name: /^Workflow steps:/ }).waitFor({ state: 'detached' })
    await shot('run-cancelled')
  })
}

async function main() {
  const backend = connect()
  await backend.opened
  const browser = await launchBrowser()
  let failed = false
  try {
    const page = await browser.newPage({ viewport: { width: 1400, height: 900 } })
    page.setDefaultTimeout(SCENARIO_TIMEOUT_MS)
    page.on('pageerror', (err) => log(`page error: ${err.message}`))
    page.on('console', (msg) => {
      if (msg.type() === 'error') log(`console error: ${msg.text()}`)
    })
    await page.goto(appUrl)

    await scenario(page, 'load', async (shot) => {
      await worktreeRow(page).waitFor()
      await shot('worktree-row')
    })
    await flowHangCancel(page, backend)
  } catch {
    failed = true
  } finally {
    await browser.close()
    backend.close()
  }
  process.exit(failed ? 1 : 0)
}

main().catch((err) => {
  console.error(`::error::browser smoke: ${err instanceof Error ? err.message : String(err)}`)
  process.exit(1)
})
