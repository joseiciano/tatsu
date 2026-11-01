// Feature: live-refresh. Edits in the worktree appear in the open tool without a manual refresh.
import { writeFileSync, rmSync } from 'node:fs'
import { openViaDiffButton, summary, fileRow, expectText } from './lib.mjs'

export default async ({ page, shot, log, fixture }) => {
  await openViaDiffButton(page)
  const before = await summary(page).textContent()
  await fileRow(page, 'keep.txt').click()
  await expectText(page, 'line two CHANGED')
  await shot('before-edit')

  writeFileSync(`${fixture.worktree}/keep.txt`, 'line one\nline two EDITED LIVE\nline three\n')
  writeFileSync(`${fixture.worktree}/fresh-file.txt`, 'appeared while open\n')
  await fileRow(page, 'fresh-file.txt').waitFor({ timeout: 15000 })
  await expectText(page, 'line two EDITED LIVE', 15000)
  log(`live-list: ${before} -> ${await summary(page).textContent()}, fresh-file.txt listed`)
  log('live-sides: selected keep.txt diff reloaded with "EDITED LIVE"')
  await shot('after-edit')

  writeFileSync(`${fixture.worktree}/keep.txt`, 'line one\nline two CHANGED\nline three\n')
  rmSync(`${fixture.worktree}/fresh-file.txt`)
  await fileRow(page, 'fresh-file.txt').waitFor({ state: 'detached', timeout: 15000 })
  log('live-restore: fixture restored; fresh-file.txt left the list')
}
