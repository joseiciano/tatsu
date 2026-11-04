#!/usr/bin/env node
// Browser leg of the headless smoke, run by smoke-headless.sh after
// workflow-smoke.mjs: loads the web client in headless Chrome and drives the
// Phase 2 workflow UI and the repo definition trust panel against the
// fake-agent server.
//
// Usage: node scripts/browser-smoke.mjs <token> <port> <worktreePath> <evidenceDir> <curl:yes|no>
//
// Browser: HARNESS_PLAYWRIGHT_BROWSER when set (used exclusively; a missing
// or non-executable path counts as unresolved), else playwright's
// channel:'chrome'. Exits 77 only when no browser launches, so the caller
// can skip locally and fail under CI; every later failure exits 1 and saves
// a screenshot plus an ARIA snapshot to <evidenceDir>.

import { execFileSync } from 'child_process'
import { accessSync, appendFileSync, constants, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { chromium } from 'playwright-core'
import { WebSocket } from 'ws'

const NO_BROWSER_EXIT = 77
const SCENARIO_TIMEOUT_MS = 60_000
const MARK_DONE_SUMMARY = 'Marked done from the browser smoke'

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

async function focusInside(sheet) {
  return sheet.evaluate((el) => document.activeElement !== document.body && el.contains(document.activeElement))
}

async function assertFocusTrapped(page, sheet, name) {
  const count = await sheet.evaluate(
    (el) => el.querySelectorAll('a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled])').length
  )
  for (const key of ['Tab', 'Shift+Tab']) {
    for (let i = 0; i < count + 3; i += 1) {
      await page.keyboard.press(key)
      if (!(await focusInside(sheet))) throw new Error(`${key} press ${i + 1} of ${count + 3} moved focus out of the launch sheet`)
    }
  }
  log(`${name}: focus stayed inside the sheet across ${count + 3} Tab and Shift+Tab presses (${count} focusables)`)
}

async function flowLaunchSheetFocus(page) {
  await scenario(page, 'launch-sheet-focus', async (shot) => {
    const row = worktreeRow(page)
    await row.scrollIntoViewIfNeeded()
    await row.click({ button: 'right' })
    await page.getByRole('menuitem', { name: 'Run workflow here…' }).click()
    const sheet = page.getByRole('dialog', { name: 'Run workflow' })
    await sheet.waitFor()
    if (!(await focusInside(sheet))) throw new Error('launch sheet opened without focus inside it')
    await assertFocusTrapped(page, sheet, 'launch-sheet-focus')
    await shot('focus-inside')
    await page.keyboard.press('Escape')
    await sheet.waitFor({ state: 'detached' })
  })
}

async function liveRunId(backend, defName) {
  const { state } = await backend.snapshot()
  const live = Object.entries(state.workflows.runs).filter(
    ([, run]) => run.defId === `personal:${defName}` && ['queued', 'running', 'paused'].includes(run.status)
  )
  if (live.length !== 1) throw new Error(`expected one live ${defName} run, found ${live.length}`)
  return live[0][0]
}

async function waitForRunStatus(backend, runId, status, timeoutMs = SCENARIO_TIMEOUT_MS) {
  const deadline = Date.now() + timeoutMs
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

    await cancelHangStepFromTab(page, shot)

    const row = needsYouRow(page, 'browser-hang')
    await row.filter({ hasText: 'Cancelled by user · hang' }).waitFor()
    await stepStrip(page, 'hang paused').waitFor()
    const cancelRunButton = row.getByRole('button', { name: 'Cancel run: browser-hang on repo', exact: true })
    await cancelRunButton.waitFor()
    if (!(await cancelRunButton.isEnabled())) throw new Error('Needs-you Cancel run is disabled')
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

async function cancelHangStepFromTab(page, shot) {
  await page.getByRole('button', { name: 'Close tab ⚙ hang · Claude', exact: true }).click()
  const confirm = page.getByRole('alertdialog', { name: 'Cancel step “hang”?' })
  await confirm.waitFor()
  await shot('cancel-confirm')
  await confirm.getByRole('button', { name: 'Cancel step and close tab' }).click()
  await confirm.waitFor({ state: 'hidden' })
}

async function flowWorkflowsSection(page, backend) {
  await scenario(page, 'workflows-section', async (shot) => {
    await startFromLaunchSheet(page, 'browser-hang', shot)
    await stepStrip(page, 'hang running').waitFor()
    await cancelHangStepFromTab(page, shot)
    await needsYouRow(page, 'browser-hang').filter({ hasText: 'Cancelled by user · hang' }).waitFor()
    const runId = await liveRunId(backend, 'browser-hang')
    if ((await page.locator('.xterm:visible').count()) === 0) throw new Error('no workspace terminal visible before opening the Workflows section')

    await page.keyboard.press('Meta+k')
    const search = page.getByPlaceholder('Search worktrees and commands...')
    await search.fill('workflows')
    await shot('palette')
    await page.getByRole('button', { name: /^Toggle workflows/ }).click()

    const section = page.getByRole('region', { name: 'Workflows', exact: true })
    await section.waitFor()
    if ((await page.locator('.xterm:visible').count()) !== 0) throw new Error('workspace terminals stay visible behind the Workflows section')

    const needsYou = section.getByRole('region', { name: /^NEEDS YOU/ }).getByRole('listitem').filter({ hasText: 'browser-hang' })
    await needsYou.filter({ hasText: 'Cancelled by user · hang' }).waitFor()
    const card = section.getByRole('region', { name: 'Active runs' }).getByRole('article', { name: 'browser-hang on repo', exact: true })
    await card.getByRole('img', { name: 'Workflow steps: hang paused', exact: true }).waitFor()
    const cardText = (await card.textContent()) ?? ''
    for (const expected of ['Paused · Cancelled by user', 'hang · Claude Code', 'Elapsed', 'Cost']) {
      if (!cardText.includes(expected)) throw new Error(`active run card lacks ${JSON.stringify(expected)}: ${cardText}`)
    }
    log(`workflows-section: active card ${JSON.stringify(cardText)}`)
    await shot('section-active-card')

    const recent = section.getByRole('region', { name: 'Recent runs' }).getByRole('article', { name: 'browser-hang on repo', exact: true })
    const recentBefore = await recent.count()
    await needsYou.getByRole('button', { name: 'Cancel run: browser-hang on repo', exact: true }).click()
    await waitForRunStatus(backend, runId, 'cancelled')
    await card.waitFor({ state: 'detached' })
    await needsYou.waitFor({ state: 'detached' })
    const deadline = Date.now() + SCENARIO_TIMEOUT_MS
    while ((await recent.count()) !== recentBefore + 1) {
      if (Date.now() > deadline) throw new Error(`Recent shows ${await recent.count()} browser-hang cards, expected ${recentBefore + 1}`)
      await new Promise((resolve) => setTimeout(resolve, 200))
    }
    await shot('section-recent')

    await section.getByRole('button', { name: 'Back' }).click()
    await section.waitFor({ state: 'detached' })
    await page.getByRole('img', { name: /^Workflow steps:/ }).waitFor({ state: 'detached' })

    await page.getByRole('button', { name: 'Workflows', exact: true }).click()
    await section.waitFor()
    await shot('sidebar-button')
    await page.keyboard.press('Meta+Alt+w')
    await section.waitFor({ state: 'detached' })
    await page.keyboard.press('Meta+Alt+w')
    await section.waitFor()
    await shot('hotkey')
    await section.getByRole('button', { name: 'Back' }).click()
    await section.waitFor({ state: 'detached' })
    if ((await page.locator('.xterm:visible').count()) === 0) throw new Error('workspace terminals did not come back after closing the Workflows section')
  })
}

async function definitionText(overlay, term) {
  return (await overlay.locator('dt', { hasText: term }).locator('xpath=following-sibling::dd[1]').textContent())?.trim()
}

async function flowExitMarkDone(page, backend) {
  await scenario(page, 'exit-mark-done', async (shot) => {
    if (curlArg !== 'yes') {
      throw new Error('exit-no-complete needs curl: without it the Stop hook fails open and the step completes by fallback')
    }
    await startFromLaunchSheet(page, 'browser-exit', shot)
    const row = needsYouRow(page, 'browser-exit')
    await row.filter({ hasText: 'Step failed · exit' }).waitFor()
    await stepStrip(page, 'exit paused').waitFor()
    const runId = await liveRunId(backend, 'browser-exit')
    await shot('needs-you-failed')

    await row.getByRole('button', { name: 'Jump to tab: browser-exit on repo' }).click()
    const overlay = page.getByRole('region', { name: 'Claude Code exited.' })
    await overlay.waitFor()
    const status = await definitionText(overlay, 'Status')
    const completedBy = await definitionText(overlay, 'Completed by')
    if (status !== 'failed' || completedBy !== 'process exit') {
      throw new Error(`overlay shows status=${status} completedBy=${completedBy}, expected failed/process exit`)
    }
    log(`exit-mark-done: overlay status=${status} completedBy=${completedBy} summary=${JSON.stringify(await definitionText(overlay, 'Summary'))}`)

    const form = overlay.getByRole('form', { name: 'Mark step done' })
    await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))))
    const summaryBox = form.getByLabel(/^Summary/)
    await summaryBox.fill(MARK_DONE_SUMMARY)
    const typed = await summaryBox.inputValue()
    if (typed !== MARK_DONE_SUMMARY) throw new Error(`Summary field lost the typed text: ${JSON.stringify(typed)}`)
    await shot('mark-done-form')
    await form.getByRole('button', { name: 'Mark done' }).click()

    await form.waitFor({ state: 'detached' })
    await overlay.locator('dd', { hasText: 'you (Mark done)' }).waitFor()
    const doneStatus = await definitionText(overlay, 'Status')
    const doneSummary = await definitionText(overlay, 'Summary')
    if (doneStatus !== 'done' || doneSummary !== MARK_DONE_SUMMARY) {
      throw new Error(`overlay after Mark done shows status=${doneStatus} summary=${doneSummary}`)
    }
    await row.waitFor({ state: 'detached' })
    await page.getByRole('img', { name: /^Workflow steps:/ }).waitFor({ state: 'detached' })
    await shot('run-done')
    const record = await waitForRunStatus(backend, runId, 'done')
    const last = record.attempts.filter((a) => a.stepId === 'exit').at(-1)
    if (last?.result?.completedBy !== 'user' || last.result.summary !== MARK_DONE_SUMMARY) {
      throw new Error(`exit step result ${JSON.stringify(last?.result)}, expected completedBy user with the typed summary`)
    }
  })
}

async function personalRunIds(backend, defName) {
  const { state } = await backend.snapshot()
  return Object.entries(state.workflows.runs)
    .filter(([, run]) => run.defId === `personal:${defName}`)
    .map(([runId]) => runId)
}

async function newRunId(backend, defName, before) {
  const deadline = Date.now() + SCENARIO_TIMEOUT_MS
  for (;;) {
    const fresh = (await personalRunIds(backend, defName)).filter((runId) => !before.has(runId))
    if (fresh.length === 1) return fresh[0]
    if (fresh.length > 1 || Date.now() > deadline) throw new Error(`expected one new ${defName} run, found ${fresh.length}`)
    await new Promise((resolve) => setTimeout(resolve, 200))
  }
}

async function flowRunDetail(page, backend) {
  await scenario(page, 'run-detail', async (shot) => {

    await page.getByRole('button', { name: 'Workflows', exact: true }).click()
    const section = page.getByRole('region', { name: 'Workflows', exact: true })
    await section.waitFor()
    const card = section.getByRole('region', { name: 'Recent runs' }).getByRole('article', { name: 'browser-exit on repo', exact: true }).first()
    await card.getByRole('button', { name: 'Open run: browser-exit on repo', exact: true }).click()

    const detail = section.getByRole('region', { name: 'browser-exit', exact: true })
    await detail.waitFor()
    const graph = detail.getByRole('group', { name: 'Workflow graph', exact: true })
    await graph.getByRole('listitem', { name: 'exit: done', exact: true }).waitFor()

    const rows = detail.getByRole('list', { name: 'Attempt timeline', exact: true }).getByRole('button')
    const deadline = Date.now() + SCENARIO_TIMEOUT_MS
    while ((await rows.count()) !== 2) {
      if (Date.now() > deadline) throw new Error(`timeline shows ${await rows.count()} attempts, expected 2`)
      await new Promise((resolve) => setTimeout(resolve, 200))
    }
    const labels = await rows.evaluateAll((buttons) => buttons.map((b) => b.getAttribute('aria-label') ?? ''))
    const [first, second] = labels
    if (!first.startsWith('exit #1:') || !first.includes(': failed') || !first.includes('completed by process exit')) {
      throw new Error(`first timeline row ${JSON.stringify(first)}, expected the failed process-exit attempt`)
    }
    if (!second.startsWith('exit #2:') || !second.includes(': done') || !second.includes('completed by you (Mark done)')) {
      throw new Error(`second timeline row ${JSON.stringify(second)}, expected the attempt completed by you (Mark done)`)
    }
    log(`run-detail: timeline ${JSON.stringify(labels)}`)
    await shot('detail-timeline')

    await rows.nth(0).click()
    const result = detail.getByRole('region', { name: 'Attempt result', exact: true })
    await result.locator('dd', { hasText: 'process exit' }).waitFor()
    await rows.nth(1).click()
    const summary = result.getByLabel('Attempt summary', { exact: true })
    await summary.filter({ hasText: MARK_DONE_SUMMARY }).waitFor()
    const text = await summary.textContent()
    if (text !== MARK_DONE_SUMMARY) throw new Error(`attempt summary ${JSON.stringify(text)}, expected ${JSON.stringify(MARK_DONE_SUMMARY)}`)
    if ((await rows.nth(1).getAttribute('aria-pressed')) !== 'true') throw new Error('the selected timeline row is not pressed')
    await shot('detail-summary')
    const changes = detail.getByRole('region', { name: 'Changed files', exact: true })
    await changes.getByText('No snapshot for this attempt', { exact: true }).waitFor()
    log('run-detail: the Mark done attempt (#2, no base snapshot) shows No snapshot for this attempt')

    await detail.getByRole('button', { name: 'All runs', exact: true }).click()
    await detail.waitFor({ state: 'detached' })
    await card.waitFor()
    await section.getByRole('button', { name: 'Back', exact: true }).click()
    await section.waitFor({ state: 'detached' })

    const before = new Set(await personalRunIds(backend, 'smoke-diamond'))
    await startFromLaunchSheet(page, 'smoke-diamond', shot)
    const diamondRunId = await newRunId(backend, 'smoke-diamond', before)
    await waitForRunStatus(backend, diamondRunId, 'done', 3 * SCENARIO_TIMEOUT_MS)
    log(`run-detail: smoke-diamond run ${diamondRunId} done`)
    await page.getByRole('button', { name: 'Workflows', exact: true }).click()
    await section.waitFor()
    const diamondCard = section.getByRole('region', { name: 'Recent runs' }).getByRole('article', { name: 'smoke-diamond on repo', exact: true }).first()
    await diamondCard.getByRole('button', { name: 'Open run: smoke-diamond on repo', exact: true }).click()
    const diamond = section.getByRole('region', { name: 'smoke-diamond', exact: true })
    await diamond.waitFor()
    const diamondGraph = diamond.getByRole('group', { name: 'Workflow graph', exact: true })
    for (const stepId of ['plan', 'left', 'right', 'join']) {
      await diamondGraph.getByRole('listitem', { name: `${stepId}: done`, exact: true }).waitFor()
    }
    const edges = (await diamondGraph.locator('path[data-edge]').evaluateAll((paths) => paths.map((p) => p.getAttribute('data-edge')))).sort()
    const expectedEdges = ['left->join', 'plan->left', 'plan->right', 'right->join']
    if (JSON.stringify(edges) !== JSON.stringify(expectedEdges)) {
      throw new Error(`diamond graph edges ${JSON.stringify(edges)}, expected ${JSON.stringify(expectedEdges)}`)
    }
    log(`run-detail: diamond graph edges ${JSON.stringify(edges)}`)
    await shot('diamond-graph')
    await diamond.getByRole('button', { name: 'All runs', exact: true }).click()
    await diamond.waitFor({ state: 'detached' })
    await section.getByRole('button', { name: 'Back', exact: true }).click()
    await section.waitFor({ state: 'detached' })
  })
}

const DIFF_FILE = 'smoke.txt'

async function newestPersonalRunId(backend, defName) {
  const { state } = await backend.snapshot()
  const [newest] = Object.entries(state.workflows.runs)
    .filter(([, run]) => run.defId === `personal:${defName}`)
    .sort(([, a], [, b]) => b.startedAt - a.startedAt)
  if (!newest) throw new Error(`no run of ${defName}`)
  return newest[0]
}

async function flowAttemptDiff(page, backend) {
  await scenario(page, 'attempt-diff', async (shot) => {
    try {
      await startFromLaunchSheet(page, 'browser-diff', shot)
      const runId = await newestPersonalRunId(backend, 'browser-diff')
      const record = await waitForRunStatus(backend, runId, 'done')
      log(`attempt-diff: run ${runId} done with ${record.attempts.length} attempt(s)`)

      await page.getByRole('button', { name: 'Workflows', exact: true }).click()
      const section = page.getByRole('region', { name: 'Workflows', exact: true })
      await section.waitFor()
      const card = section.getByRole('region', { name: 'Recent runs' }).getByRole('article', { name: 'browser-diff on repo', exact: true }).first()
      await card.getByRole('button', { name: 'Open run: browser-diff on repo', exact: true }).click()
      const detail = section.getByRole('region', { name: 'browser-diff', exact: true })
      await detail.waitFor()

      const changes = detail.getByRole('region', { name: 'Changed files', exact: true })
      const file = changes.getByRole('button', { name: `${DIFF_FILE}, added, +1 −0`, exact: true })
      await file.waitFor()
      const listed = await changes.getByRole('listitem').allTextContents()
      log(`attempt-diff: changed files ${JSON.stringify(listed)}`)
      await shot('changed-files')

      await file.click()
      if ((await file.getAttribute('aria-pressed')) !== 'true') throw new Error(`${DIFF_FILE} is not the selected file`)
      const diff = changes.getByRole('region', { name: `File diff · ${DIFF_FILE}`, exact: true })
      await diff.locator('.monaco-diff-editor').waitFor()
      await diff.locator('.editor.modified .view-lines', { hasText: 'smoke' }).waitFor()
      const originalPane = await diff.locator('.editor.original').boundingBox()
      if (!originalPane || originalPane.width < 100) {
        throw new Error(`original side is ${originalPane?.width ?? 0}px wide; the diff is not side by side`)
      }
      log(`attempt-diff: ${DIFF_FILE} diff renders side by side with the modified text "smoke"`)
      await shot('file-diff')

      await detail.getByRole('button', { name: 'All runs', exact: true }).click()
      await detail.waitFor({ state: 'detached' })
      await section.getByRole('button', { name: 'Back', exact: true }).click()
      await section.waitFor({ state: 'detached' })
    } finally {
      rmSync(join(worktreePath, DIFF_FILE), { force: true })
    }
  })
}

const SWAP_MODEL = 'fake-codex-model'

async function flowSwapStep(page, backend) {
  await scenario(page, 'swap-step', async (shot) => {
    if (curlArg !== 'yes') {
      throw new Error('swap-step needs curl: without it the Claude Stop hook fails open and the step completes by fallback')
    }
    await startFromLaunchSheet(page, 'browser-swap', shot)
    await needsYouRow(page, 'browser-swap').filter({ hasText: 'Step failed · swap' }).waitFor()
    const runId = await liveRunId(backend, 'browser-swap')

    await page.getByRole('button', { name: 'Workflows', exact: true }).click()
    const section = page.getByRole('region', { name: 'Workflows', exact: true })
    await section.waitFor()
    const card = section.getByRole('region', { name: 'Active runs' }).getByRole('article', { name: 'browser-swap on repo', exact: true })
    await card.getByRole('button', { name: 'Open run: browser-swap on repo', exact: true }).click()
    const detail = section.getByRole('region', { name: 'browser-swap', exact: true })
    await detail.waitFor()
    await shot('detail-failed')

    await detail.getByRole('button', { name: 'Swap harness/model: swap', exact: true }).click()
    const dialog = page.getByRole('dialog', { name: 'Swap harness or model for “swap”', exact: true })
    await dialog.waitFor()
    if (!(await focusInside(dialog))) throw new Error('swap dialog opened without focus inside it')
    await dialog.getByLabel('Agent', { exact: true }).selectOption('codex')
    await dialog.getByLabel('Model', { exact: true }).fill(SWAP_MODEL)
    await shot('swap-dialog')
    await dialog.getByRole('button', { name: 'Swap and retry', exact: true }).click()
    await dialog.waitFor({ state: 'detached' })

    const record = await waitForRunStatus(backend, runId, 'done')
    const step = record.definition.steps.find((s) => s.id === 'swap')
    if (step?.agent !== 'codex' || step.model !== SWAP_MODEL || step.permissions !== 'read-only') {
      throw new Error(`swapped step ${JSON.stringify(step)}, expected codex/${SWAP_MODEL}/read-only`)
    }
    if (record.overriddenFrom?.swap?.agent !== 'claude') {
      throw new Error(`overriddenFrom ${JSON.stringify(record.overriddenFrom)}, expected the original claude step`)
    }
    const attempts = record.attempts.filter((a) => a.stepId === 'swap').map((a) => `${a.n}:${a.agent}:${a.status}`)
    if (attempts.join(',') !== '1:claude:failed,2:codex:done') {
      throw new Error(`swap attempts ${JSON.stringify(attempts)}, expected 1:claude:failed,2:codex:done`)
    }
    log(`swap-step: run ${runId} done after swapping Claude to Codex (${attempts.join(', ')})`)

    const graph = detail.getByRole('group', { name: 'Workflow graph', exact: true })
    await graph.getByRole('listitem', { name: 'swap: done', exact: true }).waitFor()
    const rows = detail.getByRole('list', { name: 'Attempt timeline', exact: true }).getByRole('button')
    const deadline = Date.now() + SCENARIO_TIMEOUT_MS
    while ((await rows.count()) !== 2) {
      if (Date.now() > deadline) throw new Error(`timeline shows ${await rows.count()} attempts, expected 2`)
      await new Promise((resolve) => setTimeout(resolve, 200))
    }
    await shot('detail-done')

    await detail.getByRole('button', { name: 'All runs', exact: true }).click()
    await detail.waitFor({ state: 'detached' })
    await section.getByRole('button', { name: 'Back', exact: true }).click()
    await section.waitFor({ state: 'detached' })
  })
}

const GATE_FEEDBACK = 'Tighten the draft from the browser smoke.'

async function waitForGateAttempts(backend, runId, count) {
  const deadline = Date.now() + SCENARIO_TIMEOUT_MS
  for (;;) {
    const record = await backend.request('workflows:getRun', runId)
    const drafts = record?.attempts.filter((a) => a.stepId === 'draft') ?? []
    const settled = drafts.length === count && drafts[count - 1].status !== 'running'
    if (record?.status === 'paused' && record.pausedReason === 'gate' && settled) return record
    if (Date.now() > deadline) {
      throw new Error(`run ${runId} is ${record?.status}/${record?.pausedReason} with ${drafts.length} draft attempts, expected ${count} at the gate`)
    }
    await new Promise((resolve) => setTimeout(resolve, 200))
  }
}

async function flowGate(page, backend) {
  await scenario(page, 'gate', async (shot) => {
    let runId = null
    try {
      await startFromLaunchSheet(page, 'browser-gate', shot)
      await needsYouRow(page, 'browser-gate').filter({ hasText: 'Waiting at gate · draft' }).waitFor()
      runId = await liveRunId(backend, 'browser-gate')
      await waitForGateAttempts(backend, runId, 1)
      await shot('needs-you-gate')

      await page.getByRole('button', { name: 'Workflows', exact: true }).click()
      const section = page.getByRole('region', { name: 'Workflows', exact: true })
      await section.waitFor()
      const card = section.getByRole('region', { name: 'Active runs' }).getByRole('article', { name: 'browser-gate on repo', exact: true })
      await card.getByRole('button', { name: 'Open run: browser-gate on repo', exact: true }).click()
      const detail = section.getByRole('region', { name: 'browser-gate', exact: true })
      await detail.waitFor()
      const graph = detail.getByRole('group', { name: 'Workflow graph', exact: true })
      await graph.getByRole('listitem', { name: 'draft: waiting at gate, needs you', exact: true }).waitFor()
      await shot('detail-gate')

      const opener = detail.getByRole('button', { name: 'Request changes: draft', exact: true })
      await opener.click()
      const dialog = page.getByRole('dialog', { name: 'Request changes to “draft”', exact: true })
      await dialog.waitFor()
      if (!(await focusInside(dialog))) throw new Error('request changes dialog opened without focus inside it')
      const submit = dialog.getByRole('button', { name: 'Request changes', exact: true })
      if (await submit.isEnabled()) throw new Error('Request changes is enabled with blank feedback')
      await page.keyboard.press('Escape')
      await dialog.waitFor({ state: 'detached' })
      if (!(await opener.evaluate((el) => el === document.activeElement))) throw new Error('Escape did not return focus to Request changes')
      log('gate: dialog submit disabled while blank; Escape closed it and focus returned to Request changes: draft')

      await opener.click()
      await dialog.waitFor()
      await dialog.getByLabel('Feedback', { exact: true }).fill(GATE_FEEDBACK)
      await shot('request-changes-dialog')
      await submit.click()
      await dialog.waitFor({ state: 'detached' })

      const second = await waitForGateAttempts(backend, runId, 2)
      const drafts = second.attempts.filter((a) => a.stepId === 'draft').map((a) => `${a.n}:${a.status}`)
      if (drafts.join(',') !== '1:done,2:done') throw new Error(`draft attempts ${JSON.stringify(drafts)}, expected 1:done,2:done`)
      const rows = detail.getByRole('list', { name: 'Attempt timeline', exact: true }).getByRole('button')
      const deadline = Date.now() + SCENARIO_TIMEOUT_MS
      while ((await rows.count()) !== 2) {
        if (Date.now() > deadline) throw new Error(`timeline shows ${await rows.count()} attempts, expected 2`)
        await new Promise((resolve) => setTimeout(resolve, 200))
      }
      await graph.getByRole('listitem', { name: 'draft: waiting at gate, needs you', exact: true }).waitFor()
      log(`gate: run ${runId} paused at the gate again after Request changes (${drafts.join(', ')})`)
      await shot('detail-attempt-2')

      await detail.getByRole('button', { name: 'All runs', exact: true }).click()
      await detail.waitFor({ state: 'detached' })
      await section.getByRole('button', { name: 'Back', exact: true }).click()
      await section.waitFor({ state: 'detached' })

      const row = needsYouRow(page, 'browser-gate').filter({ hasText: 'Waiting at gate · draft' })
      await row.waitFor()
      await shot('needs-you-approve')
      await row.getByRole('button', { name: 'Approve: draft, browser-gate on repo', exact: true }).click()
      const record = await waitForRunStatus(backend, runId, 'done')
      const publish = record.attempts.filter((a) => a.stepId === 'publish').map((a) => a.status)
      if (record.steps.draft !== 'done' || publish.join(',') !== 'done') {
        throw new Error(`after approve draft is ${record.steps.draft} and publish attempts ${JSON.stringify(publish)}`)
      }
      await row.waitFor({ state: 'detached' })
      log(`gate: run ${runId} done after Approve from Needs you; publish ran once`)
      await shot('run-done')
    } finally {
      if (runId) {
        const record = await backend.request('workflows:getRun', runId)
        if (record && ['queued', 'running', 'paused'].includes(record.status)) {
          await backend.request('workflows:cancelRun', runId)
          await waitForRunStatus(backend, runId, 'cancelled')
        }
      }
      const tab = page.getByRole('button', { name: /^Close tab ⚙ draft/ })
      if (await tab.count()) {
        await tab.first().click()
        await tab.waitFor({ state: 'detached' })
        log('gate: closed the draft step tab so the multi-turn agent exits')
      }
    }
  })
}

async function waitForLoopCap(backend, runId) {
  const deadline = Date.now() + SCENARIO_TIMEOUT_MS
  for (;;) {
    const record = await backend.request('workflows:getRun', runId)
    const reviews = record?.attempts.filter((a) => a.stepId === 'review') ?? []
    if (record?.status === 'paused' && record.pausedReason === 'loop-cap' && reviews.every((a) => a.status !== 'running')) return record
    if (Date.now() > deadline) throw new Error(`run ${runId} is ${record?.status}/${record?.pausedReason}, expected paused at its loop cap`)
    await new Promise((resolve) => setTimeout(resolve, 200))
  }
}

async function flowLoopCap(page, backend) {
  await scenario(page, 'loop-cap', async (shot) => {
    let runId = null
    try {
      await startFromLaunchSheet(page, 'browser-loop-cap', shot)
      const row = needsYouRow(page, 'browser-loop-cap').filter({ hasText: 'Loop limit reached · review' })
      await row.waitFor()
      runId = await liveRunId(backend, 'browser-loop-cap')
      await waitForLoopCap(backend, runId)
      const again = row.getByRole('button', { name: 'Loop again: review, browser-loop-cap on repo', exact: true })
      const proceed = row.getByRole('button', { name: 'Continue anyway: review, browser-loop-cap on repo', exact: true })
      await again.waitFor()
      await proceed.waitFor()
      await row.getByRole('button', { name: 'Cancel run: browser-loop-cap on repo', exact: true }).waitFor()
      await shot('needs-you-loop-cap')

      await page.getByRole('button', { name: 'Workflows', exact: true }).click()
      const section = page.getByRole('region', { name: 'Workflows', exact: true })
      await section.waitFor()
      const card = section.getByRole('region', { name: 'Active runs' }).getByRole('article', { name: 'browser-loop-cap on repo', exact: true })
      await card.getByRole('button', { name: 'Open run: browser-loop-cap on repo', exact: true }).click()
      const detail = section.getByRole('region', { name: 'browser-loop-cap', exact: true })
      await detail.waitFor()
      await detail.getByRole('group', { name: 'Workflow graph', exact: true }).getByRole('listitem', { name: 'review: done, needs you', exact: true }).waitFor()
      await detail.getByRole('button', { name: 'Loop again: review', exact: true }).waitFor()
      await detail.getByRole('button', { name: 'Continue anyway: review', exact: true }).waitFor()
      await shot('detail-loop-cap')
      await detail.getByRole('button', { name: 'All runs', exact: true }).click()
      await detail.waitFor({ state: 'detached' })
      await section.getByRole('button', { name: 'Back', exact: true }).click()
      await section.waitFor({ state: 'detached' })

      await proceed.click()
      const record = await waitForRunStatus(backend, runId, 'done')
      const count = (stepId) => record.attempts.filter((a) => a.stepId === stepId).length
      const publish = record.attempts.filter((a) => a.stepId === 'publish').map((a) => a.status)
      if (record.steps.review !== 'done' || count('build') !== 1 || count('review') !== 1 || publish.join(',') !== 'done') {
        throw new Error(
          `after Continue anyway review is ${record.steps.review}, build/review attempts ${count('build')}/${count('review')}, publish attempts ${JSON.stringify(publish)}`
        )
      }
      await row.waitFor({ state: 'detached' })
      log(`loop-cap: run ${runId} done after Continue anyway from Needs you; review ran once, publish ran once`)
      await shot('run-done')
    } finally {
      if (runId) {
        const record = await backend.request('workflows:getRun', runId)
        if (record && ['queued', 'running', 'paused'].includes(record.status)) {
          await backend.request('workflows:cancelRun', runId)
          await waitForRunStatus(backend, runId, 'cancelled')
        }
      }
      const tabs = page.getByRole('button', { name: /^Close tab ⚙ review/ })
      const before = await tabs.count()
      if (before > 0) {
        await tabs.last().click()
        const deadline = Date.now() + SCENARIO_TIMEOUT_MS
        while ((await tabs.count()) >= before) {
          if (Date.now() > deadline) throw new Error('the review step tab did not close')
          await new Promise((resolve) => setTimeout(resolve, 200))
        }
        log('loop-cap: closed the review step tab')
      }
    }
  })
}

const BROWSER_REPO_FILE = '.harness/workflows/browser-repo.yaml'

async function newestRepoRunId(backend, name) {
  const { state } = await backend.snapshot()
  const defIds = new Set(
    Object.values(state.workflows.definitions)
      .filter((d) => d.scope === 'repo' && d.name === name)
      .map((d) => d.id)
  )
  const [newest] = Object.entries(state.workflows.runs)
    .filter(([, run]) => defIds.has(run.defId))
    .sort(([, a], [, b]) => b.startedAt - a.startedAt)
  if (!newest) throw new Error(`no run of the repo definition ${name}`)
  return newest[0]
}

async function flowRepoTrust(page, backend) {
  await scenario(page, 'repo-trust', async (shot) => {
    const nonce = `# browser-smoke ${Date.now()}`
    appendFileSync(join(worktreePath, BROWSER_REPO_FILE), `${nonce}\n`)
    try {
      const row = worktreeRow(page)
      await row.scrollIntoViewIfNeeded()
      await row.click({ button: 'right' })
      await page.getByRole('menuitem', { name: 'Run workflow here…' }).click()
      const sheet = page.getByRole('dialog', { name: 'Run workflow' })
      await sheet.getByLabel('Workflow').selectOption({ label: 'browser-repo (repo)' })
      const panel = sheet.getByRole('region', { name: 'Trust this repo workflow?' })
      await panel.waitFor()
      const source = sheet.getByLabel('Definition source')
      await source.filter({ hasText: nonce }).waitFor()
      const cells = await panel.locator('tbody td').allTextContents()
      if (cells.join('|') !== 'check|shell|shell') throw new Error(`trust panel step rows ${JSON.stringify(cells)}`)
      const start = sheet.getByRole('button', { name: 'Start' })
      if (await start.isEnabled()) throw new Error('Start is enabled before the repo definition is trusted')
      log('repo-trust: trust panel shows the edited source and check|shell|shell; Start disabled')
      await shot('trust-panel')

      await panel.getByRole('button', { name: 'Trust this definition' }).click()
      await panel.waitFor({ state: 'detached' })
      await page.waitForFunction(
        (el) => el instanceof HTMLButtonElement && !el.disabled,
        await start.elementHandle()
      )
      await shot('trusted')
      await start.click()
      await sheet.waitFor({ state: 'hidden' })
      await stepStrip(page, 'check running').waitFor()
      await shot('strip-running')
      const runId = await newestRepoRunId(backend, 'browser-repo')
      await waitForRunStatus(backend, runId, 'done')
      await page.getByRole('img', { name: /^Workflow steps:/ }).waitFor({ state: 'detached' })
      log(`repo-trust: run ${runId} done after trusting through the UI`)
      await shot('run-done')
    } finally {
      execFileSync('git', ['checkout', '--', BROWSER_REPO_FILE], { cwd: worktreePath })
    }
  })
}

const PICKER_FILE = 'docs/picker-target.md'
const UNTRUSTED_ISSUE_NOTICE = "This issue's author is not a collaborator: steps will run with at most edit permissions"

async function flowInputPickers(page, backend) {
  await scenario(page, 'input-pickers', async (shot) => {
    const dataDir = process.env.HARNESS_DATA_DIR
    if (!dataDir) throw new Error('input-pickers needs HARNESS_DATA_DIR to read the run record from disk')
    const row = worktreeRow(page)
    await row.scrollIntoViewIfNeeded()
    await row.click({ button: 'right' })
    await page.getByRole('menuitem', { name: 'Run workflow here…' }).click()
    const sheet = page.getByRole('dialog', { name: 'Run workflow' })
    await sheet.getByLabel('Workflow', { exact: true }).selectOption({ label: 'browser-file' })
    const picker = sheet.getByRole('combobox', { name: /^target/ })
    await picker.focus()
    await page.keyboard.type('picker')
    const listbox = sheet.getByRole('listbox', { name: 'target options', exact: true })
    const option = listbox.getByRole('option', { name: PICKER_FILE, exact: true })
    await option.waitFor()
    await page.keyboard.press('ArrowDown')
    if ((await option.getAttribute('aria-selected')) !== 'true') throw new Error(`${PICKER_FILE} is not the active option after ArrowDown`)
    await shot('file-options')
    await page.keyboard.press('Enter')
    if ((await picker.getAttribute('aria-expanded')) !== 'false') throw new Error('the file list stayed open after Enter')
    if (!(await sheet.isVisible())) throw new Error('Enter in the file picker closed or submitted the sheet')
    const picked = await picker.inputValue()
    if (picked !== PICKER_FILE) throw new Error(`file picker shows ${JSON.stringify(picked)}, expected ${PICKER_FILE}`)

    const ticket = sheet.getByLabel(/^ticket/)
    if ((await ticket.getAttribute('role')) === 'combobox') throw new Error('the issue input is a picker without a GitHub token')
    if ((await ticket.getAttribute('inputmode')) !== 'numeric') throw new Error('the issue fallback is not a number field')
    await ticket.fill('7')
    log(`input-pickers: chose ${PICKER_FILE} from the file picker with the keyboard; issue input fell back to a number field`)
    await sheet.getByRole('status').filter({ hasText: UNTRUSTED_ISSUE_NOTICE }).waitFor()
    log('input-pickers: the untrusted-author notice shows before Start (sandbox repo has no origin)')
    await shot('picked')

    await sheet.getByRole('button', { name: 'Start', exact: true }).click()
    await sheet.waitFor({ state: 'detached' })
    const runId = await newestPersonalRunId(backend, 'browser-file')
    await waitForRunStatus(backend, runId, 'done')
    const record = JSON.parse(readFileSync(join(dataDir, 'workflow-runs', `${runId}.json`), 'utf8'))
    if (record.inputs?.target !== PICKER_FILE || record.inputs?.ticket !== '7') {
      throw new Error(`run inputs ${JSON.stringify(record.inputs)}, expected target ${PICKER_FILE} and ticket 7`)
    }
    if (record.inputsUntrusted !== true) {
      throw new Error(`run record inputsUntrusted is ${JSON.stringify(record.inputsUntrusted)}, expected true`)
    }
    log(`input-pickers: run ${runId} done (test -f passed) with inputs ${JSON.stringify(record.inputs)} and inputsUntrusted true`)
    await page.getByRole('img', { name: /^Workflow steps:/ }).waitFor({ state: 'detached' })
    await shot('run-done')
  })
}

const OVERRIDE_MODEL = 'fake/opencode-model'

async function flowLaunchOverrides(page, backend) {
  await scenario(page, 'launch-overrides', async (shot) => {
    const dataDir = process.env.HARNESS_DATA_DIR
    if (!dataDir) throw new Error('launch-overrides needs HARNESS_DATA_DIR to read the run record from disk')
    const row = worktreeRow(page)
    await row.scrollIntoViewIfNeeded()
    await row.click({ button: 'right' })
    await page.getByRole('menuitem', { name: 'Run workflow here…' }).click()
    const sheet = page.getByRole('dialog', { name: 'Run workflow' })
    await sheet.getByLabel('Workflow', { exact: true }).selectOption({ label: 'smoke' })
    const toggle = sheet.getByRole('button', { name: 'Overrides', exact: true })
    if ((await toggle.getAttribute('aria-expanded')) !== 'false') throw new Error('Overrides is not collapsed by default')
    await toggle.click()
    if ((await toggle.getAttribute('aria-expanded')) !== 'true') throw new Error('Overrides did not expand')
    await sheet.getByLabel('Agent for plan', { exact: true }).selectOption('opencode')
    await sheet.getByLabel('Model for plan', { exact: true }).fill(OVERRIDE_MODEL)
    await sheet.getByRole('button', { name: 'Overrides (1 changed)', exact: true }).waitFor()
    await shot('overrides')
    const opencodeTabs = page.getByRole('button', { name: 'Close tab ⚙ plan · opencode', exact: true })
    const before = await opencodeTabs.count()
    await sheet.getByRole('button', { name: 'Start', exact: true }).click()
    await sheet.waitFor({ state: 'detached' })

    const deadline = Date.now() + SCENARIO_TIMEOUT_MS
    while ((await opencodeTabs.count()) <= before) {
      if (Date.now() > deadline) throw new Error(`no new ⚙ plan · opencode tab (still ${before})`)
      await new Promise((resolve) => setTimeout(resolve, 200))
    }
    log(`launch-overrides: ⚙ plan · opencode tabs ${before} -> ${await opencodeTabs.count()}`)
    await shot('opencode-tab')
    const runId = await newestPersonalRunId(backend, 'smoke')
    await waitForRunStatus(backend, runId, 'done')
    const record = JSON.parse(readFileSync(join(dataDir, 'workflow-runs', `${runId}.json`), 'utf8'))
    if (record.overriddenFrom?.plan?.agent !== 'claude') {
      throw new Error(`overriddenFrom ${JSON.stringify(record.overriddenFrom)}, expected the original claude plan step`)
    }
    const plan = record.definition.steps.find((s) => s.id === 'plan')
    if (plan?.agent !== 'opencode' || plan.model !== OVERRIDE_MODEL) {
      throw new Error(`plan step ${JSON.stringify(plan)}, expected opencode/${OVERRIDE_MODEL}`)
    }
    const attempts = record.attempts.filter((a) => a.stepId === 'plan').map((a) => `${a.n}:${a.agent}:${a.status}`)
    if (attempts.join(',') !== '1:opencode:done') throw new Error(`plan attempts ${JSON.stringify(attempts)}, expected 1:opencode:done`)
    log(`launch-overrides: run ${runId} done with plan overridden from claude to opencode (${attempts.join(', ')})`)
    await page.getByRole('img', { name: /^Workflow steps:/ }).waitFor({ state: 'detached' })
    await shot('run-done')
    await launchAutopilot(page, backend, dataDir, shot)
  })
}

async function launchAutopilot(page, backend, dataDir, shot) {
  let runId = null
  try {
    const row = worktreeRow(page)
    await row.scrollIntoViewIfNeeded()
    await row.click({ button: 'right' })
    await page.getByRole('menuitem', { name: 'Run workflow here…' }).click()
    const sheet = page.getByRole('dialog', { name: 'Run workflow' })
    await sheet.getByLabel('Workflow', { exact: true }).selectOption({ label: 'browser-gate' })
    await sheet.getByRole('button', { name: 'Overrides', exact: true }).click()
    const autopilot = sheet.getByRole('checkbox', { name: 'Autopilot (approve gates automatically)', exact: true })
    if (await autopilot.isChecked()) throw new Error('Autopilot is checked by default')
    await autopilot.check()
    await sheet.getByRole('button', { name: 'Overrides (1 changed)', exact: true }).waitFor()
    await shot('autopilot')
    const before = new Set(Object.keys((await backend.snapshot()).state.workflows.runs))
    await sheet.getByRole('button', { name: 'Start', exact: true }).click()
    await sheet.waitFor({ state: 'detached' })

    const gateRow = needsYouRow(page, 'browser-gate').filter({ hasText: 'Waiting at gate · draft' })
    const deadline = Date.now() + SCENARIO_TIMEOUT_MS
    let record = null
    for (;;) {
      if ((await gateRow.count()) > 0) throw new Error('autopilot run showed a Needs-you gate row')
      if (runId === null) {
        const { state } = await backend.snapshot()
        runId = Object.keys(state.workflows.runs).find((id) => !before.has(id) && state.workflows.runs[id].defId === 'personal:browser-gate') ?? null
      }
      record = runId === null ? null : await backend.request('workflows:getRun', runId)
      if (record?.status === 'done') break
      if (record && ['paused', 'failed', 'cancelled'].includes(record.status)) {
        throw new Error(`autopilot run ${runId} is ${record.status}/${record.pausedReason}, expected done`)
      }
      if (Date.now() > deadline) throw new Error(`autopilot run ${runId} is ${record?.status}, expected done`)
      await new Promise((resolve) => setTimeout(resolve, 200))
    }
    const disk = JSON.parse(readFileSync(join(dataDir, 'workflow-runs', `${runId}.json`), 'utf8'))
    if (disk.autopilot !== true || disk.status !== 'done') {
      throw new Error(`autopilot record autopilot=${JSON.stringify(disk.autopilot)} status=${disk.status}, expected true/done`)
    }
    const drafts = disk.attempts.filter((a) => a.stepId === 'draft').map((a) => `${a.n}:${a.status}`)
    const publish = disk.attempts.filter((a) => a.stepId === 'publish').map((a) => a.status)
    if (drafts.join(',') !== '1:done' || publish.join(',') !== 'done' || disk.steps.publish !== 'done') {
      throw new Error(`autopilot draft attempts ${JSON.stringify(drafts)} publish ${JSON.stringify(publish)}, expected 1:done and done`)
    }
    if (disk.attempts.some((a) => a.metrics.pauses.length > 0)) throw new Error('autopilot run recorded a pause')
    const debugLog = join(dataDir, 'debug.log')
    let logNote = 'debug.log not found'
    if (existsSync(debugLog)) {
      const lines = readFileSync(debugLog, 'utf8').split('\n').filter((line) => line.includes(runId))
      if (!lines.some((line) => line.includes('run started'))) {
        logNote = 'debug.log has no lines for this run'
      } else {
        if (lines.some((line) => line.includes('run paused'))) throw new Error(`debug.log has a run paused line for ${runId}`)
        if (!lines.some((line) => line.includes('gate approved') && line.includes('"decision":"autopilot"'))) {
          throw new Error(`debug.log has no gate approved autopilot line for ${runId}`)
        }
        if (!lines.some((line) => line.includes('step done') && line.includes('"stepId":"draft"'))) {
          throw new Error(`debug.log has no step done line for draft in ${runId}`)
        }
        logNote = 'debug.log has step done draft, gate approved (autopilot) and no run paused'
      }
    }
    log(`launch-overrides: autopilot run ${runId} done without a Needs-you row (record autopilot true; draft ${drafts.join(',')}; publish ${publish.join(',')}; ${logNote})`)
    await shot('autopilot-done')
  } finally {
    if (runId) {
      const record = await backend.request('workflows:getRun', runId)
      if (record && ['queued', 'running', 'paused'].includes(record.status)) {
        await backend.request('workflows:cancelRun', runId)
        await waitForRunStatus(backend, runId, 'cancelled')
      }
    }
    const tab = page.getByRole('button', { name: /^Close tab ⚙ draft/ })
    if (await tab.count()) {
      await tab.first().click()
      await tab.waitFor({ state: 'detached' })
      log('launch-overrides: closed the autopilot draft step tab so the multi-turn agent exits')
    }
  }
}

async function flowLibrary(page, backend) {
  await scenario(page, 'library', async (shot) => {
    const dataDir = process.env.HARNESS_DATA_DIR
    if (!dataDir) throw new Error('library needs HARNESS_DATA_DIR to check the definition files on disk')
    const copyName = 'smoke-retry-copy'
    const copyId = `personal:${copyName}`
    const copyFile = join(dataDir, 'workflows', `${copyName}.yaml`)
    if (existsSync(copyFile)) throw new Error(`${copyFile} exists before the library scenario`)
    const section = page.getByRole('region', { name: 'Workflows', exact: true })
    try {
      await page.getByRole('button', { name: 'Workflows', exact: true }).click()
      await section.waitFor()
      const tab = section.getByRole('tab', { name: 'Library', exact: true })
      await tab.click()
      if ((await tab.getAttribute('aria-selected')) !== 'true') throw new Error('the Library tab is not selected after clicking it')
      const personal = section.getByRole('region', { name: /^Personal/ })
      await personal.getByRole('button', { name: 'Run smoke-retry', exact: true }).waitFor()
      const groups = await section.getByRole('tabpanel').locator('section > h2').allTextContents()
      log(`library: groups ${JSON.stringify(groups)}`)
      if (!groups.some((g) => g.startsWith('This repo'))) throw new Error(`no "This repo" group: ${JSON.stringify(groups)}`)
      await shot('library')

      await personal.getByRole('button', { name: 'Duplicate smoke-retry', exact: true }).click()
      await personal.getByRole('button', { name: `Run ${copyName}`, exact: true }).waitFor()
      const copied = readFileSync(copyFile, 'utf8')
      if (!copied.includes(`name: "${copyName}"`)) throw new Error(`copy on disk does not carry the new name: ${copied.slice(0, 200)}`)
      const { state } = await backend.snapshot()
      const saved = state.workflows.definitions[copyId]
      if (saved?.name !== copyName) throw new Error(`no ${copyId} summary in the slice`)
      log(`library: duplicated smoke-retry to ${copyFile}`)
      await shot('duplicated')

      await personal.getByRole('button', { name: `Delete ${copyName}`, exact: true }).click()
      const dialog = page.getByRole('alertdialog', { name: `Delete “${copyName}”?`, exact: true })
      await dialog.waitFor()
      if (!((await dialog.textContent()) ?? '').includes(saved.path)) throw new Error(`the delete dialog does not name ${saved.path}`)
      await assertFocusTrapped(page, dialog, 'library')
      await shot('delete-confirm')
      await dialog.getByRole('button', { name: 'Delete file', exact: true }).click()
      await dialog.waitFor({ state: 'detached' })
      await personal.getByRole('button', { name: `Run ${copyName}`, exact: true }).waitFor({ state: 'detached' })
      if (existsSync(copyFile)) throw new Error(`${copyFile} is still on disk after Delete`)
      log(`library: deleted ${copyFile}`)
      await shot('deleted')
    } finally {
      if (existsSync(copyFile)) await backend.request('workflows:deleteDefinition', copyId).catch(() => rmSync(copyFile, { force: true }))
      if (await section.count()) await section.getByRole('button', { name: 'Back' }).click()
      await section.waitFor({ state: 'detached' })
    }
  })
}

const EDITOR_DEF_NAME = 'zz-editor-smoke'

function editorSource(stepId, run, verifyRun = 'echo verify\n') {
  return `name: ${EDITOR_DEF_NAME}\nsteps:\n  - id: ${stepId}\n    kind: shell\n    run: ${run}\n  - id: verify\n    kind: shell\n    run: ${verifyRun}`
}

async function waitForPreview(preview, expected) {
  const nodes = preview.getByRole('group', { name: 'Workflow graph', exact: true }).getByRole('listitem')
  const deadline = Date.now() + 15_000
  let labels = []
  while (Date.now() < deadline) {
    labels = await nodes.evaluateAll((els) => els.map((el) => el.getAttribute('aria-label')))
    if (labels.join(',') === expected.join(',')) return
    await new Promise((r) => setTimeout(r, 100))
  }
  throw new Error(`graph preview nodes ${JSON.stringify(labels)}, expected ${JSON.stringify(expected)}`)
}

async function replaceEditorText(page, editor, text) {
  await editor.locator('.view-lines').click()
  await page.keyboard.press('ControlOrMeta+a')
  const pasted = await page.evaluate((value) => {
    const target = document.activeElement
    if (!target?.closest('.monaco-editor')) return false
    const data = new DataTransfer()
    data.setData('text/plain', value)
    target.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }))
    return true
  }, text)
  if (!pasted) throw new Error('focus is not inside the Monaco editor')
}

async function saveFromEditor(section) {
  await section.getByRole('button', { name: 'Save', exact: true }).click()
  const alert = section.getByRole('alert')
  await alert.or(section.getByRole('status').filter({ hasText: /^Saved to/ })).first().waitFor()
  if (await alert.count()) throw new Error(`Save refused: ${await alert.first().textContent()}`)
}

async function waitForFileText(file, needle) {
  const deadline = Date.now() + 15_000
  while (Date.now() < deadline) {
    if (existsSync(file) && readFileSync(file, 'utf8').includes(needle)) return
    await new Promise((r) => setTimeout(r, 100))
  }
  throw new Error(`${file} never contained ${JSON.stringify(needle)}`)
}

async function flowDefinitionEditor(page, backend) {
  await scenario(page, 'definition-editor', async (shot) => {
    const dataDir = process.env.HARNESS_DATA_DIR
    if (!dataDir) throw new Error('definition-editor needs HARNESS_DATA_DIR to check the saved file on disk')
    const file = join(dataDir, 'workflows', `${EDITOR_DEF_NAME}.yaml`)
    if (existsSync(file)) throw new Error(`${file} exists before the definition-editor scenario`)
    const section = page.getByRole('region', { name: 'Workflows', exact: true })
    const editor = section.locator('.monaco-editor').first()
    const preview = section.getByRole('region', { name: 'Graph preview', exact: true })
    const staleGraph = preview.getByText('Fix errors to update the graph', { exact: true })
    const personal = section.getByRole('region', { name: /^Personal/ })
    const row = personal.getByRole('listitem').filter({ has: page.getByRole('button', { name: `Run ${EDITOR_DEF_NAME}`, exact: true }) })
    let savedId = null
    try {
      await page.getByRole('button', { name: 'Workflows', exact: true }).click()
      await section.waitFor()
      await section.getByRole('tab', { name: 'Library', exact: true }).click()
      await section.getByRole('button', { name: 'New workflow', exact: true }).click()
      await editor.locator('.view-lines').waitFor()
      await section.getByRole('heading', { name: 'New workflow', exact: true }).waitFor()
      await waitForPreview(preview, ['hello'])
      await shot('new')

      await replaceEditorText(page, editor, editorSource('draft', 'echo draft', 'echo {{steps.dr'))
      await waitForPreview(preview, ['draft', 'verify'])
      await page.keyboard.press('Control+Space')
      const suggest = page.locator('.suggest-widget.visible')
      await suggest.getByText('steps.draft.summary').first().waitFor()
      const suggestRows = await suggest.locator('.monaco-list-row').allTextContents()
      const suggestText = suggestRows.join(' | ')
      if (!suggestText.includes('steps.draft.status') || suggestText.includes('inputs.')) throw new Error(`suggest widget: ${suggestText}`)
      log(`definition-editor: {{steps.dr completes to steps.draft.summary / steps.draft.status (${JSON.stringify(suggestRows)})`)
      await shot('autocomplete')
      await page.keyboard.press('Escape')
      await suggest.waitFor({ state: 'detached' }).catch(() => suggest.waitFor({ state: 'hidden' }))

      await replaceEditorText(page, editor, editorSource('draft', 'echo draft'))
      await section.locator('.monaco-editor .view-lines').filter({ hasText: 'echo draft' }).waitFor()
      await waitForPreview(preview, ['draft', 'verify'])
      if (await staleGraph.count()) throw new Error('a valid draft shows the stale graph message')
      log('definition-editor: graph preview shows a node per step: draft, verify')
      await shot('drafted')
      await saveFromEditor(section)
      await waitForFileText(file, 'id: draft')
      await section.getByRole('heading', { name: `Edit ${EDITOR_DEF_NAME}`, exact: true }).waitFor()
      const { state } = await backend.snapshot()
      const saved = Object.values(state.workflows.definitions).filter((d) => d.name === EDITOR_DEF_NAME)
      if (saved.length !== 1 || saved[0].scope !== 'personal') throw new Error(`saved summaries ${JSON.stringify(saved)}`)
      savedId = saved[0].id
      log(`definition-editor: New saved as ${savedId} at ${file}`)
      await section.getByRole('button', { name: 'Back to Library', exact: true }).click()
      if (await page.getByRole('alertdialog').count()) throw new Error('a saved New draft asked to discard')
      await row.getByText('2 steps: draft, verify', { exact: true }).waitFor()
      await shot('saved-new')

      await row.getByRole('button', { name: `Edit ${EDITOR_DEF_NAME}`, exact: true }).click()
      await section.getByRole('heading', { name: `Edit ${EDITOR_DEF_NAME}`, exact: true }).waitFor()
      await section.locator('.monaco-editor .view-lines').filter({ hasText: 'echo draft' }).waitFor()
      log(`definition-editor: Edit opened ${savedId} with its saved source`)
      await replaceEditorText(page, editor, editorSource('edited', 'echo {{steps.bogus.summary}}'))
      await editor.locator('.squiggly-error').first().waitFor()
      const problems = section.getByRole('region', { name: 'Problems', exact: true })
      const problemText = (await problems.textContent()) ?? ''
      if (!problemText.includes('"bogus", which is not a step in this workflow')) throw new Error(`problems list: ${problemText}`)
      log(`definition-editor: unknown step ref marked (.squiggly-error) with "${problemText.slice(0, 160)}"`)
      await waitForPreview(preview, ['edited', 'verify'])
      await shot('marker')

      await replaceEditorText(page, editor, `name: ${EDITOR_DEF_NAME}\nsteps:\n  - id: "broken\n`)
      await staleGraph.waitFor()
      await waitForPreview(preview, ['edited', 'verify'])
      log('definition-editor: YAML syntax error keeps the last graph (edited, verify) with "Fix errors to update the graph"')
      await shot('preview-stale')

      await replaceEditorText(page, editor, editorSource('edited', 'echo edited'))
      await editor.locator('.squiggly-error').first().waitFor({ state: 'detached' })
      await problems.getByText('No problems', { exact: true }).waitFor()
      await staleGraph.waitFor({ state: 'detached' })
      log('definition-editor: marker cleared after the fix')
      await shot('fixed')

      await saveFromEditor(section)
      await waitForFileText(file, 'id: edited')
      if (readFileSync(file, 'utf8').includes('id: draft')) throw new Error(`${file} still holds the first draft`)
      await section.getByText('Unsaved changes').waitFor({ state: 'detached' })
      await section.getByRole('button', { name: 'Back to Library', exact: true }).click()
      if (await page.getByRole('alertdialog').count()) throw new Error('a saved draft asked to discard')
      await row.getByText('2 steps: edited, verify', { exact: true }).waitFor()
      const after = (await backend.snapshot()).state.workflows.definitions
      const named = Object.values(after).filter((d) => d.name === EDITOR_DEF_NAME)
      if (named.length !== 1 || named[0].id !== savedId || named[0].stepIds.join(',') !== 'edited,verify') {
        throw new Error(`after the second save: ${JSON.stringify(named)}`)
      }
      log(`definition-editor: Save from Edit overwrote ${savedId}; Library row reads "2 steps: edited, verify" and ${file} holds id: edited`)
      await shot('library-updated')
    } finally {
      if (savedId) await backend.request('workflows:deleteDefinition', savedId).catch(() => rmSync(file, { force: true }))
      else rmSync(file, { force: true })
      if (await section.count()) {
        await section.getByRole('button', { name: 'Back', exact: true }).click()
        const discard = page.getByRole('alertdialog', { name: 'Discard unsaved changes?', exact: true })
        if (await discard.count()) await discard.getByRole('button', { name: 'Discard changes', exact: true }).click()
      }
      await section.waitFor({ state: 'detached' })
    }
  })
}

async function assertPresetSheet(sheet, worktreeLabel, defName) {
  await sheet.waitFor()
  await sheet.getByText(`in ${worktreeLabel}`, { exact: true }).waitFor()
  if (await sheet.getByRole('radio', { name: 'New worktree', exact: true }).count()) {
    throw new Error(`the launch sheet for ${worktreeLabel} offers a New worktree target instead of the preset`)
  }
  if (defName) {
    const chosen = await sheet.getByLabel('Workflow', { exact: true }).evaluate((el) => el.selectedOptions[0]?.textContent ?? '')
    if (chosen !== defName) throw new Error(`the launch sheet selected ${JSON.stringify(chosen)}, expected ${JSON.stringify(defName)}`)
  }
}

async function flowEntryPoints(page, backend) {
  await scenario(page, 'entry-points', async (shot) => {
    const original = worktreeRow(page)
    await original.scrollIntoViewIfNeeded()
    await original.click()
    await page.keyboard.press('Meta+k')
    await page.getByPlaceholder('Search worktrees and commands...').fill('run workflow')
    await shot('palette')
    await page.getByRole('button', { name: /^Run workflow…/ }).click()
    const sheet = page.getByRole('dialog', { name: 'Run workflow' })
    await assertPresetSheet(sheet, worktreePath.split('/').pop(), null)
    await shot('palette-sheet')
    await page.keyboard.press('Escape')
    await sheet.waitFor({ state: 'detached' })
    log(`entry-points: palette Run workflow… opened the launch sheet on ${worktreePath}`)

    const branch = `wf-entry-${Date.now().toString(36)}`
    await page.keyboard.press('Meta+n')
    await page.getByPlaceholder('fix-the-thing').fill(branch)
    await page.getByLabel('Workflow', { exact: true }).selectOption({ label: 'browser-hang' })
    await shot('new-worktree-form')
    await page.getByRole('button', { name: 'Create worktree' }).click()
    await assertPresetSheet(sheet, branch, 'browser-hang')
    await shot('new-worktree-sheet')

    const { state } = await backend.snapshot()
    const created = state.worktrees.list.find((wt) => wt.branch === branch)
    if (!created) throw new Error(`no worktree on branch ${branch} in the sidebar state`)
    const tree = state.terminals.panes[created.path]
    if (!tree) throw new Error(`no pane tree for ${created.path}`)
    const tabs = []
    const walk = (node) => (node.type === 'leaf' ? tabs.push(...node.tabs) : node.children.forEach(walk))
    walk(tree)
    const kinds = tabs.map((tab) => tab.type)
    if (kinds.join(',') !== 'shell') throw new Error(`the workflow worktree opened tabs ${JSON.stringify(kinds)}, expected only a shell`)
    log(`entry-points: New Worktree with a workflow created ${created.path} with tabs ${JSON.stringify(kinds)} and opened the sheet preset to it`)

    await page.keyboard.press('Escape')
    await sheet.waitFor({ state: 'detached' })
    await original.click()
  })
}

async function flowLaunchTarget(page, backend) {
  await scenario(page, 'launch-target', async (shot) => {
    const dataDir = process.env.HARNESS_DATA_DIR
    if (!dataDir) throw new Error('launch-target needs HARNESS_DATA_DIR to read the run record from disk')
    let runId = null
    try {
      await page.getByRole('button', { name: 'Workflows', exact: true }).click()
      const section = page.getByRole('region', { name: 'Workflows', exact: true })
      await section.waitFor()
      await section.getByRole('button', { name: 'Run workflow…', exact: true }).click()
      const sheet = page.getByRole('dialog', { name: 'Run workflow' })
      await sheet.waitFor()
      const repo = sheet.getByLabel('Repository', { exact: true })
      if (!(await repo.evaluate((el) => el === document.activeElement))) {
        throw new Error('the launch sheet without a preset did not focus the Repository select')
      }
      await assertFocusTrapped(page, sheet, 'launch-target')
      if (!(await sheet.getByRole('radio', { name: 'New worktree', exact: true }).isChecked())) {
        throw new Error('New worktree is not the default target')
      }
      await sheet.getByLabel('Workflow', { exact: true }).selectOption({ label: 'browser-hang' })
      const branch = await sheet.getByLabel('Branch name', { exact: true }).inputValue()
      if (!/^wf\/browser-hang\/[0-9a-f]{8}$/.test(branch)) throw new Error(`default branch name ${JSON.stringify(branch)}`)
      await shot('target-new-worktree')
      await sheet.getByRole('button', { name: 'Start', exact: true }).click()
      await sheet.waitFor({ state: 'detached' })
      await section.waitFor({ state: 'detached' })

      const row = page.locator('[aria-current="true"]').filter({ has: page.getByText(branch, { exact: true }) })
      await row.waitFor()
      await row.getByRole('img', { name: 'Workflow steps: hang running', exact: true }).waitFor()
      await page.getByRole('button', { name: 'Close tab ⚙ hang · Claude', exact: true }).waitFor()
      await shot('selected-with-strip')

      const { state } = await backend.snapshot()
      const created = state.worktrees.list.find((wt) => wt.branch === branch)
      if (!created) throw new Error(`no worktree on branch ${branch} in the sidebar state`)
      if (state.worktrees.pending.length !== 0) throw new Error(`pending worktrees left behind: ${JSON.stringify(state.worktrees.pending)}`)
      const live = Object.entries(state.workflows.runs).filter(
        ([, run]) => run.worktreePath === created.path && ['queued', 'running', 'paused'].includes(run.status)
      )
      if (live.length !== 1) throw new Error(`expected one live run on ${created.path}, found ${live.length}`)
      runId = live[0][0]
      const record = JSON.parse(readFileSync(join(dataDir, 'workflow-runs', `${runId}.json`), 'utf8'))
      if (record.worktreePath !== created.path || record.defId !== 'personal:browser-hang') {
        throw new Error(`run record ${runId} targets ${record.worktreePath} with ${record.defId}`)
      }
      log(`launch-target: run ${runId} started on new worktree ${created.path} (branch ${branch}), selected with a running strip`)
    } finally {
      if (runId) {
        await backend.request('workflows:cancelRun', runId)
        await waitForRunStatus(backend, runId, 'cancelled')
      }
      const original = worktreeRow(page)
      if (await original.count()) await original.click()
    }
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
    await flowLaunchSheetFocus(page)
    await flowHangCancel(page, backend)
    await flowWorkflowsSection(page, backend)
    await flowExitMarkDone(page, backend)
    await flowRunDetail(page, backend)
    await flowAttemptDiff(page, backend)
    await flowSwapStep(page, backend)
    await flowGate(page, backend)
    await flowLoopCap(page, backend)
    await flowRepoTrust(page, backend)
    await flowInputPickers(page, backend)
    await flowLaunchOverrides(page, backend)
    await flowLibrary(page, backend)
    await flowDefinitionEditor(page, backend)
    await flowEntryPoints(page, backend)
    await flowLaunchTarget(page, backend)
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
