// Shared Playwright session for verify journeys. Import from a journey:
//   import { withApp, readState } from '../browser.mjs'
// Uses the repo's playwright-core with system Chrome (no bundled Chromium).
import { appendFileSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { chromium } from 'playwright-core'

export function readState(stateFile) {
  const state = {}
  for (const line of readFileSync(stateFile, 'utf8').split('\n')) {
    const i = line.indexOf('=')
    if (i > 0) state[line.slice(0, i)] = line.slice(i + 1)
  }
  return state
}

export async function withApp(stateFile, journey, fn) {
  const state = readState(stateFile)
  const dir = state.EVIDENCE
  const log = (msg) => {
    const line = `[${new Date().toISOString()}] ${journey}: ${msg}`
    console.log(line)
    appendFileSync(join(dir, 'journal.log'), line + '\n')
  }
  let shotN = 0
  const browser = await chromium.launch({
    channel: 'chrome',
    executablePath: process.env.HARNESS_PLAYWRIGHT_BROWSER || undefined,
    headless: process.env.VERIFY_HEADED !== '1'
  })
  try {
    const page = await browser.newPage({ viewport: { width: 1400, height: 900 } })
    page.on('dialog', async (d) => {
      log(`dialog ${d.type()}: ${d.message()} -> accept`)
      await d.accept()
    })
    page.on('console', (m) => m.type() === 'error' && log(`console error: ${m.text()}`))
    const shot = async (name) => {
      shotN += 1
      const file = join(dir, `${journey}-${String(shotN).padStart(2, '0')}-${name}.png`)
      await page.screenshot({ path: file })
      log(`screenshot ${file}`)
    }
    await page.goto(state.URL)
    await fn({ page, state, shot, log })
    log('PASS')
  } catch (err) {
    log(`FAIL ${err instanceof Error ? err.message : String(err)}`)
    process.exitCode = 1
  } finally {
    await browser.close()
  }
}

// Every journey reaches Config from the fresh-data-dir onboarding screen.
export async function openConfig(page) {
  await page.getByRole('button', { name: /^Open Config/ }).first().click()
  await page.getByRole('tablist', { name: 'Resource type' }).waitFor()
}
