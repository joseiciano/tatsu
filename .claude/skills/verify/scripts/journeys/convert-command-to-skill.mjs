#!/usr/bin/env node
// Convert the seeded Opencode command "run-tests" into a skill, and prove
// converting a Claude skill to a command only shows the "already available"
// notice because Claude serves skills as slash commands.
//
// Usage: node .claude/skills/verify/scripts/journeys/convert-command-to-skill.mjs <state.env>
import { copyFileSync, existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { diffTrees, hashTree, openConfig, waitForFile, withApp } from '../browser.mjs'

await withApp(process.argv[2], 'convert-command-to-skill', async ({ page, state, shot, log }) => {
  const target = join(state.SANDBOX_HOME, '.config/opencode/skills/run-tests/SKILL.md')
  const source = join(state.SANDBOX_HOME, '.config/opencode/commands/run-tests.md')
  if (existsSync(target)) throw new Error(`precondition: ${target} already exists`)
  const sourceBefore = readFileSync(source, 'utf8')

  await openConfig(page)
  await page.getByRole('tab', { name: 'Commands' }).click()
  const converts = page.getByRole('button', { name: 'Create skill from run-tests' })
  await converts.first().waitFor()
  if ((await converts.count()) !== 2) throw new Error(`expected Claude and Opencode run-tests rows, got ${await converts.count()}`)
  await shot('commands-before')

  await converts.nth(1).click()
  const name = page.locator('#config-create-name')
  await name.waitFor()
  if ((await name.inputValue()) !== 'run-tests') throw new Error(`draft name is ${await name.inputValue()}`)
  await shot('draft')
  await page.getByRole('button', { name: 'Create skill', exact: true }).click()
  await waitForFile(page, target)
  copyFileSync(target, join(state.EVIDENCE, 'run-tests.SKILL.md'))
  const text = readFileSync(target, 'utf8')
  log(`written ${target}:\n${text}`)
  // Step 10 REQ-005/REQ-007: discoverable front matter plus a pointer body,
  // never the command's own body.
  if (!text.startsWith('---\nname: run-tests\ndescription: Run the test suite\n---\n')) {
    throw new Error('skill is missing name/description front matter from the command')
  }
  if (!text.includes('requests the `run-tests` command behavior')) throw new Error('skill does not point back at the command')
  if (text.includes('Run the project tests')) throw new Error('skill embeds the source command body')
  if (!text.trimEnd().endsWith('<!-- Converted by Tatsu from opencode commands run-tests.md -->')) {
    throw new Error('skill does not end with the converted-by marker')
  }
  if (readFileSync(source, 'utf8') !== sourceBefore) throw new Error('source command changed')

  await page.getByRole('tab', { name: 'Skills' }).click()
  await page.getByRole('button', { name: /^run-tests run-tests\/SKILL\.md/ }).first().waitFor()
  await page.waitForTimeout(250)
  await shot('skills-after')

  const claudeBefore = hashTree(join(state.SANDBOX_HOME, '.claude'))
  await page.getByRole('button', { name: 'Create command from hello' }).first().click()
  const notice = page.getByText('Already available as a command at hello/SKILL.md')
  await notice.waitFor({ timeout: 5000 })
  await shot('claude-already-available')
  log(`notice: ${await notice.textContent()}`)
  if (await page.locator('#config-create-name').count()) throw new Error('a create draft opened for a Claude skill')
  const claudeDiff = diffTrees(claudeBefore, hashTree(join(state.SANDBOX_HOME, '.claude')))
  if (claudeDiff.length) throw new Error(`already-available notice wrote files: ${claudeDiff.join(', ')}`)
})
