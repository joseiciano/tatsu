export type PermissionLevel = 'read-only' | 'edit' | 'full'
export const PERMISSION_LEVELS: readonly PermissionLevel[] = ['read-only', 'edit', 'full']
export const RUN_FOLDER_GLOB = '.harness/runs/**'

export function isPermissionLevel(v: unknown): v is PermissionLevel {
  return typeof v === 'string' && (PERMISSION_LEVELS as readonly string[]).includes(v)
}

const UNSAFE_CHARS = /[,()'"`*\n\r]/

/** Returns the entries that are safe to pass to every harness, trimmed,
 *  de-duplicated, in input order. */
export function sanitizeBashAllow(list: readonly string[] | undefined): string[] {
  const out: string[] = []
  for (const raw of list ?? []) {
    const entry = raw.trim()
    if (!entry || entry.length > 200 || UNSAFE_CHARS.test(entry)) continue
    if (!out.includes(entry)) out.push(entry)
  }
  return out
}

export function normalizeAllowEntry(entry: string): string {
  return entry.endsWith(' *') ? entry.slice(0, -2) : entry
}
