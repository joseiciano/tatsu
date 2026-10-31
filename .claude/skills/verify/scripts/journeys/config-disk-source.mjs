#!/usr/bin/env node
// Prove disk is the source for hand-written Claude skills: the seeded rows
// carry no drift badge, Sync reports the scope already in sync, and neither
// ~/.claude, the symlinked skill's target, nor config.json changes.
//
// Usage: node .claude/skills/verify/scripts/journeys/config-disk-source.mjs <state.env>
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { diffTrees, hashTree, openConfig, withApp } from '../browser.mjs'

await withApp(process.argv[2], 'config-disk-source', async ({ page, state, shot, log }) => {
  const claudeRoot = join(state.SANDBOX_HOME, '.claude')
  const dotfiles = join(state.SCRATCH, 'dotfiles')
  const configJson = join(state.DATA_DIR, 'config.json')
  const claudeBefore = hashTree(claudeRoot)
  const dotfilesBefore = hashTree(dotfiles)

  await openConfig(page)
  await page.getByRole('tab', { name: 'Skills' }).click()
  const hello = page.getByRole('button', { name: /^hello hello\/SKILL\.md/ }).first()
  await hello.waitFor()
  const rows = await page.getByRole('button', { name: /SKILL\.md/ }).allTextContents()
  log(`skill rows: ${JSON.stringify(rows)}`)
  await shot('skills')
  const badged = rows.filter((row) => /Disk only|Config only|Synced|Out of sync|Not on disk/.test(row))
  if (badged.length) throw new Error(`hand-written skills carry a drift badge: ${badged.join(' | ')}`)

  await page.getByRole('button', { name: 'Sync Claude Code' }).click()
  await page.getByText('Already in sync').first().waitFor({ timeout: 10000 })
  await shot('already-in-sync')
  if (await page.getByRole('dialog').isVisible()) throw new Error('Sync opened a dialog for an in-sync scope')

  const claudeDiff = diffTrees(claudeBefore, hashTree(claudeRoot))
  if (claudeDiff.length) throw new Error(`Sync changed files under ~/.claude: ${claudeDiff.join(', ')}`)
  const dotDiff = diffTrees(dotfilesBefore, hashTree(dotfiles))
  if (dotDiff.length) throw new Error(`Sync changed the symlink target: ${dotDiff.join(', ')}`)
  const config = existsSync(configJson) ? readFileSync(configJson, 'utf8') : ''
  if (config.includes('SKILL.md')) throw new Error('config.json holds a copy of a skill file')
  log('~/.claude, dotfiles, and config.json hold no Tatsu copy of the skills')
})
