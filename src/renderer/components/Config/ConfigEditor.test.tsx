import { describe, expect, it, vi } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { ConfigEditor } from './ConfigEditor'
import { ConfigResourceList } from './ConfigResourceList'
import type { ConfigEditorProps, ConfigResourceGroup } from './types'
import type { HarnessConfigFileRef } from '../../../shared/state/harness-config'

vi.mock('../MonacoEditor', () => ({ MonacoEditor: () => null }))

const noop = (): void => {}

function ref(overrides: Partial<HarnessConfigFileRef> = {}): HarnessConfigFileRef {
  return {
    id: 'ref:claude:skills:deploy',
    agentKind: 'claude',
    resourceType: 'skills',
    canonicalResourceType: 'skills',
    aliasResourceTypes: ['commands'],
    label: 'deploy',
    relativePath: 'deploy/SKILL.md',
    absolutePath: '/home/.claude/skills/deploy/SKILL.md',
    hash: 'abc',
    existsOnDisk: true,
    managed: false,
    updatedAt: 1,
    ...overrides
  }
}

function editorProps(target: HarnessConfigFileRef, canEdit: boolean): ConfigEditorProps {
  return {
    view: { kind: 'edit', scope: { agentKind: 'claude', resourceType: 'skills' }, agentDisplayName: 'Claude Code', ref: target, badge: 'disk-only' },
    draft: 'content',
    onDraftChange: noop,
    nameDraft: '',
    onNameDraftChange: noop,
    dirty: false,
    busy: false,
    canEdit,
    canSave: false,
    canCreate: false,
    canDelete: canEdit,
    error: null,
    onSave: noop,
    onCreate: noop,
    onDelete: noop,
    onCancel: noop,
    onReset: noop
  }
}

describe('linked resources', () => {
  it('shows the Linked badge, linked path, and write-through explanation in the editor', () => {
    const html = renderToStaticMarkup(
      <ConfigEditor {...editorProps(ref({ linkedFrom: '/dotfiles/output/claude/skills/deploy' }), true)} />
    )
    expect(html).toContain('title="Linked from /dotfiles/output/claude/skills/deploy"')
    expect(html).toContain('Linked from /dotfiles/output/claude/skills/deploy.')
    expect(html).toContain('Edits, deletes, and sync to disk change the files at that source')
    expect(html).not.toContain('Read-only')
    expect(html).not.toContain('Managed elsewhere')
    expect(html).not.toContain('delete it at its source')
  })

  it('omits the linked chrome for a regular resource', () => {
    const html = renderToStaticMarkup(<ConfigEditor {...editorProps(ref(), true)} />)
    expect(html).not.toContain('Linked')
  })

  it('badges linked rows in the resource list', () => {
    const linked = ref({ linkedFrom: '/dotfiles/output/claude/skills/deploy' })
    const group: ConfigResourceGroup = {
      agentKind: 'claude',
      displayName: 'Claude Code',
      scope: { agentKind: 'claude', resourceType: 'skills' },
      scopeKey: 'claude:skills',
      capability: { resourceType: 'skills', status: 'supported' } as ConfigResourceGroup['capability'],
      supported: true,
      note: null,
      comparisonStatus: null,
      rows: [
        { key: 'claude:linked', ref: linked, badge: 'synced', selected: false, disabled: false, conversionAction: null },
        { key: 'claude:plain', ref: ref({ id: 'plain', label: 'plain', relativePath: 'plain/SKILL.md' }), badge: 'synced', selected: false, disabled: false, conversionAction: null }
      ],
      totalResourceCount: 2,
      busy: false,
      requestError: null,
      notice: null
    }
    const html = renderToStaticMarkup(
      <ConfigResourceList
        groups={[group]}
        deferredHarnesses={[]}
        searchActive={false}
        sharedError={null}
        onSelectResource={noop}
        onCreate={noop}
        onSync={noop}
        onCreateCommand={noop}
        onCreateSkill={noop}
      />
    )
    expect(html.match(/title="Linked from \/dotfiles\/output\/claude\/skills\/deploy"/g)).toHaveLength(1)
    expect(html).not.toContain('Managed elsewhere')
  })
})
