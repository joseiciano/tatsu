import { isAbsolute, resolve } from 'path'

import {
  HARNESS_CONFIG_ROOT_KEYS,
  type HarnessConfigRoots
} from '../../shared/state/harness-config'

export function normalizeConfigFolder(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  if (trimmed === '' || trimmed.includes('\0') || !isAbsolute(trimmed)) return null
  return resolve(trimmed)
}

export function sanitizeHarnessConfigRoots(raw: unknown): HarnessConfigRoots {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {}
  const source = raw as Record<string, unknown>
  const roots: HarnessConfigRoots = {}
  for (const key of HARNESS_CONFIG_ROOT_KEYS) {
    if (!Object.prototype.hasOwnProperty.call(source, key)) continue
    const folder = normalizeConfigFolder(source[key])
    if (folder) roots[key] = folder
  }
  return roots
}
