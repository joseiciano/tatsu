// Shared Playwright session for verify journeys:
//   import { withApp, readState } from '../browser.mjs'
// Uses the repo's playwright-core with system Chrome (no bundled Chromium),
// a fresh non-persistent headless browser per journey.
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs'
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

export function launchOptions() {
  const executablePath = process.env.HARNESS_PLAYWRIGHT_BROWSER
  return executablePath
    ? { executablePath, headless: process.env.VERIFY_HEADED !== '1' }
    : { channel: 'chrome', headless: process.env.VERIFY_HEADED !== '1' }
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
  const browser = await chromium.launch(launchOptions())
  let page
  try {
    page = await browser.newPage({ viewport: { width: 1400, height: 900 } })
    page.on('dialog', async (d) => {
      log(`dialog ${d.type()}: ${d.message()} -> dismiss`)
      await d.dismiss()
    })
    page.on('console', (m) => m.type() === 'error' && log(`console error: ${m.text()}`))
    page.on('pageerror', (e) => log(`page error: ${e.message}`))
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
    if (page) {
      await page.screenshot({ path: join(dir, `${journey}-FAIL.png`) }).catch(() => {})
      const tree = await page.locator('body').ariaSnapshot().catch((e) => `ariaSnapshot failed: ${e}`)
      writeFileSync(join(dir, `${journey}-FAIL-aria.txt`), tree)
    }
  } finally {
    await browser.close()
  }
}
