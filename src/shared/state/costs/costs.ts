import type { ContentBreakdown, CostsEvent, CostsState, ModelTally, SessionUsage } from './types'
import { emptyTally } from './constants'

export function costsReducer(state: CostsState, event: CostsEvent): CostsState {
  switch (event.type) {
    case 'costs/usageUpdated':
      return {
        ...state,
        byTerminal: {
          ...state.byTerminal,
          [event.payload.terminalId]: event.payload.usage
        }
      }
    case 'costs/terminalCleared': {
      if (!(event.payload.terminalId in state.byTerminal)) return state
      const next = { ...state.byTerminal }
      delete next[event.payload.terminalId]
      return { ...state, byTerminal: next }
    }
    case 'costs/hydrated':
      return event.payload
    default: {
      const _exhaustive: never = event
      void _exhaustive
      return state
    }
  }
}

/** Sum two breakdowns into `target` in place. No-ops if `src` is missing —
 * persisted SessionUsage records from before ContentBreakdown was added lack
 * the field, and we don't want CostPanel to crash on old state. */
export function addBreakdown(target: ContentBreakdown, src: ContentBreakdown | undefined): void {
  if (!src) return
  target.text += src.text
  target.thinking += src.thinking
  target.toolUse += src.toolUse
  target.userPrompt += src.userPrompt
  target.assistantEcho += src.assistantEcho
  for (const [k, v] of Object.entries(src.toolResults)) {
    target.toolResults[k] = (target.toolResults[k] ?? 0) + v
  }
}

export function cloneBreakdown(b: ContentBreakdown): ContentBreakdown {
  return {
    text: b.text,
    thinking: b.thinking,
    toolUse: b.toolUse,
    userPrompt: b.userPrompt,
    assistantEcho: b.assistantEcho,
    toolResults: { ...b.toolResults }
  }
}

/** Sum one session's per-model tallies into a single ModelTally-shaped
 *  total. Convenience for UI aggregation. */
export function totalForSession(usage: SessionUsage): ModelTally {
  const total: ModelTally = { ...emptyTally }
  for (const t of Object.values(usage.byModel)) {
    total.messages += t.messages
    total.input += t.input
    total.output += t.output
    total.cacheRead += t.cacheRead
    total.cacheWrite += t.cacheWrite
    total.cost += t.cost
  }
  return total
}
