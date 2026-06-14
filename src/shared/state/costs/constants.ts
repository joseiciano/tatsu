import type { ContentBreakdown, CostsState, ModelTally } from './types'

export const emptyBreakdown: ContentBreakdown = {
  text: 0,
  thinking: 0,
  toolUse: 0,
  userPrompt: 0,
  assistantEcho: 0,
  toolResults: {}
}

export const initialCosts: CostsState = {
  byTerminal: {}
}

export const emptyTally: ModelTally = {
  messages: 0,
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  cost: 0
}
