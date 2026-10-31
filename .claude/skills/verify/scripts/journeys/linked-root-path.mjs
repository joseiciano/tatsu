#!/usr/bin/env node
// Replace the sandbox ~/.config/opencode/agents with a symlink into a dotfiles
// build, the way a dotfiles setup links it. Prove the Config editor shows the
// file at the configured ~/.config path, and that Save writes through to the
// link target and leaves the link in place, both for that folder link and for
// the seeded linked-skill entry link.
//
// Usage: node .claude/skills/verify/scripts/journeys/linked-root-path.mjs <state.env>
import { lstatSync, mkdirSync, readFileSync, renameSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { openConfig, withApp } from '../browser.mjs'

const EDIT = 'Edited through the link.'

async function editAndSave(page, shot, log, label, target) {
  const editor = page.locator('.monaco-editor').first()
  await editor.waitFor()
  await editor.click()
  await page.keyboard.press('Meta+ArrowDown')
  await page.keyboard.press('End')
  await page.keyboard.type(`\n${EDIT}`)
  await page.getByRole('button', { name: 'Save', exact: true }).click()
  for (let i = 0; i < 50 && !readFileSync(target, 'utf8').includes(EDIT); i++) await page.waitForTimeout(100)
  const saved = readFileSync(target, 'utf8')
  log(`${label} target after Save:\n${saved}`)
  await shot(`${label}-saved`)
  if (!saved.includes(EDIT)) throw new Error(`${label}: Save did not write through to the link target`)
}

await withApp(process.argv[2], 'linked-root-path', async ({ page, state, shot, log }) => {
  const configured = join(state.SANDBOX_HOME, '.config/opencode/agents')
  const build = join(state.SCRATCH, 'dotfiles-build/opencode/agents')
  mkdirSync(join(build, '..'), { recursive: true })
  renameSync(configured, build)
  symlinkSync(build, configured)
  writeFileSync(join(build, 'planner.md'), '---\ndescription: Plans work.\n---\n\nPlan the work before editing.\n')

  await openConfig(page)
  await page.getByRole('tab', { name: 'Agents' }).click()
  await page.locator('#config-agent-filter').selectOption({ label: 'Opencode' })
  await page.getByRole('button', { name: /^planner planner\.md/ }).first().click()
  const path = page.getByRole('textbox', { name: 'Absolute path' })
  await path.waitFor()
  const shown = await path.inputValue()
  const badge = await page.locator('[title^="Linked from "]').first().getAttribute('title')
  log(`absolute path: ${shown}`)
  log(`linked badge: ${badge}`)
  await shot('linked-agent')
  if (!shown.endsWith('/.config/opencode/agents/planner.md') || shown.includes('dotfiles-build')) {
    throw new Error(`path shows the link target instead of the configured folder: ${shown}`)
  }
  if (!badge?.includes('dotfiles-build/opencode/agents')) throw new Error('linked badge does not name the link source')

  await editAndSave(page, shot, log, 'folder-link', join(build, 'planner.md'))
  if (!lstatSync(configured).isSymbolicLink()) throw new Error('the agents folder is no longer a symlink')

  const skillLink = join(state.SANDBOX_HOME, '.claude/skills/linked-skill')
  await page.locator('#config-agent-filter').selectOption({ label: 'Claude' })
  await page.getByRole('tab', { name: 'Skills' }).click()
  await page.getByRole('button', { name: /^linked-skill linked-skill\/SKILL\.md/ }).first().click()
  await editAndSave(page, shot, log, 'entry-link', join(state.SCRATCH, 'dotfiles/skills/linked-skill/SKILL.md'))
  if (!lstatSync(skillLink).isSymbolicLink()) throw new Error('linked-skill is no longer a symlink')
})
