#!/usr/bin/env node
// Link a Claude command file into a dotfiles folder, delete it from the Config
// editor, and prove both the dotfiles file and the link are gone. Then create a
// command with the same name and prove it lands as a regular file in the
// commands folder. Then do the same over a link that was already dangling.
//
// Usage: node .claude/skills/verify/scripts/journeys/linked-command-delete.mjs <state.env>
import { existsSync, lstatSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { openConfig, withApp } from '../browser.mjs'

const BODY = 'Ship it from Tatsu.'

function present(path) {
  try {
    lstatSync(path)
    return true
  } catch {
    return false
  }
}

await withApp(process.argv[2], 'linked-command-delete', async ({ page, state, shot, log }) => {
  const targetDir = join(state.SCRATCH, 'dotfiles/commands')
  const target = join(targetDir, 'ship.md')
  const link = join(state.SANDBOX_HOME, '.claude/commands/ship.md')
  mkdirSync(targetDir, { recursive: true })
  writeFileSync(target, 'Ship the current branch.\n')
  symlinkSync(target, link)

  await openConfig(page)
  await page.getByRole('tab', { name: 'Commands' }).click()
  await page.locator('#config-agent-filter').selectOption({ label: 'Claude' })
  await page.getByRole('button', { name: /^ship ship\.md/ }).first().click()
  const remove = page.getByRole('button', { name: 'Delete resource' })
  for (let i = 0; i < 50 && (await remove.isDisabled()); i++) await page.waitForTimeout(100)
  await shot('before-delete')
  await remove.click()
  for (let i = 0; i < 50 && present(link); i++) await page.waitForTimeout(100)
  log(`after delete: target exists=${existsSync(target)} link present=${present(link)}`)
  await shot('after-delete')
  if (existsSync(target)) throw new Error('Delete left the dotfiles file in place')
  if (present(link)) throw new Error('Delete left a dangling link in the commands folder')

  await page.getByRole('button', { name: 'Create in Claude Code' }).click()
  await page.locator('#config-create-name').fill('ship')
  const editor = page.locator('.monaco-editor').first()
  await editor.click()
  await page.keyboard.type(BODY)
  await page.getByRole('button', { name: 'Create', exact: true }).click()
  for (let i = 0; i < 50 && !present(link); i++) await page.waitForTimeout(100)
  await shot('recreated')
  if (!present(link)) throw new Error('Creating ship after the delete wrote nothing')
  if (lstatSync(link).isSymbolicLink()) throw new Error('the recreated command is still a symlink')
  const written = readFileSync(link, 'utf8')
  log(`recreated ship.md:\n${written}`)
  if (!written.includes(BODY)) throw new Error('the recreated command does not hold the typed body')

  const stale = join(state.SANDBOX_HOME, '.claude/commands/stale.md')
  symlinkSync(join(targetDir, 'gone.md'), stale)
  await page.getByRole('button', { name: 'Create in Claude Code' }).click()
  await page.locator('#config-create-name').fill('stale')
  await page.locator('.monaco-editor').first().click()
  await page.keyboard.type(BODY)
  await page.getByRole('button', { name: 'Create', exact: true }).click()
  for (let i = 0; i < 50 && !existsSync(stale); i++) await page.waitForTimeout(100)
  await shot('created-over-dangling')
  if (!existsSync(stale) || lstatSync(stale).isSymbolicLink()) throw new Error('create did not replace the dangling link')
  if (existsSync(join(targetDir, 'gone.md'))) throw new Error('create wrote through the dangling link')
  log(`stale.md over dangling link:\n${readFileSync(stale, 'utf8')}`)
})
