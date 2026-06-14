// Per-terminal token usage + estimated cost, sourced from Claude Code
// session jsonl transcripts. Written to only by the main-side
// CostTracker (renderer never mutates this slice), so there's no IPC
// mutation handler for it — data flows jsonl -> main -> renderer.

export interface ModelTally {
  messages: number
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
  cost: number
}

/** Estimated dollar attribution of a session's total cost across the
 *  content categories that drove it. All fields are dollars and sum to
 *  (roughly) the session total. The split is computed by char-length
 *  proportion within each turn — exact per-block token counts aren't
 *  in the Anthropic usage field, so this is an estimate. Good enough
 *  for a "where are my tokens going" bar chart; not an accounting
 *  receipt.
 *
 *  Output side (what Claude produced this turn):
 *    text         — assistant text replies to the user
 *    thinking     — extended-thinking blocks
 *    toolUse      — the JSON args passed to tool calls
 *
 *  Input side (what was fed back in as context on this turn). A single
 *  tool_result or user prompt contributes to every subsequent turn's
 *  input cost — a big Read output early in a long session is "doubly
 *  expensive" because it gets re-paid on every cached turn after. The
 *  input-side attribution captures that amortized cost naturally.
 *    userPrompt     — things the user typed
 *    assistantEcho  — prior assistant messages replayed in context
 *    toolResults    — stdout of tool calls, keyed by tool name
 */
export interface ContentBreakdown {
  text: number
  thinking: number
  toolUse: number
  userPrompt: number
  assistantEcho: number
  toolResults: Record<string, number>
}

export interface SessionUsage {
  sessionId: string
  transcriptPath: string
  /** Per-model accumulator. A single session can span multiple models
   *  if the user runs `/model` mid-session. */
  byModel: Record<string, ModelTally>
  /** Dollar attribution across content categories (see ContentBreakdown). */
  breakdown: ContentBreakdown
  /** Most recently seen assistant-message model — drives the "right now"
   *  badge in the UI. */
  currentModel: string | null
  updatedAt: number
}

export interface CostsState {
  /** Keyed by terminal id. Entries persist across terminal death so
   *  worktree-level totals survive restarts. */
  byTerminal: Record<string, SessionUsage>
}

export type CostsEvent =
  | { type: 'costs/usageUpdated'; payload: { terminalId: string; usage: SessionUsage } }
  | { type: 'costs/terminalCleared'; payload: { terminalId: string } }
  | { type: 'costs/hydrated'; payload: CostsState }
