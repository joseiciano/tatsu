export interface PermissionRule {
  toolName: string
  ruleContent?: string
}

export interface PermissionPatternSuggestion {
  rule: PermissionRule
  label: string
  scope: 'narrow' | 'medium' | 'broad'
}
