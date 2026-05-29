import { describe, it, expect } from 'vitest'
import { buildGenericSpawnArgs } from './generic-terminal-agent-spawn'

describe('buildGenericSpawnArgs', () => {
  it('returns command only when no extras', () => {
    expect(buildGenericSpawnArgs({ command: 'my-agent' })).toBe('my-agent')
  })

  it('appends --model when model provided and not already present', () => {
    expect(buildGenericSpawnArgs({ command: 'my-agent', model: 'gpt-4' })).toBe("my-agent --model 'gpt-4'")
  })

  it('skips --model when already in command', () => {
    expect(buildGenericSpawnArgs({ command: 'my-agent --model gpt-3', model: 'gpt-4' })).toBe('my-agent --model gpt-3')
  })

  it('skips --model when -m already in command', () => {
    expect(buildGenericSpawnArgs({ command: 'my-agent -m gpt-3', model: 'gpt-4' })).toBe('my-agent -m gpt-3')
  })

  it('skips --model when supportsModel is false', () => {
    expect(buildGenericSpawnArgs({ command: 'my-agent', model: 'gpt-4', supportsModel: false })).toBe('my-agent')
  })

  it('appends --session-id when assignsSessionId is true and sessionId provided', () => {
    expect(buildGenericSpawnArgs({ command: 'my-agent', assignsSessionId: true, sessionId: 'sess_123' })).toBe("my-agent --session-id 'sess_123'")
  })

  it('skips --session-id when assignsSessionId is not true', () => {
    expect(buildGenericSpawnArgs({ command: 'my-agent', assignsSessionId: false, sessionId: 'sess_123' })).toBe('my-agent')
  })

  it('skips --session-id when already in command', () => {
    expect(buildGenericSpawnArgs({ command: 'my-agent --session-id existing', assignsSessionId: true, sessionId: 'sess_123' })).toBe('my-agent --session-id existing')
  })

  it('appends initial prompt when provided and supported', () => {
    expect(buildGenericSpawnArgs({ command: 'my-agent', initialPrompt: 'hello world' })).toBe("my-agent 'hello world'")
  })

  it('skips initial prompt when supportsPrompt is false', () => {
    expect(buildGenericSpawnArgs({ command: 'my-agent', initialPrompt: 'hello', supportsPrompt: false })).toBe('my-agent')
  })

  it('handles all options together', () => {
    expect(buildGenericSpawnArgs({ command: 'my-agent', model: 'gpt-4', initialPrompt: 'do it' })).toBe("my-agent --model 'gpt-4' 'do it'")
  })

  it('handles all capability flags together', () => {
    expect(
      buildGenericSpawnArgs({
        command: 'my-agent',
        model: 'gpt-4',
        initialPrompt: 'do it',
        supportsModel: true,
        supportsPrompt: true,
        assignsSessionId: true,
        sessionId: 'sess_abc'
      })
    ).toBe("my-agent --model 'gpt-4' --session-id 'sess_abc' 'do it'")
  })
})
