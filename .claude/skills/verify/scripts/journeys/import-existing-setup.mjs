#!/usr/bin/env node
// Import the seeded skills and commands folders as templates through the
// Templates tab wizard, then prove the templates landed in the template
// source folder while the import source and harness folders stayed untouched.
//
// Usage: node .claude/skills/verify/scripts/journeys/import-existing-setup.mjs <state.env>
import { readdirSync } from 'node:fs'
import { join } from 'node:path'
import { diffTrees, hashTree, openConfig, withApp } from '../browser.mjs'

await withApp(process.argv[2], 'import-existing-setup', async ({ page, state, shot, log }) => {
  const source = join(state.SCRATCH, 'import-source')
  const templatesDir = join(state.DATA_DIR, 'harness-config-source')
  const sourceBefore = hashTree(source)
  const homeBefore = hashTree(state.SANDBOX_HOME)

  await openConfig(page)
  await page.getByRole('tab', { name: 'Templates' }).click()
  await page.getByRole('button', { name: 'Import existing setup…' }).click()
  await page.locator('#import-folder-skills').fill(join(source, 'skills'))
  await page.locator('#import-folder-commands').fill(join(source, 'commands'))
  await shot('folders')

  await page.getByRole('button', { name: 'Preview import' }).click()
  const importButton = page.getByRole('button', { name: 'Import', exact: true })
  await importButton.waitFor({ timeout: 10000 })
  log(`preview:\n${await page.locator('body').ariaSnapshot()}`)
  await shot('preview')
  if (await importButton.isDisabled()) throw new Error('Import is disabled after preview (blocking reasons shown)')

  await importButton.click()
  await page.getByText('Scopes that now differ from disk').waitFor({ timeout: 10000 })
  await shot('done')

  const written = Object.keys(hashTree(templatesDir))
  log(`template source folder: ${JSON.stringify(written)}`)
  for (const name of ['deploy-check', 'pr-summary']) {
    if (!written.some((p) => p.includes(name))) throw new Error(`${name} not written under ${templatesDir}`)
  }

  await page.getByRole('button', { name: 'Close import' }).click()
  for (const name of ['deploy-check', 'pr-summary']) {
    await page.getByRole('button', { name: new RegExp(name) }).first().waitFor({ timeout: 5000 })
  }
  await shot('templates-after')

  const sourceDiff = diffTrees(sourceBefore, hashTree(source))
  if (sourceDiff.length) throw new Error(`import changed its source folder: ${sourceDiff.join(', ')}`)
  const homeDiff = diffTrees(homeBefore, hashTree(state.SANDBOX_HOME))
  if (homeDiff.length) throw new Error(`import wrote into harness folders before any sync: ${homeDiff.join(', ')}`)
  log(`import source and sandbox HOME byte-identical; ${readdirSync(templatesDir).length} entries in template source`)
})
