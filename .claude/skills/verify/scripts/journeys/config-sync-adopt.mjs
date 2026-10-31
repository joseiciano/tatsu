#!/usr/bin/env node
// Adopt the seeded Claude skills into Tatsu config through the Sync dialog,
// then prove the badges flip to Synced, Tatsu stored them, and nothing on
// disk (including the symlinked skill's target) changed.
//
// Usage: node .claude/skills/verify/scripts/journeys/config-sync-adopt.mjs <state.env>
import { copyFileSync, existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { diffTrees, hashTree, openConfig, withApp } from '../browser.mjs'

await withApp(process.argv[2], 'config-sync-adopt', async ({ page, state, shot, log }) => {
  const claudeRoot = join(state.SANDBOX_HOME, '.claude')
  const dotfiles = join(state.SCRATCH, 'dotfiles')
  const configJson = join(state.DATA_DIR, 'config.json')
  const claudeBefore = hashTree(claudeRoot)
  const dotfilesBefore = hashTree(dotfiles)
  const configBefore = existsSync(configJson) ? readFileSync(configJson, 'utf8') : ''

  await openConfig(page)
  await page.getByRole('tab', { name: 'Skills' }).click()
  await page.getByRole('button', { name: 'hello hello/SKILL.md Disk only' }).first().waitFor()
  await shot('skills-before')

  await page.getByRole('button', { name: 'Sync Claude Code' }).click()
  const dialog = page.getByRole('dialog')
  await dialog.waitFor()
  const adopt = dialog.getByRole('button', { name: 'Adopt current disk files into Tatsu config' })
  await adopt.waitFor()
  for (let i = 0; i < 50 && (await adopt.isDisabled()); i++) await page.waitForTimeout(100)
  log(`plan:\n${await dialog.ariaSnapshot()}`)
  await shot('plan')

  await adopt.click()
  await dialog.waitFor({ state: 'detached', timeout: 10000 }).catch(async () => {
    log(`dialog still open after adopt:\n${await dialog.ariaSnapshot()}`)
    await shot('after-adopt-dialog')
    const close = dialog.getByRole('button', { name: /^(Close|Cancel)$/ }).first()
    await close.click()
    await dialog.waitFor({ state: 'detached' })
  })

  await page.getByRole('button', { name: /^hello hello\/SKILL\.md Synced/ }).first().waitFor({ timeout: 5000 })
  await page.waitForTimeout(250)
  await shot('skills-after')
  const rows = await page.getByRole('button', { name: /SKILL\.md/ }).allTextContents()
  log(`skill rows after adopt: ${JSON.stringify(rows)}`)

  const configAfter = existsSync(configJson) ? readFileSync(configJson, 'utf8') : ''
  if (existsSync(configJson)) copyFileSync(configJson, join(state.EVIDENCE, 'config-sync-adopt.config.json'))
  if (configAfter === configBefore) throw new Error('config.json did not change after adopt')
  if (!configAfter.includes('hello')) throw new Error('config.json does not mention the adopted hello skill')

  const claudeDiff = diffTrees(claudeBefore, hashTree(claudeRoot))
  if (claudeDiff.length) throw new Error(`adopt changed files under ~/.claude: ${claudeDiff.join(', ')}`)
  const dotDiff = diffTrees(dotfilesBefore, hashTree(dotfiles))
  if (dotDiff.length) throw new Error(`adopt changed the symlink target: ${dotDiff.join(', ')}`)
  log('~/.claude and dotfiles byte-identical after adopt')
})
