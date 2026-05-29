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

  it('appends initial prompt when provided and supported', () => {
    expect(buildGenericSpawnArgs({ command: 'my-agent', initialPrompt: 'hello world' })).toBe("my-agent 'hello world'")
  })

  it('skips initial prompt when supportsPrompt is false', () => {
    expect(buildGenericSpawnArgs({ command: 'my-agent', initialPrompt: 'hello', supportsPrompt: false })).toBe('my-agent')
  })

  it('handles all options together', () => {
    expect(buildGenericSpawnArgs({ command: 'my-agent', model: 'gpt-4', initialPrompt: 'do it' })).toBe("my-agent --model 'gpt-4' 'do it'")
  })
})
