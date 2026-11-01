#!/usr/bin/env node
// Inline fragments, end to end through the Config page:
// 1. create fragment "commit-rules"; 2. put {{fragment:commit-rules}} in the
// Claude skill "hello" and Save; 3. change the fragment, Sync to disk;
// 4. hand-edit the section on disk, then "Use fragment" in the Sync dialog.
// Needs a build that has inline fragments (Step 23).
//
// Usage: node .claude/skills/verify/scripts/journeys/inline-fragments.mjs <state.env>
import { copyFileSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { openConfig, waitForFile, withApp } from '../browser.mjs'

const V1 = 'Use imperative mood.'
const V2 = 'Never commit secrets.'
const HAND = 'Edited by hand on disk.'
const OPEN = /<!-- tatsu:fragment commit-rules sha=([0-9a-f]{12}) -->/

async function waitFor(page, check, label, timeoutMs = 8000) {
  for (let t = 0; t < timeoutMs; t += 100) {
    if (check()) return
    await page.waitForTimeout(100)
  }
  throw new Error(`timed out waiting for ${label}`)
}

async function openSync(page, log, shot, label) {
  await page.getByRole('button', { name: 'Sync Claude Code' }).click()
  const dialog = page.getByRole('dialog')
  await dialog.waitFor()
  await page.waitForTimeout(300)
  log(`${label} dialog:\n${await dialog.ariaSnapshot()}`)
  await shot(`${label}-dialog`)
  return dialog
}

async function clickWhenEnabled(page, locator) {
  for (let i = 0; i < 50 && (await locator.isDisabled()); i++) await page.waitForTimeout(100)
  await locator.click()
}

await withApp(process.argv[2], 'inline-fragments', async ({ page, state, shot, log }) => {
  const skill = join(state.SANDBOX_HOME, '.claude/skills/hello/SKILL.md')
  const fragmentFile = join(state.DATA_DIR, 'harness-config-source/fragments/commit-rules.md')
  const read = () => readFileSync(skill, 'utf8')
  const before = read()

  await openConfig(page)
  await page.getByRole('tab', { name: 'Templates' }).click()
  await page.getByRole('button', { name: 'Create fragment' }).click()
  await page.locator('#fragment-name').fill('commit-rules')
  await page.locator('.monaco-editor').first().click()
  await page.keyboard.insertText(V1)
  await page.getByRole('button', { name: 'Create', exact: true }).click()
  await waitForFile(page, fragmentFile)
  log(`fragment file:\n${readFileSync(fragmentFile, 'utf8')}`)

  // Step 2: placeholder in a plain skill file, saved through the editor.
  await page.getByRole('tab', { name: 'Skills' }).click()
  await page.getByRole('button', { name: /^hello / }).first().click()
  const editor = page.locator('.monaco-editor').first()
  await editor.waitFor()
  await editor.click()
  await page.keyboard.press('Meta+ArrowDown')
  await page.keyboard.press('End')
  await page.keyboard.insertText('\n\n{{fragment:commit-rules}}\n')
  await page.getByText('Saving turns each').waitFor({ timeout: 5000 })
  await shot('placeholder-typed')
  await page.getByRole('button', { name: 'Save', exact: true }).click()
  await waitFor(page, () => read() !== before, 'Save to write SKILL.md')
  const saved = read()
  copyFileSync(skill, join(state.EVIDENCE, 'hello.after-save.SKILL.md'))
  log(`after Save:\n${saved}`)
  if (saved.includes('{{fragment:')) throw new Error('literal placeholder reached disk')
  if (!OPEN.test(saved) || !saved.includes(V1) || !saved.includes('<!-- /tatsu:fragment commit-rules -->')) {
    throw new Error('saved file lacks the marked commit-rules section')
  }
  if (!saved.startsWith(before.trimEnd())) throw new Error('text outside the section changed on save')
  await shot('saved')

  // Step 3: change the fragment in its editor; the file follows after Sync.
  await page.getByRole('tab', { name: 'Templates' }).click()
  await page.locator('[data-testid="config-fragments"]').getByRole('button', { name: /commit-rules/ }).click()
  const usage = page.locator('[data-testid="fragment-usage"]')
  await usage.getByText(/Used in 1 file/).waitFor({ timeout: 5000 })
  log(`fragment usage: ${await usage.innerText()}`)
  await page.locator('.monaco-editor').first().click()
  await page.keyboard.press('Meta+ArrowDown')
  await page.keyboard.press('End')
  await page.keyboard.insertText(`\n${V2}`)
  await shot('fragment-edited')
  await page.getByRole('button', { name: 'Save', exact: true }).click()
  await waitFor(page, () => readFileSync(fragmentFile, 'utf8').includes(V2), 'fragment save')
  if (read() !== saved) throw new Error('fragment save wrote the skill file without a confirmed sync')

  await page.getByRole('tab', { name: 'Skills' }).click()
  const syncDialog = await openSync(page, log, shot, 'after-fragment-change')
  await syncDialog.getByText(/Content changed/).waitFor()
  await clickWhenEnabled(page, syncDialog.getByRole('button', { name: 'Sync to disk' }))
  await syncDialog.waitFor({ state: 'detached', timeout: 10000 })
  const refreshed = read()
  copyFileSync(skill, join(state.EVIDENCE, 'hello.after-fragment-sync.SKILL.md'))
  log(`after fragment change + Sync:\n${refreshed}`)
  if (!refreshed.includes(V1) || !refreshed.includes(V2)) throw new Error('synced file lacks the new fragment text')
  if (OPEN.exec(refreshed)[1] === OPEN.exec(saved)[1]) throw new Error('section hash did not change')
  if (!refreshed.startsWith(before.trimEnd())) throw new Error('text outside the section changed on sync')

  // Step 4: hand edit inside the section on disk, then restore the fragment.
  writeFileSync(skill, refreshed.replace(V2, HAND))
  await page.getByRole('tab', { name: 'Agents' }).click()
  await page.getByRole('tab', { name: 'Skills' }).click()
  const resolveDialog = await openSync(page, log, shot, 'hand-edit')
  await resolveDialog.getByText(/Edited fragment sections/).waitFor({ timeout: 5000 })
  await shot('edited-section')
  if (!read().includes(HAND)) throw new Error('opening Sync changed the disk file')
  await clickWhenEnabled(page, resolveDialog.getByRole('button', { name: 'Use fragment' }))
  await waitFor(page, () => read() === refreshed, 'Use fragment to restore the fragment text on disk')
  await page.getByText(/Already in sync|Resolved and updated this file on disk/).first().waitFor({ timeout: 5000 })
  copyFileSync(skill, join(state.EVIDENCE, 'hello.after-resolve.SKILL.md'))
  log(`after Use fragment:\n${read()}`)
  await shot('resolved')
})
