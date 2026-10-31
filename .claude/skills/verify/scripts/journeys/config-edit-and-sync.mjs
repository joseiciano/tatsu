#!/usr/bin/env node
// Edit the seeded Claude agent "reviewer" in the Config editor and prove Save
// writes the disk file; then change the file outside Tatsu and prove Tatsu
// shows the outside version and Sync leaves it alone.
//
// Usage: node .claude/skills/verify/scripts/journeys/config-edit-and-sync.mjs <state.env>
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { openConfig, withApp } from '../browser.mjs'

const EDIT = 'Also flag missing tests.'
const OUTSIDE = 'Changed outside Tatsu.'

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

  writeFileSync(file, saved.replace(EDIT, OUTSIDE))
  await page.getByRole('tab', { name: 'Skills' }).click()
  await page.getByRole('tab', { name: 'Agents' }).click()
  const row = page.getByRole('button', { name: /^reviewer reviewer\.md/ })
  await row.click()
  await page.locator('.view-lines').getByText(OUTSIDE).waitFor({ timeout: 5000 })
  const rowText = await row.textContent()
  log(`row after outside edit: ${rowText}`)
  await shot('outside-edit')
  if (/Out of sync|Synced|Disk only/.test(rowText ?? '')) throw new Error(`outside edit produced a badge: ${rowText}`)

  await page.getByRole('button', { name: 'Sync Claude Code' }).click()
  await page.getByText('Already in sync').first().waitFor({ timeout: 10000 })
  const after = readFileSync(file, 'utf8')
  log(`after Sync:\n${after}`)
  if (!after.includes(OUTSIDE)) throw new Error('Sync reverted the outside edit')
  await shot('synced')
})
