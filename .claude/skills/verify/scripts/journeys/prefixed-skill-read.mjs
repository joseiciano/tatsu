#!/usr/bin/env node
// A Claude skill folder whose name starts with its root's name ("skills-used"
// under ~/.claude/skills) once made every readFile fail with "The harness
// resource path is unsafe", including for Opencode agents. Prove the skill is
// listed and opens, and that an Opencode agent still opens beside it.
//
// Usage: node .claude/skills/verify/scripts/journeys/prefixed-skill-read.mjs <state.env>
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { openConfig, withApp } from '../browser.mjs'

const SKILL_BODY = 'Report which skills fired.'
const AGENT_BODY = 'Plan the work before editing.'

async function openAndRead(page, shot, log, rowName, body, label) {
  await page.getByRole('button', { name: rowName }).first().click()
  const lines = page.locator('.monaco-editor .view-lines').first()
  await lines.waitFor()
  // Monaco renders spaces as U+00A0.
  const read = async () => (await lines.innerText()).replace(/\u00a0/g, ' ')
  for (let i = 0; i < 50 && !(await read()).includes(body); i++) await page.waitForTimeout(100)
  const text = await read()
  log(`${label} editor:\n${text}`)
  await shot(label)
  if (await page.getByText('The harness resource path is unsafe').count()) {
    throw new Error(`${label}: unsafe-path error shown`)
  }
  if (!text.includes(body)) throw new Error(`${label}: editor did not load the file`)
}

await withApp(process.argv[2], 'prefixed-skill-read', async ({ page, state, shot, log }) => {
  const skillDir = join(state.SANDBOX_HOME, '.claude/skills/skills-used')
  mkdirSync(skillDir, { recursive: true })
  writeFileSync(join(skillDir, 'SKILL.md'), `---\nname: skills-used\ndescription: List fired skills.\n---\n\n${SKILL_BODY}\n`)
  const agentsDir = join(state.SANDBOX_HOME, '.config/opencode/agents')
  mkdirSync(agentsDir, { recursive: true })
  writeFileSync(join(agentsDir, 'planner.md'), `---\ndescription: Plans work.\n---\n\n${AGENT_BODY}\n`)

  await openConfig(page)
  await page.getByRole('tab', { name: 'Skills' }).click()
  await openAndRead(page, shot, log, /^skills-used skills-used\/SKILL\.md/, SKILL_BODY, 'claude-skill')

  await page.getByRole('tab', { name: 'Agents' }).click()
  await page.locator('#config-agent-filter').selectOption({ label: 'Opencode' })
  await openAndRead(page, shot, log, /^planner planner\.md/, AGENT_BODY, 'opencode-agent')
})
