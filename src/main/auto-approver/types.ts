export type AutoApproveDecision =
  | { kind: 'approve'; model: string; reason: string }
  | { kind: 'ask'; reason: string }