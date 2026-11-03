// Workflow run through the rendered UI: right-click the worktree row ->
// "Run workflow here…" -> pick a definition -> Start -> step strip -> run
// record on disk.
//
// Usage: node journeys/workflow-run.mjs <state.env> [defName]
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { withApp } from '../browser.mjs'

const defName = process.argv[3] ?? 'verify-done'
const TIMEOUT = 60_000

await withApp(process.argv[2], `workflow-run-${defName}`, async ({ page, state, shot, log }) => {
  const rowLabel = state.WORKTREE.split('/').slice(-2).join('/')
  const row = page.getByText(rowLabel, { exact: true })
  await row.waitFor({ timeout: TIMEOUT })
  await row.scrollIntoViewIfNeeded()
  await row.click({ button: 'right' })
  await page.getByRole('menu').waitFor()
  await shot('context-menu')
  await page.getByRole('menuitem', { name: 'Run workflow here…' }).click()

  const sheet = page.getByRole('dialog', { name: 'Run workflow' })
  await sheet.waitFor()
  await sheet.getByLabel('Workflow').selectOption({ label: defName })
  await shot('launch-sheet')
  await sheet.getByRole('button', { name: 'Start' }).click()
  await sheet.waitFor({ state: 'hidden', timeout: TIMEOUT })
  log('launch sheet closed after Start')

  const strip = page.getByRole('img', { name: /^Workflow steps:/ })
  await strip.waitFor({ timeout: TIMEOUT })
  log(`strip: ${await strip.getAttribute('aria-label')}`)
  await shot('step-strip')

  await strip.waitFor({ state: 'detached', timeout: TIMEOUT })
  log('strip gone: run left the live statuses')
  await shot('after-run')

  const dir = join(state.DATA_DIR, 'workflow-runs')
  const records = existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith('.json')) : []
  const runs = records.map((f) => JSON.parse(readFileSync(join(dir, f), 'utf8')))
  const run = runs.find((r) => r.definition?.name === defName || r.defId === `personal:${defName}`)
  if (!run) throw new Error(`no run record for ${defName} in ${dir}`)
  log(`run record ${run.runId ?? run.id}: status=${run.status}`)
  if (run.status !== 'done') throw new Error(`run ended ${run.status}/${run.pausedReason ?? ''}`)
})
