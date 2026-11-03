import { describe, it, expect } from 'vitest'
import { CliError } from '../errors'
import { createOutput, formatTable, printError } from '.'

function capture(): { write: (text: string) => void; text: () => string } {
  const chunks: string[] = []
  return { write: (text) => chunks.push(text), text: () => chunks.join('') }
}

describe('createOutput', () => {
  it('prints the human rendering in human mode', () => {
    const out = capture()
    const output = createOutput({ json: false, stdout: out.write })
    output.result({ n: 2 }, (v) => `count ${v.n}`)
    output.flush()
    expect(out.text()).toBe('count 2\n')
  })

  it('prints exactly one JSON document in json mode and skips the human renderer', () => {
    const out = capture()
    const output = createOutput({ json: true, stdout: out.write })
    output.result({ n: 2 }, () => {
      throw new Error('human renderer must not run in json mode')
    })
    output.flush()
    expect(JSON.parse(out.text())).toEqual({ n: 2 })
    expect(out.text().trimEnd().split('\n')).toHaveLength(1)
  })

  it('flushKept writes only a result marked keepOnError', () => {
    const kept = capture()
    const keeper = createOutput({ json: false, stdout: kept.write })
    keeper.result('partial', (v) => v, { keepOnError: true })
    keeper.flushKept()
    expect(kept.text()).toBe('partial\n')

    const dropped = capture()
    const plain = createOutput({ json: false, stdout: dropped.write })
    plain.result('whole', (v) => v)
    plain.flushKept()
    expect(dropped.text()).toBe('')
  })

  it('writes nothing until flushed', () => {
    const out = capture()
    const output = createOutput({ json: true, stdout: out.write })
    output.result({ n: 1 }, () => '')
    expect(out.text()).toBe('')
  })

  it('rejects a second result so stdout can never hold two documents', () => {
    const output = createOutput({ json: true, stdout: () => {} })
    output.result(1, String)
    expect(() => output.result(2, String)).toThrow()
  })

  it('writes nothing when no result was set', () => {
    const out = capture()
    createOutput({ json: true, stdout: out.write }).flush()
    expect(out.text()).toBe('')
  })
})

describe('printError', () => {
  it('prints tatsu: <message> in human mode', () => {
    const err = capture()
    printError(new CliError('usage', 'bad flag'), { json: false, stderr: err.write })
    expect(err.text()).toBe('tatsu: bad flag\n')
  })

  it('prints a single {error:{code,message,details}} object in json mode', () => {
    const err = capture()
    printError(new CliError('timeout', 'too slow', { ms: 30000 }), { json: true, stderr: err.write })
    expect(JSON.parse(err.text())).toEqual({
      error: { code: 'timeout', message: 'too slow', details: { ms: 30000 } }
    })
  })
})

describe('formatTable', () => {
  it('pads columns to the widest cell', () => {
    expect(formatTable([['ROOT', 'WORKTREES'], ['/a/long/path', '3'], ['/b', '12']])).toBe(
      ['ROOT          WORKTREES', '/a/long/path  3', '/b            12'].join('\n')
    )
  })
})
