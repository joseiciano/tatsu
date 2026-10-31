#!/usr/bin/env node
// Edit the seeded Claude agent "reviewer" in the Config editor and prove Save
// writes the disk file and stores it in Tatsu; then change the file outside
// Tatsu and prove "Sync Tatsu config to disk" restores Tatsu's version.
//
// Usage: node .claude/skills/verify/scripts/journeys/config-edit-and-sync.mjs <state.env>
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { openConfig, withApp } from '../browser.mjs'

const EDIT = 'Also flag missing tests.'

async function runSync(page, shot, log, harness, button, label) {
  await page.getByRole('button', { name: `Sync ${harness}` }).click()
  const dialog = page.getByRole('dialog')
  await dialog.waitFor()
  const action = dialog.getByRole('button', { name: button })
  for (let i = 0; i < 50 && (await action.isDisabled()); i++) await page.waitForTimeout(100)
  log(`${label} plan:\n${await dialog.ariaSnapshot()}`)
  await shot(`${label}-plan`)
  await action.click()
  await dialog.waitFor({ state: 'detached', timeout: 10000 })
}

await withApp(process.argv[2], 'config-edit-and-sync', async ({ page, state, shot, log }) => {
  const file = join(state.SANDBOX_HOME, '.claude/agents/reviewer.md')

  await openConfig(page)
  await page.getByRole('tab', { name: 'Agents' }).click()
  await page.getByRole('button', { name: /^reviewer reviewer\.md/ }).click()
  const editor = page.locator('.monaco-editor').first()
  await editor.waitFor()
  await editor.click()
  await page.keyboard.press('Meta+ArrowDown')
  await page.keyboard.press('End')
  await page.keyboard.type(`\n${EDIT}`)
  await shot('edited')
  await page.getByRole('button', { name: 'Save', exact: true }).click()
  for (let i = 0; i < 50 && !readFileSync(file, 'utf8').includes(EDIT); i++) await page.waitForTimeout(100)
  const saved = readFileSync(file, 'utf8')
  log(`after Save:\n${saved}`)
  if (!saved.includes(EDIT)) throw new Error('Save did not write the edit to disk')
  // Saving through Tatsu also stores the content, so the row is already Synced.
  await page.getByRole('button', { name: /^reviewer reviewer\.md Synced/ }).waitFor({ timeout: 5000 })
  await shot('saved-synced')

  writeFileSync(file, saved.replace(EDIT, 'Changed outside Tatsu.'))
  await page.getByRole('tab', { name: 'Skills' }).click()
  await page.getByRole('tab', { name: 'Agents' }).click()
  await runSync(page, shot, log, 'Claude Code', 'Sync Tatsu config to disk', 'sync')
  const restored = readFileSync(file, 'utf8')
  log(`after Sync to disk:\n${restored}`)
  if (restored !== saved) throw new Error('Sync to disk did not restore the adopted content')
  await page.getByRole('button', { name: /^reviewer reviewer\.md Synced/ }).waitFor({ timeout: 5000 })
  await shot('synced')
})
