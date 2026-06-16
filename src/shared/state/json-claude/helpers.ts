import type { JsonClaudeChatEntry, JsonClaudeMessageBlock, JsonClaudeSession, JsonClaudeState } from './types'

/** Returns a shallow copy of `state` with every session's `entries` array
 *  replaced by `[]`. Used by transports to elide chat history from the
 *  initial snapshot — the wire payload is otherwise unbounded in proportion
 *  to how many sessions × turns × deltas the user has accumulated. The
 *  renderer fetches entries per session on first mount via
 *  `jsonClaude:getEntries`, which dispatches `entriesSeeded` to fill them
 *  back in. */
export function stripJsonClaudeEntries(state: JsonClaudeState): JsonClaudeState {
  const sessions: Record<string, JsonClaudeSession> = {}
  for (const [id, session] of Object.entries(state.sessions)) {
    // Server-side sessions are always hydrated; renderer-side they may
    // not be. Either case where stripping would actually change the
    // session shape (non-empty entries OR a true hydrated flag) requires
    // a new object — otherwise return the existing reference so
    // downstream identity checks don't trip.
    const needsStrip = session.entries.length > 0 || session.entriesHydrated
    sessions[id] = needsStrip
      ? { ...session, entries: [], entriesHydrated: false }
      : session
  }
  return { ...state, sessions }
}

export function appendBlocksToEntry(
  entries: JsonClaudeChatEntry[],
  entry: JsonClaudeChatEntry
): JsonClaudeChatEntry[] {
  return [...entries, entry]
}

function findLastBlockIdx(
  blocks: JsonClaudeMessageBlock[],
  type: JsonClaudeMessageBlock['type']
): number {
  for (let i = blocks.length - 1; i >= 0; i--) {
    if (blocks[i].type === type) return i
  }
  return -1
}

// Targeted delta update. The naive .map(entry => ...) over session.entries
// allocates an O(N) array AND fires a JS callback per entry on every
// 30ms-coalesced delta — at hundreds of deltas per turn with extended
// thinking on, that pins CPU. Instead: locate the entry by index, slice +
// patch only that one. The .slice() is still O(N) but it's a flat memcpy
// of pointers, an order of magnitude cheaper than .map(callback).
export function applyBlockTextDelta(
  state: JsonClaudeState,
  sessionId: string,
  entryId: string,
  textDelta: string,
  blockType: 'text' | 'thinking'
): JsonClaudeState {
  if (textDelta === '') return state
  const session = state.sessions[sessionId]
  if (!session) return state
  const entryIdx = session.entries.findIndex((e) => e.entryId === entryId)
  if (entryIdx === -1) return state
  const entry = session.entries[entryIdx]
  const blocks = entry.blocks ?? []
  const lastIdx = findLastBlockIdx(blocks, blockType)
  // No matching block-of-this-type — happens when entries haven't been
  // lazy-loaded yet on a renderer. content_block_start dispatches
  // assistantBlockAppended which creates the placeholder; if that never
  // landed for this entry on this client, the delta is correctly dropped
  // and re-materialized via getEntries when the user opens the tab.
  if (lastIdx === -1) return state
  const nextBlocks = blocks.slice()
  const b = nextBlocks[lastIdx]
  nextBlocks[lastIdx] = { ...b, text: (b.text ?? '') + textDelta }
  const nextEntries = session.entries.slice()
  nextEntries[entryIdx] = { ...entry, blocks: nextBlocks }
  return {
    ...state,
    sessions: {
      ...state.sessions,
      [session.sessionId]: { ...session, entries: nextEntries }
    }
  }
}
