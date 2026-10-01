import { describe, it, expect, vi } from 'vitest'
import { execFileSync } from 'child_process'
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { makeHookCommand, makeHookScript } from '.'

vi.mock('../debug', () => ({
  log: vi.fn()
}))

function runHook(argv: string[], terminalId: string, payload: string): string {
  const file = `/tmp/harness-status/${terminalId}.ndjson`
  rmSync(file, { force: true })
  execFileSync(argv[0], argv.slice(1), {
    input: payload,
    env: { PATH: process.env.PATH, HARNESS_TERMINAL_ID: terminalId }
  })
  const out = readFileSync(file, 'utf-8')
  rmSync(file, { force: true })
  return out.replace(/"ts":\d+/, '"ts":0')
}

describe('makeHookScript', () => {
  it('writes the same NDJSON line as the inline hook command', () => {
    const dir = mkdtempSync(join(tmpdir(), 'harness-hook-'))
    const script = join(dir, 'hook.sh')
    writeFileSync(script, makeHookScript())
    const payload = '{"session_id":"s1","note":"100% done"}'
    try {
      const fromScript = runHook(['bash', script, 'Stop'], `test-script-${process.pid}`, payload)
      const inline = makeHookCommand('Stop').replace(/^bash -c '/, '').replace(/'$/, '')
      const fromInline = runHook(['bash', '-c', inline], `test-inline-${process.pid}`, payload)
      expect(fromScript).toBe(fromInline)
      expect(JSON.parse(fromScript)).toEqual({
        event: 'Stop',
        ts: 0,
        payload: { session_id: 's1', note: '100% done' }
      })
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('exits without writing when no terminal id is set', () => {
    expect(() =>
      execFileSync('bash', ['-c', makeHookScript(), 'hook', 'Stop'], {
        input: '{}',
        env: { PATH: process.env.PATH }
      })
    ).not.toThrow()
  })
})
