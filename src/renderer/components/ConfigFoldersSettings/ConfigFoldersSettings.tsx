import { useCallback, useEffect, useMemo, useState } from 'react'
import { AlertTriangle, FolderOpen, RotateCcw } from 'lucide-react'
import { useBackend } from '../../backend'
import { useActiveBackend, useSettings } from '../../store'
import { RemoteFilePicker } from '../RemoteFilePicker'
import type {
  HarnessConfigFolderDefaults,
  HarnessConfigFolderSettingResult,
  HarnessConfigRootKey
} from '../../../shared/state/harness-config'

type RowId = HarnessConfigRootKey | 'sourceDir'

interface FolderRow {
  id: HarnessConfigRootKey
  label: string
}

interface FolderGroup {
  harness: string
  rows: FolderRow[]
}

export const CONFIG_FOLDER_GROUPS: readonly FolderGroup[] = [
  {
    harness: 'Claude',
    rows: [
      { id: 'claudeAgents', label: 'Agents' },
      { id: 'claudeSkills', label: 'Skills' },
      { id: 'claudeCommands', label: 'Commands' }
    ]
  },
  {
    harness: 'Codex',
    rows: [
      { id: 'codexHome', label: 'Home (AGENTS.md)' },
      { id: 'codexSkills', label: 'Skills' }
    ]
  },
  {
    harness: 'Opencode',
    rows: [
      { id: 'opencodeAgents', label: 'Agents' },
      { id: 'opencodeSkills', label: 'Skills' },
      { id: 'opencodeCommands', label: 'Commands' }
    ]
  }
]

function rowLabel(id: HarnessConfigRootKey): string {
  for (const group of CONFIG_FOLDER_GROUPS) {
    const row = group.rows.find((r) => r.id === id)
    if (row) return `${group.harness} ${row.label.toLowerCase()}`
  }
  return id
}

function normalizeForCompare(path: string): string {
  return path.length > 1 ? path.replace(/\/+$/, '') : path
}

/** Groups of root keys whose effective folders are the same path. A
 *  key with no override and no known default is skipped. */
export function findDuplicateRoots(
  effective: Partial<Record<HarnessConfigRootKey, string>>
): HarnessConfigRootKey[][] {
  const byPath = new Map<string, HarnessConfigRootKey[]>()
  for (const [key, path] of Object.entries(effective) as Array<[HarnessConfigRootKey, string | undefined]>) {
    if (!path) continue
    const normalized = normalizeForCompare(path)
    const keys = byPath.get(normalized) ?? []
    keys.push(key)
    byPath.set(normalized, keys)
  }
  return [...byPath.values()].filter((keys) => keys.length > 1)
}

export function ConfigFoldersSettings(): JSX.Element {
  const backend = useBackend()
  const activeBackend = useActiveBackend()
  const settings = useSettings()
  const roots = settings.harnessConfigRoots
  const sourceDir = settings.harnessConfigSourceDir

  const [defaults, setDefaults] = useState<HarnessConfigFolderDefaults | null>(null)
  const [drafts, setDrafts] = useState<Partial<Record<RowId, string>>>({})
  const [errors, setErrors] = useState<Partial<Record<RowId, string>>>({})
  const [remotePickerRow, setRemotePickerRow] = useState<RowId | null>(null)

  useEffect(() => {
    let cancelled = false
    setDefaults(null)
    backend
      .getHarnessConfigFolderDefaults()
      .then((value) => {
        if (!cancelled) setDefaults(value)
      })
      .catch(() => {
        if (!cancelled) setDefaults(null)
      })
    return () => {
      cancelled = true
    }
  }, [backend, activeBackend.id])

  const savedValue = useCallback(
    (id: RowId): string => (id === 'sourceDir' ? sourceDir ?? '' : roots[id] ?? ''),
    [roots, sourceDir]
  )

  const save = useCallback(
    async (id: RowId, value: string | null) => {
      const path = value === null || value.trim() === '' ? null : value.trim()
      let result: HarnessConfigFolderSettingResult
      try {
        result =
          id === 'sourceDir'
            ? await backend.setHarnessConfigSourceDir(path)
            : await backend.setHarnessConfigRoot({ key: id, path })
      } catch (err) {
        result = { ok: false, message: err instanceof Error && err.message ? err.message : 'Saving the folder failed' }
      }
      if (result.ok) {
        setDrafts((prev) => {
          const next = { ...prev }
          delete next[id]
          return next
        })
        setErrors((prev) => {
          const next = { ...prev }
          delete next[id]
          return next
        })
      } else {
        setErrors((prev) => ({ ...prev, [id]: result.ok ? undefined : result.message }))
      }
    },
    [backend]
  )

  const commitDraft = useCallback(
    (id: RowId) => {
      const draft = drafts[id]
      if (draft === undefined) return
      if (draft.trim() === savedValue(id)) {
        setDrafts((prev) => {
          const next = { ...prev }
          delete next[id]
          return next
        })
        return
      }
      void save(id, draft)
    },
    [drafts, save, savedValue]
  )

  const defaultFor = useCallback(
    (id: RowId): string => (id === 'sourceDir' ? defaults?.sourceDir ?? '' : defaults?.roots[id] ?? ''),
    [defaults]
  )

  const choose = useCallback(
    async (id: RowId) => {
      if (activeBackend.kind === 'remote') {
        setRemotePickerRow(id)
        return
      }
      try {
        const picked = await backend.pickDirectory({
          defaultPath: savedValue(id) || defaultFor(id) || undefined,
          title: 'Choose folder'
        })
        if (picked) await save(id, picked)
      } catch {
        setErrors((prev) => ({ ...prev, [id]: 'The folder picker is unavailable here; type the path instead' }))
      }
    },
    [activeBackend.kind, backend, defaultFor, save, savedValue]
  )

  const duplicates = useMemo(() => {
    const effective: Partial<Record<HarnessConfigRootKey, string>> = {}
    for (const group of CONFIG_FOLDER_GROUPS) {
      for (const row of group.rows) {
        effective[row.id] = roots[row.id] ?? defaults?.roots[row.id]
      }
    }
    return findDuplicateRoots(effective)
  }, [roots, defaults])

  function renderRow(id: RowId, label: string): JSX.Element {
    const saved = savedValue(id)
    const value = drafts[id] ?? saved
    const error = errors[id]
    const inputId = `config-folder-${id}`
    return (
      <div key={id} className="mb-3">
        <label htmlFor={inputId} className="block text-xs text-muted mb-1">
          {label}
        </label>
        <div className="flex items-center gap-2">
          <input
            id={inputId}
            type="text"
            spellCheck={false}
            value={value}
            placeholder={defaultFor(id) || 'Default folder'}
            onChange={(e) => {
              const next = e.target.value
              setDrafts((prev) => ({ ...prev, [id]: next }))
            }}
            onBlur={() => commitDraft(id)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault()
                commitDraft(id)
              } else if (e.key === 'Escape') {
                setDrafts((prev) => {
                  const next = { ...prev }
                  delete next[id]
                  return next
                })
              }
            }}
            className="flex-1 min-w-0 bg-panel border border-border-strong rounded px-3 py-1.5 text-xs text-fg-bright placeholder-faint outline-none focus:border-fg font-mono"
          />
          <button
            type="button"
            onClick={() => {
              void choose(id)
            }}
            className="flex items-center gap-1 px-2.5 py-1.5 text-xs text-dim hover:text-fg border border-border rounded transition-colors cursor-pointer shrink-0"
          >
            <FolderOpen className="icon-xs" />
            Choose…
          </button>
          <button
            type="button"
            disabled={!saved}
            onClick={() => {
              void save(id, null)
            }}
            title="Reset to default"
            aria-label={`Reset ${label} to default`}
            className="flex items-center gap-1 px-2 py-1.5 text-xs text-dim hover:text-fg transition-colors cursor-pointer disabled:opacity-40 disabled:cursor-default shrink-0"
          >
            <RotateCcw className="icon-xs" />
            Reset
          </button>
        </div>
        {error && <div className="mt-1 text-xs text-danger">{error}</div>}
      </div>
    )
  }

  return (
    <div>
      {duplicates.length > 0 && (
        <div className="mb-4 rounded-lg p-3 border bg-warning/10 border-warning/30 text-xs text-warning flex gap-2">
          <AlertTriangle className="icon-sm shrink-0 mt-0.5" />
          <div>
            {duplicates.map((keys) => (
              <div key={keys.join(',')}>
                {keys.map(rowLabel).join(', ')} point at the same folder. A sync in one will show up in the others.
              </div>
            ))}
          </div>
        </div>
      )}
      {CONFIG_FOLDER_GROUPS.map((group) => (
        <div key={group.harness} className="mb-5">
          <h3 className="text-sm font-semibold text-fg-bright mb-2">{group.harness}</h3>
          {group.rows.map((row) => renderRow(row.id, row.label))}
        </div>
      ))}
      <div className="mb-2">
        <h3 className="text-sm font-semibold text-fg-bright mb-2">Templates</h3>
        {renderRow('sourceDir', 'Template source folder')}
      </div>
      <RemoteFilePicker
        isOpen={remotePickerRow !== null}
        title="Choose folder"
        initialPath={remotePickerRow ? savedValue(remotePickerRow) || defaultFor(remotePickerRow) || undefined : undefined}
        selectLabel="Choose"
        onSelect={(path) => {
          const row = remotePickerRow
          setRemotePickerRow(null)
          if (row) void save(row, path)
        }}
        onCancel={() => setRemotePickerRow(null)}
      />
    </div>
  )
}
