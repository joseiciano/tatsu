import { describe, expect, it } from 'vitest'
import type { WorktreeContainerMetadata } from '../../../shared/state/worktrees'
import { containerStatusLabel, shortContainerError } from './container-status'

function container(status: WorktreeContainerMetadata['status'], error?: string): WorktreeContainerMetadata {
  return {
    id: 'container-1',
    name: 'tatsu-wt-feature',
    image: 'node:20-alpine',
    workdir: '/workspace',
    shell: '/bin/sh',
    status,
    ...(error ? { error } : {})
  }
}

describe('containerStatusLabel', () => {
  it('formats planned container status labels', () => {
    expect(containerStatusLabel(container('running'))).toBe('Container running')
    expect(containerStatusLabel(container('starting'))).toBe('Container starting')
    expect(containerStatusLabel(container('stopped'))).toBe('Container stopped')
  })

  it('uses short error copy for error containers', () => {
    expect(containerStatusLabel(container('error', 'Docker daemon unavailable'))).toBe('Docker daemon unavailable')
    expect(containerStatusLabel(container('error'))).toBe('Container error')
  })
})

describe('shortContainerError', () => {
  it('truncates long container errors', () => {
    const result = shortContainerError('x'.repeat(120))
    expect(result).toHaveLength(80)
    expect(result.endsWith('…')).toBe(true)
  })
})
