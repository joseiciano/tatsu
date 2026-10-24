#!/usr/bin/env node
// Create a skill template "greet" for Claude Code on the Templates tab, then
// sync it to disk from the Skills tab and prove the rendered SKILL.md landed
// with the body and a provenance marker, and the row links back to the template.
//
// Usage: node .claude/skills/verify/scripts/journeys/template-render-sync.mjs <state.env>
import { copyFileSync, existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { hashTree, openConfig, waitForFile, withApp } from '../browser.mjs'

const BODY = 'Say hello to the user by name.'

await withApp(process.argv[2], 'template-render-sync', async ({ page, state, shot, log }) => {
  const rendered = join(state.SANDBOX_HOME, '.claude/skills/greet/SKILL.md')
  const templatesDir = join(state.DATA_DIR, 'harness-config-source')
  if (existsSync(rendered)) throw new Error(`precondition: ${rendered} already exists`)

  await openConfig(page)
  await page.getByRole('tab', { name: 'Templates' }).click()
  await page.getByRole('button', { name: 'Create skill template' }).click()
  await page.locator('#template-name').fill('greet')
  await page.locator('#template-description').fill('Greet the user.')
  await page.locator('[data-testid="template-preview"]').waitFor()
  const body = page.locator('.monaco-editor').first()
  await body.click()
  await page.keyboard.type(BODY)

  for (const harness of ['claude', 'codex', 'opencode']) {
    const box = page.locator(`#template-harness-${harness}`)
    const want = harness === 'claude'
    if ((await box.isChecked()) !== want) await box.setChecked(want)
  }
  await page.locator('[data-testid="template-preview"]').getByText(BODY).first().waitFor({ timeout: 5000 })
  await shot('draft-preview')

  await page.getByRole('button', { name: 'Create', exact: true }).click()
  for (let i = 0; i < 50 && !Object.keys(hashTree(templatesDir)).some((p) => p.includes('greet')); i++) {
    await page.waitForTimeout(100)
  }
  const stored = Object.keys(hashTree(templatesDir))
  log(`template source folder: ${JSON.stringify(stored)}`)
  if (!stored.some((p) => p.includes('greet'))) throw new Error(`greet template not written under ${templatesDir}`)
  await shot('template-saved')

  await page.getByRole('tab', { name: 'Skills' }).click()
  await page.getByRole('button', { name: 'Sync Claude Code' }).click()
  const dialog = page.getByRole('dialog')
  await dialog.waitFor()
  const sync = dialog.getByRole('button', { name: 'Sync Tatsu config to disk' })
  for (let i = 0; i < 50 && (await sync.isDisabled()); i++) await page.waitForTimeout(100)
  log(`plan:\n${await dialog.ariaSnapshot()}`)
  await shot('sync-plan')
  await sync.click()

  await waitForFile(page, rendered, 10000)
  copyFileSync(rendered, join(state.EVIDENCE, 'greet.SKILL.md'))
  const text = readFileSync(rendered, 'utf8')
  log(`rendered ${rendered}:\n${text}`)
  if (!text.includes(BODY)) throw new Error('rendered SKILL.md is missing the template body')
  if (!/tatsu/i.test(text)) throw new Error('rendered SKILL.md has no Tatsu provenance marker')
  if (!text.includes('Greet the user.')) throw new Error('rendered SKILL.md is missing the description')

  await dialog.waitFor({ state: 'detached', timeout: 10000 }).catch(async () => {
    await shot('after-sync-dialog')
    await dialog.getByRole('button', { name: /^(Close|Cancel)$/ }).first().click()
  })
  const edit = page.getByRole('button', { name: /^Edit template .*greet/ }).first()
  await edit.waitFor({ timeout: 5000 })
  await shot('skills-after')
  log(`row link: ${await edit.getAttribute('aria-label')}`)
})
