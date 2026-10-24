import { describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { ConfigSyncDialog } from './ConfigSyncDialog'
import { toConfigSyncReview } from './config-sync-review'
import type { ConfigSyncDialogProps } from './types'
import type { HarnessConfigComparison, HarnessConfigFileRef } from '../../../shared/state/harness-config'

function ref(overrides: Partial<HarnessConfigFileRef> = {}): HarnessConfigFileRef {
  return {
    id: 'ref:claude:skills:one',
    agentKind: 'claude',
    resourceType: 'skills',
    canonicalResourceType: 'skills',
    aliasResourceTypes: [],
    label: 'One',
    relativePath: 'skills/one.md',
    absolutePath: '/workspace/.claude/skills/one.md',
    hash: 'abcdefabcdefabcdefabcdef',
    existsOnDisk: true,
    managed: true,
    updatedAt: 1_700_000_000_000,
    ...overrides
  }
}

const comparison: HarnessConfigComparison = {
  scope: { agentKind: 'claude', resourceType: 'skills' },
  status: 'conflict',
  diskOnly: [ref({ id: 'disk-only-1', relativePath: 'skills/disk-only.md' })],
  configOnly: [ref({ id: 'config-only-1', relativePath: 'skills/config-only.md' })],
  changed: [
    {
      disk: ref({ id: 'changed-1', relativePath: 'skills/changed.md', hash: 'disk-hash-value' }),
      config: ref({ id: 'changed-1', relativePath: 'skills/changed.md', hash: 'config-hash-value' })
    }
  ],
  comparedAt: 1_700_000_000_000
}

function baseProps(overrides: Partial<ConfigSyncDialogProps> = {}): ConfigSyncDialogProps {
  return {
    open: true,
    review: toConfigSyncReview(comparison),
    agentDisplayName: 'Claude Code',
    resourceLabel: 'Skills',
    stage: 'idle',
    reviewUsable: true,
    actionError: null,
    actionNotice: null,
    detachIds: new Set(),
    onDetachChange: () => {},
    onSyncToDisk: () => {},
    onAdoptFromDisk: () => {},
    onCancel: () => {},
    ...overrides
  }
}

describe('ConfigSyncDialog templates', () => {
  const templateRef = (overrides: Partial<HarnessConfigFileRef> = {}): HarnessConfigFileRef =>
    ref({ source: 'template', templateRef: 'skill/one', updatedAt: 0, existsOnDisk: false, ...overrides })

  const templateComparison: HarnessConfigComparison = {
    ...comparison,
    diskOnly: [],
    configOnly: [templateRef({ id: 'tmpl-new', relativePath: 'new/SKILL.md' })],
    changed: [
      {
        disk: ref({ id: 'tmpl-changed', relativePath: 'changed/SKILL.md', hash: 'disk-hash' }),
        config: templateRef({ id: 'tmpl-changed', relativePath: 'changed/SKILL.md', hash: 'tmpl-hash' })
      }
    ],
    shadowed: [ref({ id: 'tmpl-new', relativePath: 'new/SKILL.md', hash: 'stored-hash' })],
    renderErrors: [
      {
        templateRef: 'skill/broken',
        message: 'Unknown fragment: tone',
        held: [ref({ id: 'held-1', relativePath: 'broken/SKILL.md', templateRef: 'skill/broken' })]
      }
    ]
  }

  it('labels template entries and states what adopt does with each one (REQ-006)', () => {
    const html = renderToStaticMarkup(<ConfigSyncDialog {...baseProps({ review: toConfigSyncReview(templateComparison) })} />)
    expect(html).toContain('Template: skill/one')
    expect(html).toContain('Built from skill/one')
    expect(html).toContain('Adopt keeps this template output')
    expect(html).toContain('Keep template (skip this file)')
    expect(html).toContain('Detach from template')
    expect(html.match(/type="radio"/g)).toHaveLength(2)
  })

  it('checks the detach option for ids the user chose', () => {
    const keep = renderToStaticMarkup(<ConfigSyncDialog {...baseProps({ review: toConfigSyncReview(templateComparison) })} />)
    expect(keep).toMatch(/checked=""[^>]*\/>Keep template/)
    const detach = renderToStaticMarkup(
      <ConfigSyncDialog
        {...baseProps({ review: toConfigSyncReview(templateComparison), detachIds: new Set(['tmpl-changed']) })}
      />
    )
    expect(detach).toMatch(/checked=""[^>]*\/>Detach from template/)
  })

  it('shows render errors with held files and shadowed stored entries (REQ-002/REQ-007)', () => {
    const html = renderToStaticMarkup(<ConfigSyncDialog {...baseProps({ review: toConfigSyncReview(templateComparison) })} />)
    expect(html).toContain('Template errors')
    expect(html).toContain('skill/broken')
    expect(html).toContain('Unknown fragment: tone')
    expect(html).toContain('broken/SKILL.md')
    expect(html).toContain('sync to disk and adopt both leave them alone')
    expect(html).toContain('Hidden by a template')
  })

  it('lists template output behind a link without telling the user to remove the link first (REQ-008)', () => {
    const linked = toConfigSyncReview({
      ...comparison,
      diskOnly: [],
      changed: [],
      configOnly: [templateRef({ linkedFrom: '/dotfiles/skills' })]
    })
    const html = renderToStaticMarkup(<ConfigSyncDialog {...baseProps({ review: linked })} />)
    expect(html).toContain('/dotfiles/skills')
    expect(html).not.toContain('Remove the link')
    expect(html).not.toContain("can't write this template output")
  })
})

describe('ConfigSyncDialog', () => {
  it('renders nothing when closed or without a review', () => {
    expect(renderToStaticMarkup(<ConfigSyncDialog {...baseProps({ open: false })} />)).toBe('')
    expect(renderToStaticMarkup(<ConfigSyncDialog {...baseProps({ review: null })} />)).toBe('')
  })

  it('exposes the dialog ARIA contract and exact scope identity', () => {
    const html = renderToStaticMarkup(<ConfigSyncDialog {...baseProps()} />)
    expect(html).toContain('role="dialog"')
    expect(html).toContain('aria-modal="true"')
    expect(html).toContain('aria-labelledby="config-sync-dialog-title"')
    expect(html).toContain('aria-describedby="config-sync-dialog-desc"')
    expect(html).toContain('Claude Code')
    expect(html).toContain('Skills')
  })

  it('renders all three named groups with counts and empty states', () => {
    const emptyReview = toConfigSyncReview({
      ...comparison,
      diskOnly: [],
      configOnly: [],
      changed: []
    })
    const html = renderToStaticMarkup(<ConfigSyncDialog {...baseProps({ review: emptyReview })} />)
    expect(html).toContain('Disk only')
    expect(html).toContain('Config only')
    expect(html).toContain('Content changed')
    expect(html).toContain('No disk-only files')
    expect(html).toContain('No config-only files')
    expect(html).toContain('No content-changed files')
  })

  it('renders disk-only, config-only, and content-changed rows with originating harness/resource and metadata', () => {
    const html = renderToStaticMarkup(<ConfigSyncDialog {...baseProps()} />)
    expect(html).toContain('skills/disk-only.md')
    expect(html).toContain('skills/config-only.md')
    expect(html).toContain('skills/changed.md')
    // every row repeats the originating harness/resource label
    expect(html.match(/Claude Code · Skills/g)?.length ?? 0).toBeGreaterThanOrEqual(4)
    // paired content-changed sides are labeled Disk / Tatsu config
    expect(html).toContain('>Disk<')
    expect(html).toContain('>Tatsu config<')
    // hash rendered as sha256:<first 12 chars>, full hash kept in title
    expect(html).toContain('sha256:disk-hash-va')
    expect(html).toContain('title="sha256:disk-hash-value"')
  })

  it('renders exactly the three outcome labels with no fourth action', () => {
    const html = renderToStaticMarkup(<ConfigSyncDialog {...baseProps()} />)
    expect(html).toContain('>Sync Tatsu config to disk<')
    expect(html).toContain('>Adopt current disk files into Tatsu config<')
    expect(html).toContain('>Cancel<')
    const buttonCount = html.match(/<button/g)?.length ?? 0
    // Close icon + Cancel + Adopt + Sync = exactly 4 buttons.
    expect(buttonCount).toBe(4)
  })

  it('disables only the two mutation controls while planning, keeping Cancel enabled', () => {
    const html = renderToStaticMarkup(<ConfigSyncDialog {...baseProps({ stage: 'planning' })} />)
    const cancelButton = html.match(/<button[^>]*>Cancel<\/button>/)?.[0] ?? ''
    expect(cancelButton).not.toContain(' disabled=""')
    const syncButton = html.match(/<button[^>]*>Sync Tatsu config to disk<\/button>/)?.[0] ?? ''
    const adoptButton = html.match(/<button[^>]*>Adopt current disk files into Tatsu config<\/button>/)?.[0] ?? ''
    expect(syncButton).toContain(' disabled=""')
    expect(adoptButton).toContain(' disabled=""')
  })

  it('disables Cancel and the close icon while applying', () => {
    const html = renderToStaticMarkup(<ConfigSyncDialog {...baseProps({ stage: 'applying' })} />)
    const cancelButton = html.match(/<button[^>]*>Cancel<\/button>/)?.[0] ?? ''
    expect(cancelButton).toContain(' disabled=""')
    const closeButton = html.match(/<button[^>]*aria-label="Close"[^>]*>/)?.[0] ?? ''
    expect(closeButton).toContain(' disabled=""')
  })

  it('disables mutation controls when the review is unusable even in idle stage', () => {
    const html = renderToStaticMarkup(<ConfigSyncDialog {...baseProps({ reviewUsable: false })} />)
    const syncButton = html.match(/<button[^>]*>Sync Tatsu config to disk<\/button>/)?.[0] ?? ''
    expect(syncButton).toContain(' disabled=""')
  })

  it('surfaces a safe action error and notice in the live status region without arbitrary content', () => {
    const html = renderToStaticMarkup(
      <ConfigSyncDialog
        {...baseProps({
          actionError: 'Something went wrong while applying the plan.',
          actionNotice: 'Files changed. Review the refreshed plan and choose an action again.'
        })}
      />
    )
    expect(html).toContain('aria-live="polite"')
    expect(html).toContain('Something went wrong while applying the plan.')
    expect(html).toContain('Files changed. Review the refreshed plan and choose an action again.')
  })

  it('has an accessible label on the icon-only close control', () => {
    const html = renderToStaticMarkup(<ConfigSyncDialog {...baseProps()} />)
    expect(html).toContain('aria-label="Close"')
  })

  it('lists linked entries with their source and says sync to disk writes through them', () => {
    const plain = renderToStaticMarkup(<ConfigSyncDialog {...baseProps()} />)
    expect(plain).not.toContain('Linked')

    const linkedReview = toConfigSyncReview({
      ...comparison,
      diskOnly: [ref({ id: 'linked-1', relativePath: 'deploy/SKILL.md', linkedFrom: '/dotfiles/output/deploy' })]
    })
    const html = renderToStaticMarkup(<ConfigSyncDialog {...baseProps({ review: linkedReview })} />)
    expect(html).toContain('title="Linked from /dotfiles/output/deploy"')
    expect(html).toContain('Sync to disk writes through the link')
    expect(html).not.toContain('Excluded from sync to disk')
    expect(html).not.toContain('Managed elsewhere')
  })

  it('changes the review key when only linkedFrom differs', () => {
    const linked = toConfigSyncReview({
      ...comparison,
      diskOnly: [ref({ id: 'disk-only-1', relativePath: 'skills/disk-only.md', linkedFrom: '/dotfiles/one' })]
    })
    expect(linked.reviewKey).not.toBe(toConfigSyncReview(comparison).reviewKey)
  })
})
