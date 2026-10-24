#!/usr/bin/env node
// Open the headless Tatsu web client in Chrome and run one journey module against it.
// Usage: node drive.mjs <run-root> <journey.mjs> [--headed]
import { chromium } from 'playwright-core'
import { readFileSync, mkdirSync, writeFileSync, appendFileSync } from 'node:fs'
import { resolve, basename } from 'node:path'
import { pathToFileURL } from 'node:url'

const [runRoot, journeyPath] = process.argv.slice(2)
if (!runRoot || !journeyPath) {
  console.error('usage: node drive.mjs <run-root> <journey.mjs> [--headed]')
  process.exit(2)
}
const root = resolve(runRoot)
const url = readFileSync(`${root}/url`, 'utf8').trim()
const name = basename(journeyPath, '.mjs')
const evidence = `${root}/evidence/${name}`
mkdirSync(evidence, { recursive: true })
const logFile = `${evidence}/steps.log`
writeFileSync(logFile, '')
const log = (msg) => {
  const line = `[${new Date().toISOString()}] ${msg}`
  console.log(line)
  appendFileSync(logFile, line + '\n')
}

const browser = await chromium.launch({
  channel: process.env.HARNESS_PLAYWRIGHT_BROWSER ? undefined : 'chrome',
  executablePath: process.env.HARNESS_PLAYWRIGHT_BROWSER || undefined,
  headless: !process.argv.includes('--headed')
})
const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } })
page.on('console', (m) => { if (m.type() === 'error') log(`console.error ${m.text()}`) })
page.on('pageerror', (e) => log(`pageerror ${e.message}`))

let n = 0
const shot = async (label) => {
  const file = `${evidence}/${String(++n).padStart(2, '0')}-${label}`
  await page.screenshot({ path: `${file}.png` })
  writeFileSync(`${file}.aria.txt`, await page.locator('body').ariaSnapshot())
  log(`captured ${file}.{png,aria.txt}`)
}
const fixture = {
  repo: `${root}/fixture/demo-repo`,
  worktree: `${root}/fixture/demo-feature`
}

let code = 0
try {
  await page.goto(url)
  await page.getByText('demo-feature', { exact: false }).first().waitFor({ timeout: 20000 })
  log('web client ready: fixture worktree visible in sidebar')
  const journey = await import(pathToFileURL(resolve(journeyPath)).href)
  await journey.default({ page, shot, log, fixture, evidence })
  log('PASS')
} catch (err) {
  code = 1
  log(`FAIL ${err?.stack ?? err}`)
  await shot('failure').catch(() => {})
} finally {
  await browser.close()
}
process.exit(code)
