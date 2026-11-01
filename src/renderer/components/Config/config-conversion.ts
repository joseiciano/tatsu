// Pure, render-ready projection of a `HarnessConfigConversionResult`
// (Step 10 TASK-011). No backend calls, no store reads — everything it
// needs is passed in, so it's unit-testable without React.

import type { HarnessConfigConversionResult, HarnessConfigResourceType, ManagedHarnessKind } from '../../../shared/state/harness-config'
import type { ConfigConversionOutcome, ConfigConversionSourceInfo } from './types'

// Matches the trailing source-metadata comment every generated draft
// ends with (Step 10 REQ-007): `<!-- Converted by Tatsu from <agentKind>
// <resourceType> <relativePath> -->`. Display-only — never parsed back
// to drive conversion behavior (RISK-005).
const SOURCE_COMMENT_PATTERN = /<!--\s*Converted by Tatsu from (\S+) (\S+) (.+?)\s*-->\s*$/

function parseConversionSource(content: string, fallback: ConfigConversionSourceInfo): ConfigConversionSourceInfo {
  const match = SOURCE_COMMENT_PATTERN.exec(content.trimEnd())
  if (!match) return fallback
  return {
    agentKind: match[1] as ManagedHarnessKind,
    sourceResourceType: match[2] as HarnessConfigResourceType,
    relativePath: match[3]
  }
}

/** `destinationNoun` names the logical view the caller requested
 *  conversion *into* ('command' from a Skills-tab row, 'skill' from a
 *  Commands-tab row) — the `alias`/`existing` ref alone doesn't carry
 *  that distinction (an alias ref keeps the *source* scope's
 *  `resourceType`), so the caller supplies it explicitly. */
export function deriveConfigConversionOutcome(
  result: HarnessConfigConversionResult,
  destinationNoun: 'command' | 'skill'
): ConfigConversionOutcome {
  if (result.status === 'alias' || result.status === 'existing') {
    return {
      kind: 'already-available',
      message: `Already available as a ${destinationNoun} at ${result.ref.relativePath}`,
      relativePath: result.ref.relativePath
    }
  }
  const fallbackSourceType: HarnessConfigResourceType = result.resourceType === 'commands' ? 'skills' : 'commands'
  return {
    kind: 'draft',
    scope: { agentKind: result.agentKind, resourceType: result.resourceType },
    name: result.name,
    content: result.content,
    source: parseConversionSource(result.content, {
      agentKind: result.agentKind,
      sourceResourceType: fallbackSourceType,
      relativePath: ''
    })
  }
}
