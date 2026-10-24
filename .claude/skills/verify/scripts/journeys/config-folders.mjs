#!/usr/bin/env node
// Point the Claude skills folder at an alternate directory in Settings →
// Config folders, prove a relative path is rejected, the override persists
// and rescans the Config page, and Reset restores the default.
//
// Usage: node .claude/skills/verify/scripts/journeys/config-folders.mjs <state.env>
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { openConfig, withApp } from '../browser.mjs'

const readConfig = (file) => (existsSync(file) ? readFileSync(file, 'utf8') : '')

await withApp(process.argv[2], 'config-folders', async ({ page, state, shot, log }) => {
  const alt = join(state.SCRATCH, 'alt-skills')
  mkdirSync(join(alt, 'alt-one'), { recursive: true })
  writeFileSync(join(alt, 'alt-one/SKILL.md'), '---\nname: alt-one\ndescription: Alternate skill.\n---\n\nAlt.\n')
  const configJson = join(state.DATA_DIR, 'config.json')
  // Settings is only reachable without a repo through the unavailable-root
  // link, so remove the Codex skills root to make that link appear.
  rmSync(join(state.SANDBOX_HOME, '.agents/skills'), { recursive: true, force: true })
  const helloRows = () => page.getByRole('button', { name: /^hello hello\/SKILL\.md/ })

  await openConfig(page)
  await page.getByRole('tab', { name: 'Skills' }).click()
  await helloRows().first().waitFor()
  log(`hello rows before: ${await helloRows().count()}`)

  const openFolders = async () => {
    if (!(await page.getByRole('tablist', { name: 'Resource type' }).isVisible())) await openConfig(page)
    await page.getByRole('tab', { name: 'Skills' }).click()
    await page.getByRole('button', { name: 'Set config folders in Settings' }).first().click()
    await page.locator('#config-folder-claudeSkills').waitFor()
  }
  await openFolders()
  const input = page.locator('#config-folder-claudeSkills')
  log(`claudeSkills placeholder: ${await input.getAttribute('placeholder')}`)
  await shot('folders-before')

  await input.fill('skills')
  await input.press('Enter')
  await page.waitForTimeout(500)
  await shot('relative-rejected')
  const afterRelative = readConfig(configJson)
  if (/"skills"/.test(afterRelative) && afterRelative.includes('claudeSkills')) {
    throw new Error('relative path "skills" was persisted')
  }
  const errText = await page.locator('#config-folder-claudeSkills ~ * .text-danger, .text-danger').allTextContents()
  log(`error text after relative path: ${JSON.stringify(errText)}`)
  if (!errText.some((t) => t.trim())) throw new Error('no error shown for a relative path')

  await input.fill(alt)
  await input.press('Enter')
  for (let i = 0; i < 50 && !readConfig(configJson).includes(alt); i++) await page.waitForTimeout(100)
  if (!readConfig(configJson).includes(alt)) throw new Error('override was not persisted to config.json')
  await shot('override-set')

  await page.keyboard.press('Escape')
  await page.waitForTimeout(300)
  if (!(await page.getByRole('tablist', { name: 'Resource type' }).isVisible())) await openConfig(page)
  await page.getByRole('tab', { name: 'Skills' }).click()
  await page.getByRole('button', { name: /^alt-one/ }).first().waitFor({ timeout: 5000 })
  const helloAfter = await helloRows().count()
  log(`hello rows with override: ${helloAfter}`)
  await shot('skills-with-override')
  if (helloAfter !== 0) throw new Error(`Claude hello still listed with the override (${helloAfter} rows)`)

  await openFolders()
  const resets = page.getByRole('button', { name: /^Reset .* to default$/ })
  log(`reset buttons: ${JSON.stringify(await resets.evaluateAll((els) => els.map((e) => e.getAttribute('aria-label'))))}`)
  const row = page.locator('#config-folder-claudeSkills').locator('xpath=ancestor::*[.//button[starts-with(@aria-label,"Reset ")]][1]')
  await row.getByRole('button', { name: /^Reset .* to default$/ }).click()
  for (let i = 0; i < 50 && readConfig(configJson).includes(alt); i++) await page.waitForTimeout(100)
  if (readConfig(configJson).includes(alt)) throw new Error('reset did not clear the override')
  await shot('after-reset')

  await page.keyboard.press('Escape')
  await page.waitForTimeout(300)
  if (!(await page.getByRole('tablist', { name: 'Resource type' }).isVisible())) await openConfig(page)
  await page.getByRole('tab', { name: 'Skills' }).click()
  await page.waitForTimeout(500)
  const helloReset = await helloRows().count()
  log(`hello rows after reset: ${helloReset}`)
  await shot('skills-after-reset')
  if (helloReset !== 1) throw new Error(`expected Claude hello back after reset, got ${helloReset} rows`)
})
