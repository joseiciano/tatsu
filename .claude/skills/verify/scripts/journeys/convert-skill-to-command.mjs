#!/usr/bin/env node
// Convert the seeded Opencode skill "release-notes" into a command through
// the Config page, then prove the command file landed in the sandbox HOME.
//
// Usage: node .claude/skills/verify/scripts/journeys/convert-skill-to-command.mjs <state.env>
import { copyFileSync, existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { openConfig, withApp } from '../browser.mjs'

await withApp(process.argv[2], 'convert-skill-to-command', async ({ page, state, shot, log }) => {
  const target = join(state.SANDBOX_HOME, '.config/opencode/commands/release-notes.md')
  if (existsSync(target)) throw new Error(`precondition: ${target} already exists`)

  await openConfig(page)
  await page.getByRole('tab', { name: 'Skills' }).click()
  const convert = page.getByRole('button', { name: 'Create command from release-notes' })
  await convert.waitFor()
  await shot('skills-before')

  await convert.click()
  const name = page.locator('#config-create-name')
  await name.waitFor()
  log(`draft name: ${await name.inputValue()}`)
  await shot('draft')

  await page.getByRole('button', { name: 'Create command', exact: true }).click()
  for (let i = 0; i < 50 && !existsSync(target); i++) await page.waitForTimeout(100)
  if (!existsSync(target)) throw new Error(`${target} was not written`)
  copyFileSync(target, join(state.EVIDENCE, 'release-notes.command.md'))
  log(`written ${target}:\n${readFileSync(target, 'utf8')}`)

  const commandsTab = page.getByRole('tab', { name: 'Commands' })
  await commandsTab.click()
  await page.locator('[role="tab"][aria-selected="true"]', { hasText: 'Commands' }).waitFor()
  await page.waitForTimeout(250)
  const selected = await page.getByRole('tab', { selected: true }).allTextContents()
  log(`selected tab after clicking Commands: ${JSON.stringify(selected)}`)
  await page.getByRole('button', { name: /release-notes/ }).first().waitFor()
  await shot('commands-after')
  if (selected.join() !== 'Commands') throw new Error(`Commands tab not marked selected (got ${JSON.stringify(selected)})`)

  const source = join(state.SANDBOX_HOME, '.config/opencode/skills/release-notes/SKILL.md')
  if (!existsSync(source)) throw new Error('source skill disappeared after conversion')
})
