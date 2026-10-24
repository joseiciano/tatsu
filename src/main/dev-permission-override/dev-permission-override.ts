import { isPermissionLevel, type PermissionLevel } from '../../shared/permission-level'

export function devPermissionOverride(
  isDev: boolean,
  env: NodeJS.ProcessEnv
): { permissionLevel?: PermissionLevel; bashAllow?: string[] } {
  if (!isDev) return {}
  const level = env.HARNESS_DEV_PERMISSION_LEVEL
  if (!isPermissionLevel(level)) return {}
  const allow = (env.HARNESS_DEV_BASH_ALLOW ?? '')
    .split(';')
    .map((s) => s.trim())
    .filter(Boolean)
  return { permissionLevel: level, bashAllow: allow }
}
