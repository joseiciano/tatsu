import { useState, useEffect, useCallback } from 'react'
import { Check, X, Eye, EyeOff, Plus, Trash2, RotateCcw } from 'lucide-react'
import { Tooltip } from './Tooltip'
import type { TerminalAgentDefinition, AgentRuntimeConfig } from '../../shared/terminal-agents'
import { AgentIcon } from './AgentIcon'

interface AgentSettingsCardProps {
  agent: TerminalAgentDefinition
  runtimeConfig: AgentRuntimeConfig | undefined
  legacyCommand?: string
  legacyModel?: string | null
  legacyEnvVars?: Record<string, string>
  defaultCommand: string
  isDefault: boolean
  onSetDefault: () => void
  onSaveConfig: (config: AgentRuntimeConfig) => void
  onRemoveConfig: () => void
  previewExtra?: string
  children?: React.ReactNode
}

export function AgentSettingsCard({
  agent,
  runtimeConfig,
  legacyCommand,
  legacyModel,
  legacyEnvVars,
  defaultCommand,
  isDefault,
  onSetDefault,
  onSaveConfig,
  onRemoveConfig,
  previewExtra,
  children
}: AgentSettingsCardProps): JSX.Element {
  const [commandDraft, setCommandDraft] = useState(
    runtimeConfig?.command ?? legacyCommand ?? ''
  )
  const [model, setModel] = useState(runtimeConfig?.model ?? legacyModel ?? '')
  const [envRows, setEnvRows] = useState<{ key: string; value: string }[]>(() =>
    Object.entries(runtimeConfig?.envVars ?? legacyEnvVars ?? {}).map(([k, v]) => ({ key: k, value: v }))
  )
  const [revealedEnvRows, setRevealedEnvRows] = useState<Set<number>>(new Set())
  const [saveResult, setSaveResult] = useState<{ ok: boolean; message: string } | null>(null)

  useEffect(() => {
    setCommandDraft(runtimeConfig?.command ?? legacyCommand ?? '')
    setModel(runtimeConfig?.model ?? legacyModel ?? '')
    setEnvRows(Object.entries(runtimeConfig?.envVars ?? legacyEnvVars ?? {}).map(([k, v]) => ({ key: k, value: v })))
  }, [runtimeConfig, legacyCommand, legacyModel, legacyEnvVars])

  const effectiveCommand = commandDraft.trim() || defaultCommand
  const modelPart = model && !effectiveCommand.includes('--model') && !effectiveCommand.includes('-m ')
    ? ` --model ${model}`
    : ''
  const computedPreviewInner = `${effectiveCommand}${modelPart}${previewExtra || ''}`

  const hasChanges = commandDraft !== (runtimeConfig?.command ?? legacyCommand ?? '')
    || model !== (runtimeConfig?.model ?? legacyModel ?? '')
    || envRows.length !== Object.entries(runtimeConfig?.envVars ?? legacyEnvVars ?? {}).length
    || envRows.some((r, i) => {
      const entries = Object.entries(runtimeConfig?.envVars ?? legacyEnvVars ?? {})
      return !entries[i] || entries[i][0] !== r.key || entries[i][1] !== r.value
    })

  const handleSave = useCallback(async () => {
    setSaveResult(null)
    const vars: Record<string, string> = {}
    const seen = new Set<string>()
    const invalidNames: string[] = []
    const duplicates: string[] = []
    for (const { key, value } of envRows) {
      const k = key.trim()
      if (!k) continue
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(k)) { invalidNames.push(k); continue }
      if (seen.has(k)) { duplicates.push(k); continue }
      seen.add(k)
      vars[k] = value
    }
    if (invalidNames.length > 0) {
      setSaveResult({ ok: false, message: `Invalid name(s): ${invalidNames.join(', ')}` })
      return
    }
    if (duplicates.length > 0) {
      setSaveResult({ ok: false, message: `Duplicate name(s): ${duplicates.join(', ')}` })
      return
    }
    await onSaveConfig({
      command: commandDraft.trim() || undefined,
      model: model || null,
      envVars: Object.keys(vars).length > 0 ? vars : undefined
    })
    setSaveResult({ ok: true, message: 'Saved · new tabs will use these settings' })
  }, [commandDraft, model, envRows, onSaveConfig])

  const handleReset = useCallback(async () => {
    setCommandDraft('')
    setModel('')
    setEnvRows([])
    setRevealedEnvRows(new Set())
    await onRemoveConfig()
    setSaveResult({ ok: true, message: 'Reset to defaults' })
  }, [onRemoveConfig])

  return (
    <div className="mt-8">
      <h3 className="text-sm font-semibold text-fg-bright mb-3 flex items-center gap-2">
        <AgentIcon kind={agent.id} className="icon-sm" />
        {agent.displayName}
        {isDefault && <span className="text-xs font-normal text-dim bg-panel px-1.5 py-0.5 rounded">default</span>}
        {!isDefault && (
          <button
            onClick={onSetDefault}
            className="ml-auto text-xs text-dim hover:text-fg transition-colors cursor-pointer"
          >
            Set as default
          </button>
        )}
      </h3>

      {agent.capabilities.supportsModel && (
        <div className="bg-panel-raised border border-border rounded-lg p-4 mb-4">
          <label className="block text-sm font-medium text-fg mb-1">Model</label>
          <p className="text-xs text-dim mb-2">
            Appends <code className="bg-panel px-1 rounded">--model</code> to the launch command. Leave on default to let the CLI choose.
          </p>
          {agent.models.length > 0 ? (
            <select
              value={model}
              onChange={(e) => { setModel(e.target.value); setSaveResult(null) }}
              className="w-full bg-panel border border-border-strong rounded px-3 py-2 text-sm text-fg-bright outline-none focus:border-fg cursor-pointer"
            >
              <option value="">(Default — let CLI choose)</option>
              <optgroup label="Current">
                {agent.models.filter((m) => m.tier === 'current').map((m) => (
                  <option key={m.id} value={m.id}>{m.displayName}</option>
                ))}
              </optgroup>
              <optgroup label="Legacy">
                {agent.models.filter((m) => m.tier === 'legacy').map((m) => (
                  <option key={m.id} value={m.id}>{m.displayName}</option>
                ))}
              </optgroup>
            </select>
          ) : (
            <input
              type="text"
              value={model}
              onChange={(e) => { setModel(e.target.value); setSaveResult(null) }}
              placeholder="provider/model"
              spellCheck={false}
              className="w-full bg-panel border border-border-strong rounded px-3 py-2 text-sm text-fg-bright outline-none focus:border-fg font-mono"
            />
          )}
        </div>
      )}

      <div className="bg-panel-raised border border-border rounded-lg p-4">
        <label className="block text-sm font-medium text-fg mb-1">Launch command</label>
        <p className="text-xs text-dim mb-2">
          {agent.capabilities.assignsSessionId
            ? 'Harness appends --session-id <uuid> so each tab has its own stable, resumable session.'
            : 'The CLI command. Harness manages session resume automatically.'}
        </p>
        <textarea
          value={commandDraft}
          onChange={(e) => { setCommandDraft(e.target.value); setSaveResult(null) }}
          rows={2}
          spellCheck={false}
          className="w-full bg-panel border border-border-strong rounded px-3 py-2 text-xs text-fg-bright placeholder-faint outline-none focus:border-fg font-mono resize-y"
          placeholder={defaultCommand}
        />
        <div className="flex items-center gap-2 mt-3">
          <button
            onClick={handleSave}
            className="px-3 py-1.5 bg-surface hover:bg-surface-hover rounded text-sm text-fg-bright transition-colors cursor-pointer"
          >
            Save
          </button>
          {hasChanges && (
            <button onClick={handleReset} className="flex items-center gap-1 px-3 py-1.5 text-sm text-dim hover:text-fg transition-colors cursor-pointer">
              <RotateCcw className="icon-xs" />Reset
            </button>
          )}
        </div>
        {saveResult && (
          <div className={`mt-3 text-xs flex items-center gap-1.5 ${saveResult.ok ? 'text-success' : 'text-danger'}`}>
            {saveResult.ok ? <Check className="icon-xs" /> : <X className="icon-xs" />}{saveResult.message}
          </div>
        )}

        <div className="mt-4 pt-3 border-t border-border">
          <label className="block text-xs font-medium text-fg mb-1">Full command preview</label>
          <div className="bg-panel border border-border rounded px-3 py-2 text-xs text-fg-bright font-mono break-all">{`<shell> -ilc "${computedPreviewInner}"`}</div>
          <p className="text-xs text-dim mt-1">where <code className="bg-panel px-1 rounded">{`<shell>`}</code> is your <code className="bg-panel px-1 rounded">$SHELL</code> (typically <code className="bg-panel px-1 rounded">/bin/bash</code> or <code className="bg-panel px-1 rounded">/bin/zsh</code>).</p>
        </div>

        {children}
      </div>

      <div className="mt-4 bg-panel-raised border border-border rounded-lg p-4">
        <label className="block text-sm font-medium text-fg mb-1">Environment variables</label>
        <p className="text-xs text-dim mb-3">
          Injected into {agent.displayName} tabs.
        </p>
        {envRows.length > 0 && (
          <div className="space-y-2 mb-3">
            {envRows.map((row, index) => {
              const revealed = revealedEnvRows.has(index)
              return (
                <div key={index} className="flex items-center gap-2">
                  <input type="text" value={row.key} onChange={(e) => { setEnvRows((prev) => prev.map((r, i) => (i === index ? { ...r, key: e.target.value } : r))); setSaveResult(null) }} placeholder="NAME" spellCheck={false} className="w-44 bg-panel border border-border-strong rounded px-2 py-1.5 text-xs text-fg-bright placeholder-faint outline-none focus:border-fg font-mono" />
                  <span className="text-dim text-xs">=</span>
                  <input type={revealed ? 'text' : 'password'} value={row.value} onChange={(e) => { setEnvRows((prev) => prev.map((r, i) => (i === index ? { ...r, value: e.target.value } : r))); setSaveResult(null) }} placeholder="value" spellCheck={false} className="flex-1 bg-panel border border-border-strong rounded px-2 py-1.5 text-xs text-fg-bright placeholder-faint outline-none focus:border-fg font-mono" />
                  <Tooltip label={revealed ? 'Hide value' : 'Reveal value'}><button onClick={() => setRevealedEnvRows((prev) => { const next = new Set(prev); if (next.has(index)) next.delete(index); else next.add(index); return next })} className="p-1.5 text-dim hover:text-fg transition-colors cursor-pointer">{revealed ? <EyeOff className="icon-sm" /> : <Eye className="icon-sm" />}</button></Tooltip>
                  <Tooltip label="Remove"><button onClick={() => { setEnvRows((prev) => prev.filter((_, i) => i !== index)); setSaveResult(null) }} className="p-1.5 text-dim hover:text-danger transition-colors cursor-pointer"><Trash2 className="icon-sm" /></button></Tooltip>
                </div>
              )
            })}
          </div>
        )}
        <div className="flex items-center gap-2">
          <button onClick={() => { setEnvRows((prev) => [...prev, { key: '', value: '' }]); setSaveResult(null) }} className="flex items-center gap-1 px-3 py-1.5 bg-surface hover:bg-surface-hover rounded text-sm text-fg-bright transition-colors cursor-pointer"><Plus className="icon-xs" />Add variable</button>
          <button onClick={handleSave} className="px-3 py-1.5 bg-surface hover:bg-surface-hover rounded text-sm text-fg-bright transition-colors cursor-pointer">Save</button>
        </div>
      </div>
    </div>
  )
}
