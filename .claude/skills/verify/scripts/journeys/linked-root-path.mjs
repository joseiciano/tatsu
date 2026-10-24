#!/usr/bin/env node
// Replace the sandbox ~/.config/opencode/agents with a symlink into a dotfiles
// build, the way a dotfiles setup links it. Prove the Config editor shows the
// file at the configured ~/.config path, names the build folder only as the
// link source, and keeps the file read-only.
//
// Usage: node .claude/skills/verify/scripts/journeys/linked-root-path.mjs <state.env>
import { mkdirSync, renameSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { openConfig, withApp } from '../browser.mjs'

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
  const banner = await page.getByText(/^Read-only\. Linked from /).innerText()
  log(`absolute path: ${shown}`)
  log(`banner: ${banner}`)
  await shot('linked-agent')

  if (!shown.endsWith('/.config/opencode/agents/planner.md') || shown.includes('dotfiles-build')) {
    throw new Error(`path shows the link target instead of the configured folder: ${shown}`)
  }
  if (!banner.includes('dotfiles-build/opencode/agents')) throw new Error('banner does not name the link source')
  if (!(await page.getByRole('button', { name: 'Delete resource' }).isDisabled())) {
    throw new Error('a linked resource is deletable')
  }
})
