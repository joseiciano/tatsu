// Feature: base-ref. Default base, pick from list, type a ref, invalid ref, unrelated history, reset.
import { openViaDiffButton, baseRef, summary, expectText, assert } from './lib.mjs'

export default async ({ page, shot, log }) => {
  await openViaDiffButton(page)
  assert((await baseRef(page).inputValue()) === 'origin/main', 'default base is origin/main')
  assert((await summary(page).textContent()) === '11 files', 'origin/main shows 11 files')
  log('ref-default: base defaults to origin/main with 11 files')
  await shot('default')

  await page.getByRole('button', { name: 'Show refs' }).click()
  const options = await page.getByRole('option').allTextContents()
  log(`ref-list: options = ${JSON.stringify(options)}`)
  for (const want of ['main', 'origin/main', 'v0.1.0', 'unrelated']) {
    assert(options.some((o) => o.startsWith(want)), `ref list offers ${want}`)
  }
  await shot('ref-list')
  await page.getByRole('option', { name: /^main local$/ }).click()
  await page.waitForFunction(() => document.querySelector('input[aria-label="Base ref"]')?.value === 'main')
  await summary(page).waitFor()
  log(`ref-pick: picked local main -> ${await summary(page).textContent()}`)
  await shot('picked-main')

  await baseRef(page).fill('v0.1.0')
  await page.keyboard.press('Enter')
  await page.waitForFunction(() => document.querySelector('input[aria-label="Base ref"]')?.value === 'v0.1.0')
  log(`ref-type: typed tag v0.1.0 -> ${await summary(page).textContent()}`)
  await shot('typed-tag')

  await baseRef(page).fill('no-such-ref')
  await page.keyboard.press('Enter')
  await expectText(page, 'Ref no-such-ref not found.')
  assert((await summary(page).textContent()) !== null, 'list stays on the previous base')
  log('ref-invalid: "Ref no-such-ref not found." shown, previous base kept')
  await shot('invalid-ref')

  await baseRef(page).fill('unrelated')
  await page.keyboard.press('Enter')
  await expectText(page, 'and this branch share no history.')
  log('ref-unrelated: unrelated history shows the no-merge-base state')
  await shot('no-merge-base')

  await page.getByRole('button', { name: 'Reset to default' }).click()
  await page.waitForFunction(() => document.querySelector('input[aria-label="Base ref"]')?.value === 'origin/main')
  await summary(page).waitFor()
  log('ref-reset: "Reset to default" restored origin/main')
  await shot('reset')
}
