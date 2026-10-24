#!/usr/bin/env node
// Build a skill template from two fragments, reorder and remove them, sync it
// to Claude, then cover the outside-change prompt and both deletes.
//
// Usage: node .claude/skills/verify/scripts/journeys/template-fragments.mjs <state.env>
import { copyFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { hashTree, openConfig, waitForFile, withApp } from '../browser.mjs'

const FRAGMENTS = { alpha: 'Alpha fragment text.', beta: 'Beta fragment text.' }
const BODY = 'Template body text.'

async function typeIntoEditor(page, index, text) {
  await page.locator('.monaco-editor').nth(index).click()
  await page.keyboard.type(text)
}

async function waitGone(page, file) {
  for (let i = 0; i < 50 && existsSync(file); i++) await page.waitForTimeout(100)
  if (existsSync(file)) throw new Error(`${file} still exists`)
}

await withApp(process.argv[2], 'template-fragments', async ({ page, state, shot, log }) => {
  const src = join(state.DATA_DIR, 'harness-config-source')
  const templateFile = join(src, 'skills/fragged/TEMPLATE.md')
  const rendered = join(state.SANDBOX_HOME, '.claude/skills/fragged/SKILL.md')

  await openConfig(page)
  await page.getByRole('tab', { name: 'Templates' }).click()
  for (const [name, text] of Object.entries(FRAGMENTS)) {
    await page.getByRole('button', { name: 'Create fragment' }).click()
    await page.locator('#fragment-name').fill(name)
    await typeIntoEditor(page, 0, text)
    await page.getByRole('button', { name: 'Create', exact: true }).click()
    await page.waitForTimeout(500)
  }
  log(`after fragments: ${JSON.stringify(Object.keys(hashTree(src)))}`)

  await page.getByRole('button', { name: 'Create skill template' }).click()
  await page.locator('#template-name').fill('fragged')
  await page.locator('#template-description').fill('Uses fragments.')
  await typeIntoEditor(page, 0, BODY)
  const picker = page.getByLabel('Fragment to add')
  const addButton = page.locator('[data-testid="template-fragment-picker"]').getByRole('button', { name: 'Add' })
  for (const name of ['alpha', 'beta']) {
    await picker.selectOption(name)
    await addButton.click()
  }
  await page.getByRole('button', { name: 'Move beta up' }).click()
  for (const harness of ['claude', 'codex', 'opencode']) {
    const box = page.locator(`#template-harness-${harness}`)
    if ((await box.isChecked()) !== (harness === 'claude')) await box.setChecked(harness === 'claude')
  }
  const preview = page.locator('[data-testid="template-preview"]')
  await preview.getByText(FRAGMENTS.alpha).first().waitFor({ timeout: 5000 })
  const previewText = await preview.innerText()
  log(`preview:\n${previewText}`)
  await shot('reordered-preview')
  const order = [BODY, FRAGMENTS.beta, FRAGMENTS.alpha].map((t) => previewText.indexOf(t))
  if (order.some((i) => i < 0) || !(order[0] < order[1] && order[1] < order[2])) {
    throw new Error(`preview order is not body, beta, alpha: ${JSON.stringify(order)}`)
  }

  await page.getByRole('button', { name: 'Create', exact: true }).click()
  await waitForFile(page, templateFile)
  const stored = readFileSync(templateFile, 'utf8')
  log(`TEMPLATE.md:\n${stored}`)
  if (!/fragments:[\s\S]*beta[\s\S]*alpha/.test(stored)) throw new Error('TEMPLATE.md does not list fragments as beta, alpha')

  await page.getByRole('tab', { name: 'Skills' }).click()
  await page.getByRole('button', { name: 'Sync Claude Code' }).click()
  const dialog = page.getByRole('dialog')
  const sync = dialog.getByRole('button', { name: 'Sync Tatsu config to disk' })
  await sync.waitFor()
  for (let i = 0; i < 50 && (await sync.isDisabled()); i++) await page.waitForTimeout(100)
  await sync.click()
  await waitForFile(page, rendered, 10000)
  await dialog.waitFor({ state: 'detached', timeout: 10000 })
  copyFileSync(rendered, join(state.EVIDENCE, 'fragged.SKILL.md'))
  const out = readFileSync(rendered, 'utf8')
  log(`rendered:\n${out}`)
  const at = [BODY, FRAGMENTS.beta, FRAGMENTS.alpha].map((t) => out.indexOf(t))
  if (at.some((i) => i < 0) || !(at[0] < at[1] && at[1] < at[2])) throw new Error('rendered SKILL.md is not body, beta, alpha')

  await page.getByRole('button', { name: /^Edit template skill\/fragged/ }).first().click()
  await page.locator('#template-name').waitFor()
  await page.getByRole('button', { name: 'Remove alpha' }).click()
  writeFileSync(templateFile, stored.replace(BODY, 'Body changed outside Tatsu.'))
  await page.waitForTimeout(1000)
  await shot('outside-change')
  await page.getByRole('button', { name: 'Save', exact: true }).click()
  for (let i = 0; i < 50 && readFileSync(templateFile, 'utf8').includes('alpha'); i++) await page.waitForTimeout(100)
  const resaved = readFileSync(templateFile, 'utf8')
  log(`TEMPLATE.md after remove + save:\n${resaved}`)
  if (resaved.includes('alpha')) throw new Error('alpha is still listed after Remove alpha + Save')
  await shot('after-remove')

  await page.getByRole('button', { name: 'Delete template' }).click()
  await waitGone(page, templateFile)
  await page.getByRole('button', { name: /^alpha/ }).first().click()
  await page.getByRole('button', { name: 'Delete fragment' }).click()
  await waitGone(page, join(src, 'fragments/alpha.md'))
  await shot('after-deletes')
  log(`source folder after deletes: ${JSON.stringify(Object.keys(hashTree(src)))}`)
})
