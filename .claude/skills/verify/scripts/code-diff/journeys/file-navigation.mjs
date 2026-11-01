// Feature: file-navigation. Grouping, selecting files, keyboard stepping, diff pane content.
import { openViaDiffButton, fileRow, expectText, assert } from './lib.mjs'

const groupHeader = (page, label) => page.getByText(label, { exact: true })

export default async ({ page, shot, log }) => {
  await openViaDiffButton(page)
  for (const label of ['Tests', 'Config', 'API / routing', 'UI / views', 'Other']) {
    await groupHeader(page, label).first().waitFor({ timeout: 5000 })
  }
  log('group-type: By type shows Tests, Config, API / routing, UI / views, Other')
  await shot('by-type')

  await page.getByRole('button', { name: 'By folder' }).click()
  await page.getByText(/^src\/components\/?$/).first().waitFor({ timeout: 5000 })
  assert(await page.getByRole('button', { name: 'By folder' }).getAttribute('aria-pressed') === 'true', 'By folder pressed')
  log('group-folder: By folder groups by directory')
  await shot('by-folder')
  await page.getByRole('button', { name: 'By type' }).click()

  await fileRow(page, 'modify-me.txt').click()
  await page.locator('.monaco-diff-editor').waitFor({ timeout: 10000 })
  await expectText(page, 'second line')
  log('file-select: modify-me.txt shows a side-by-side Monaco diff with the new line')
  await shot('modified-file')

  await fileRow(page, 'blob.bin').click()
  await expectText(page, 'Binary file — cannot display diff')
  log('file-binary: blob.bin shows the binary placeholder')

  await fileRow(page, 'rename-me.txt → renamed.txt').click()
  await expectText(page, 'rename-me.txt → renamed.txt')
  log('file-rename: renamed.txt header shows rename-me.txt → renamed.txt')
  await shot('renamed-file')

  await fileRow(page, 'untracked.txt').click()
  await expectText(page, 'scratch')
  log('file-untracked: untracked.txt is listed and its content is shown')

  await fileRow(page, 'delete-me.txt').click()
  await expectText(page, 'going away')
  log('file-deleted: delete-me.txt shows the removed content on the base side')

  const header = page.locator('span.truncate.font-mono.text-fg')
  const expectHeader = (path) =>
    page.waitForFunction((p) => document.querySelector('span.truncate.font-mono.text-fg')?.textContent === p, path, { timeout: 5000 })
  await fileRow(page, 'tests/added.test.ts').click()
  await expectHeader('tests/added.test.ts')
  await page.getByText(/^\d+ files?$/).click()
  await page.keyboard.press('j')
  await expectHeader('config.json')
  await page.keyboard.press('k')
  await expectHeader('tests/added.test.ts')
  await page.keyboard.press(']')
  await page.keyboard.press(']')
  await expectHeader('src/api/routes.ts')
  await page.keyboard.press('[')
  await expectHeader('config.json')
  log(`keyboard-nav: j tests/added.test.ts -> config.json, k back, ] ] -> src/api/routes.ts, [ -> config.json (now ${await header.textContent()})`)
  await shot('keyboard-nav')
}
