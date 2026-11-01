// Shared steps for code diff journeys. Every handle here is user-visible: roles, accessible names, text, titles.
import { execFileSync } from 'node:child_process'

export const git = (cwd, ...args) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8' }).trim()

export const baseRef = (page) => page.getByRole('combobox', { name: 'Base ref' })
export const fileRow = (page, path) => page.getByTitle(path, { exact: true })
export const summary = (page) => page.getByText(/^\d+ files?$/)

export async function selectFixtureWorktree(page) {
  await page.getByText('feature/diff-demo').first().click()
  await page.getByRole('button', { name: 'Changed Files' }).waitFor()
}

export async function openViaDiffButton(page) {
  await selectFixtureWorktree(page)
  await page.getByRole('button', { name: 'Diff', exact: true }).click()
  await expectOpen(page)
}

export async function expectOpen(page) {
  await baseRef(page).waitFor({ timeout: 10000 })
  await summary(page).waitFor({ timeout: 10000 })
}

export async function expectClosed(page) {
  await baseRef(page).waitFor({ state: 'detached', timeout: 5000 })
  await page.getByRole('button', { name: 'Changed Files' }).waitFor({ timeout: 5000 })
}

export async function expectText(page, text, timeout = 10000) {
  await page.getByText(text).first().waitFor({ timeout })
}

export function assert(cond, msg) {
  if (!cond) throw new Error(`assertion failed: ${msg}`)
}
