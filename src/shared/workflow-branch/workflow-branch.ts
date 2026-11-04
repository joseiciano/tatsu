const DEFINITION_SLUG_MAX_CHARS = 40
const ITEM_SLUG_MAX_CHARS = 40
const SHORT_RUN_ID = /^[0-9a-f]{8}$/

function branchSlug(text: string, maxChars: number): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, maxChars)
    .replace(/-+$/, '')
}

function definitionSlug(definitionName: string): string {
  return branchSlug(definitionName, DEFINITION_SLUG_MAX_CHARS) || 'workflow'
}

export function workflowBranchName(definitionName: string, suffix: string): string {
  return `wf/${definitionSlug(definitionName)}/${suffix}`
}

export function chainItemBranchName(definitionName: string, itemTitle: string, shortRunId: string): string {
  if (!SHORT_RUN_ID.test(shortRunId)) throw new Error('shortRunId must be 8 lowercase hex characters')
  const itemSlug = branchSlug(itemTitle, ITEM_SLUG_MAX_CHARS) || 'item'
  return `wf/${definitionSlug(definitionName)}/${itemSlug}-${shortRunId}`
}
