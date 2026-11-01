// Feature: fetch. The Fetch button updates refs/remotes/origin/main from origin without changing the merge-base list.
import { openViaDiffButton, summary, git, assert } from './lib.mjs'

export default async ({ page, shot, log, fixture }) => {
  await openViaDiffButton(page)
  const before = git(fixture.repo, 'rev-parse', 'refs/remotes/origin/main')
  const upstream = git(`${fixture.repo}/../origin.git`, 'rev-parse', 'refs/heads/main')
  assert(before !== upstream, 'fixture starts behind origin')
  log(`fetch-before: origin/main ${before}, origin has ${upstream}`)
  await shot('before-fetch')

  await page.getByRole('button', { name: 'Fetch', exact: true }).click()
  for (let i = 0; i < 50 && git(fixture.repo, 'rev-parse', 'refs/remotes/origin/main') !== upstream; i++) {
    await page.waitForTimeout(200)
  }
  const after = git(fixture.repo, 'rev-parse', 'refs/remotes/origin/main')
  assert(after === upstream, `origin/main moved to ${upstream} (got ${after})`)
  assert((await page.getByText(/^Fetch failed/).count()) === 0, 'no Fetch failed warning')
  await summary(page).waitFor()
  log(`fetch-ok: origin/main ${before} -> ${after}; no "Fetch failed"; list shows ${await summary(page).textContent()}`)
  await shot('after-fetch')
}
