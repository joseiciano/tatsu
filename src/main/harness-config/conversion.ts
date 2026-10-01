// Deterministic skill/command content generators (Step 10,
// plans/skills-agents-command-center/step-10-skill-command-conversion.md).
//
// Pure by construction: no filesystem access, clock, randomness, or
// UUID generation (REQ-001/REQ-006). Regenerating a draft from the
// same `HarnessConfigConversionSource` always produces byte-identical
// output, so re-deriving a draft never manufactures synthetic drift.
//
// This module is package-internal: external code imports the two
// generators through the `src/main/harness-config` barrel (TASK-005);
// `slugifyLogicalName`, `extractFrontMatterDescription`, and
// `conversionDestinationName` are exported here only for same-package
// use and unit testing (GUD-001) and are intentionally left out of the
// barrel.

import type { HarnessConfigConversionDraft, HarnessConfigConversionSource } from './types'
import { HarnessConfigError } from './types'

const FRONTMATTER_DESCRIPTION_PATTERN = /^description:\s*(.*)$/
const MAX_FRONTMATTER_SCAN_LINES = 50
const MAX_SLUG_LENGTH = 64

/** Lowercases, keeps ASCII `[a-z0-9]`, collapses every other character
 *  run into a single `-`, trims leading/trailing `-`, and truncates to
 *  64 characters (Claude's skill-name limit) with any resulting
 *  trailing `-` trimmed (REQ-003). An
 *  empty result throws `HarnessConfigError` (`invalid-name`). */
export function slugifyLogicalName(value: string): string {
  const lowered = (value ?? '').toLowerCase()
  const collapsed = lowered.replace(/[^a-z0-9]+/g, '-')
  const trimmed = collapsed.replace(/^-+/, '').replace(/-+$/, '')
  const truncated = trimmed.slice(0, MAX_SLUG_LENGTH).replace(/-+$/, '')
  if (truncated.length === 0) {
    throw new HarnessConfigError('invalid-name', 'Unable to derive a conversion destination name')
  }
  return truncated
}

/** Scans only a leading `---` front-matter block, at most its first 50
 *  lines, and returns the trimmed value of the first line matching
 *  `^description:\s*(.*)$`. Returns `null` when there is no leading
 *  block, no closing delimiter within the scan window, or no
 *  `description` line (REQ-004). */
export function extractFrontMatterDescription(content: string): string | null {
  const lines = content.split('\n')
  if (lines.length === 0 || lines[0].trim() !== '---') return null
  const scanLimit = Math.min(lines.length, MAX_FRONTMATTER_SCAN_LINES)
  let description: string | null = null
  let closed = false
  for (let i = 1; i < scanLimit; i += 1) {
    const line = lines[i].replace(/\r$/, '')
    if (line.trim() === '---') {
      closed = true
      break
    }
    if (description === null) {
      const match = FRONTMATTER_DESCRIPTION_PATTERN.exec(line)
      if (match) description = match[1].trim()
    }
  }
  if (!closed) return null
  if (description !== null && /^[|>][+-]?\d*$/.test(description)) return null
  return description
}

/** Deterministic destination naming (REQ-003): slugify the
 *  path-qualified logical name (`frontend/review` -> `frontend-review`)
 *  so nested sources with the same basename stay distinct, falling back
 *  to the display label only when the name slugifies to nothing. Throws
 *  `invalid-name` only when both are empty. */
export function conversionDestinationName(source: Pick<HarnessConfigConversionSource, 'name' | 'label'>): string {
  try {
    return slugifyLogicalName(source.name)
  } catch {
    return slugifyLogicalName(source.label)
  }
}

function sourceMetadataComment(source: HarnessConfigConversionSource): string {
  return `<!-- Converted by Tatsu from ${source.agentKind} ${source.resourceType} ${source.relativePath} -->`
}

/** Generates a Claude/Codex/OpenCode command from a skill (REQ-004).
 *  Content embeds no source file body — only the extracted
 *  `description` (or a deterministic fallback) and a trailing
 *  source-metadata comment (REQ-007). */
export function createCommandFromSkill(skill: HarnessConfigConversionSource): HarnessConfigConversionDraft {
  if (skill.resourceType !== 'skills') {
    throw new HarnessConfigError('unknown-resource', 'createCommandFromSkill requires a skills source')
  }
  const destinationName = conversionDestinationName(skill)
  const extracted = extractFrontMatterDescription(skill.content)
  const description = extracted && extracted.length > 0 ? extracted : `Run the ${destinationName} skill`
  const content =
    `---\n` +
    `description: ${description}\n` +
    `---\n` +
    `\n` +
    `Use the ${skill.label} skill.\n` +
    `\n` +
    `${sourceMetadataComment(skill)}\n`
  return { destinationResourceType: 'commands', destinationName, content }
}

/** Generates a Claude/Codex/OpenCode skill from a command (REQ-005). */
export function createSkillFromCommand(command: HarnessConfigConversionSource): HarnessConfigConversionDraft {
  if (command.resourceType !== 'commands') {
    throw new HarnessConfigError('unknown-resource', 'createSkillFromCommand requires a commands source')
  }
  const destinationName = conversionDestinationName(command)
  const content =
    `# ${destinationName}\n` +
    `\n` +
    `Use this skill when the user requests the \`${command.label}\` command behavior.\n` +
    `\n` +
    `${sourceMetadataComment(command)}\n`
  return { destinationResourceType: 'skills', destinationName, content }
}
