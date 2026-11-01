import { describe, expect, it, vi } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { ConfigEditor } from './ConfigEditor'
import { ConfigResourceList } from './ConfigResourceList'
import type { ConfigDriftBadge, ConfigEditorProps, ConfigResourceGroup } from './types'
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

function editorProps(target: HarnessConfigFileRef, canEdit: boolean, badge: ConfigDriftBadge = 'synced'): ConfigEditorProps {
  return {
    view: { kind: 'edit', scope: { agentKind: 'claude', resourceType: 'skills' }, agentDisplayName: 'Claude Code', ref: target, badge },
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

function group(rows: ConfigResourceGroup['rows']): ConfigResourceGroup {
  return {
    agentKind: 'claude',
    displayName: 'Claude Code',
    scope: { agentKind: 'claude', resourceType: 'skills' },
    scopeKey: 'claude:skills',
    capability: { resourceType: 'skills', status: 'supported' } as ConfigResourceGroup['capability'],
    supported: true,
    note: null,
    comparisonStatus: null,
    rows,
    totalResourceCount: rows.length,
    busy: false,
    requestError: null,
    notice: null
  }
}

function renderList(groups: ConfigResourceGroup[]): string {
  return renderToStaticMarkup(
    <ConfigResourceList
      groups={groups}
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
}

describe('drift badges', () => {
  it('shows no badge on a synced row and labels not-on-disk and out-of-sync rows', () => {
    const row = (id: string, badge: ConfigDriftBadge): ConfigResourceGroup['rows'][number] => ({
      key: `claude:${id}`,
      ref: ref({ id, label: id, relativePath: `${id}/SKILL.md` }),
      badge,
      selected: false,
      disabled: false,
      conversionAction: null
    })
    expect(renderList([group([row('in-sync', 'synced')])])).not.toMatch(/Synced|Not on disk|Out of sync/)
    const html = renderList([group([row('missing', 'config-only'), row('drifted', 'conflict')])])
    expect(html).toContain('>Not on disk<')
    expect(html).toContain('>Out of sync<')
  })

  it('shows no badge in the editor header for a synced file and labels a drifted one', () => {
    expect(renderToStaticMarkup(<ConfigEditor {...editorProps(ref(), true)} />)).not.toMatch(/Synced|Out of sync/)
    expect(renderToStaticMarkup(<ConfigEditor {...editorProps(ref(), true, 'conflict')} />)).toContain('>Out of sync<')
  })

  it('tells the user a template builds a file that is not on disk yet', () => {
    const html = renderToStaticMarkup(
      <ConfigEditor
        {...editorProps(ref(), false)}
        view={{
          kind: 'config-only',
          scope: { agentKind: 'claude', resourceType: 'skills' },
          agentDisplayName: 'Claude Code',
          ref: ref({ existsOnDisk: false }),
          badge: 'config-only'
        }}
      />
    )
    expect(html).toContain('>Not on disk<')
    expect(html).toContain('A template builds this file')
    expect(html).toContain('Use Sync on Claude Code to write it')
    expect(html).not.toContain('Tatsu config')
  })
})

describe('linked resources', () => {
  it('shows the Linked badge with its source in the tooltip and no linked note in the editor', () => {
    const html = renderToStaticMarkup(
      <ConfigEditor {...editorProps(ref({ linkedFrom: '/dotfiles/output/claude/skills/deploy' }), true)} />
    )
    expect(html).toContain('title="Linked from /dotfiles/output/claude/skills/deploy"')
    expect(html).not.toContain('Linked from /dotfiles/output/claude/skills/deploy.')
    expect(html).not.toContain('symbolic link into another folder')
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
