#!/usr/bin/env node
// Import every folder kind the wizard accepts (agents, agent fragments, two
// skills folders, shared references) and prove the agent template keeps its
// fragments, the skill keeps its reference, and no source file changes.
//
// Usage: node .claude/skills/verify/scripts/journeys/import-full-setup.mjs <state.env>
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { diffTrees, hashTree, openConfig, withApp } from '../browser.mjs'

await withApp(process.argv[2], 'import-full-setup', async ({ page, state, shot, log }) => {
  const source = join(state.SCRATCH, 'import-full')
  const out = join(state.DATA_DIR, 'harness-config-source')
  const sourceBefore = hashTree(source)
  const homeBefore = hashTree(state.SANDBOX_HOME)

  await openConfig(page)
  await page.getByRole('tab', { name: 'Templates' }).click()
  await page.getByRole('button', { name: 'Import existing setup…' }).click()
  await page.locator('#import-folder-agents').fill(join(source, 'agents'))
  await page.locator('#import-folder-agentFragments').fill(join(source, 'agents-shared'))
  await page.locator('#import-folder-skills').fill(join(source, 'skills'))
  await page.getByRole('button', { name: 'Add skill folder' }).click()
  const extra = page.locator('[id^="import-folder-skills-"]').first()
  await extra.fill(join(source, 'skills-extra'))
  await page.locator('#import-folder-references').fill(join(source, 'references'))
  await shot('folders')

  await page.getByRole('button', { name: 'Preview import' }).click()
  const importButton = page.getByRole('button', { name: 'Import', exact: true })
  await importButton.waitFor({ timeout: 10000 })
  const preview = await page.locator('body').ariaSnapshot()
  log(`preview:\n${preview.slice(preview.indexOf('Import existing setup'))}`)
  await shot('preview')
  if (await importButton.isDisabled()) throw new Error('Import is disabled after preview')

  await importButton.click()
  await page.getByText('Scopes that now differ from disk').waitFor({ timeout: 10000 })
  await shot('done')

  const written = Object.keys(hashTree(out))
  log(`template source folder: ${JSON.stringify(written)}`)
  for (const want of ['triager', 'house-style', 'safety', 'deploy', 'lint', 'checklist']) {
    if (!written.some((p) => p.includes(want))) throw new Error(`${want} missing from ${out}`)
  }
  const agent = readFileSync(join(out, written.find((p) => p.includes('triager'))), 'utf8')
  log(`triager template:\n${agent}`)
  if (!/house-style[\s\S]*safety/.test(agent)) throw new Error('triager template lost its fragments')

  await page.getByRole('button', { name: 'Close import' }).click()
  for (const name of ['triager', 'deploy', 'lint', 'house-style', 'safety']) {
    await page.getByRole('button', { name: new RegExp(name) }).first().waitFor({ timeout: 5000 })
  }
  await shot('templates-after')

  const sourceDiff = diffTrees(sourceBefore, hashTree(source))
  if (sourceDiff.length) throw new Error(`import changed its source: ${sourceDiff.join(', ')}`)
  const homeDiff = diffTrees(homeBefore, hashTree(state.SANDBOX_HOME))
  if (homeDiff.length) throw new Error(`import wrote harness files before sync: ${homeDiff.join(', ')}`)
})
