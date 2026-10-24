// Feature: open-close. Every entry point opens the tool; Escape and Review close it.
import { openViaDiffButton, selectFixtureWorktree, expectOpen, expectClosed, baseRef, summary } from './lib.mjs'

export default async ({ page, shot, log }) => {
  await selectFixtureWorktree(page)
  await shot('workspace-before')

  await openViaDiffButton(page)
  log('open-diff-button: opened from Changed Files "Diff" button')
  await shot('open-diff-button')

  await baseRef(page).focus()
  await page.keyboard.press('Escape')
  await baseRef(page).waitFor({ timeout: 2000 })
  log('close-escape: Escape inside the Base ref box keeps the tool open')
  await summary(page).click()
  await page.keyboard.press('Escape')
  await expectClosed(page)
  log('close-escape: Escape outside inputs returns to the workspace')
  await shot('closed-escape')

  await page.keyboard.press('Meta+Shift+C')
  await expectOpen(page)
  log('open-hotkey: Meta+Shift+C opened the tool')
  await shot('open-hotkey')
  await page.keyboard.press('Meta+Shift+C')
  await expectClosed(page)
  log('open-hotkey: Meta+Shift+C again closed the tool')

  await page.keyboard.press('Meta+K')
  const search = page.getByPlaceholder('Search worktrees and commands...')
  await search.fill('Code diff')
  await shot('palette')
  await page.keyboard.press('Enter')
  await expectOpen(page)
  log('open-palette: "Code diff" palette command opened the tool')
  await shot('open-palette')

  await page.keyboard.press('Meta+Alt+R')
  await baseRef(page).waitFor({ state: 'detached', timeout: 5000 })
  await page.getByText(/^\d+\/\d+ reviewed$/).waitFor({ timeout: 5000 })
  log('slot-shared: opening Review closed the code diff tool and shows the Review screen')
  await shot('review-replaced')
}
