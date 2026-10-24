import { describe, it, expect, vi } from 'vitest'
import { createAttachStream } from '.'

function setup() {
  const write = vi.fn<(data: string) => void>()
  const stream = createAttachStream(write)
  const written = () => write.mock.calls.map(([chunk]) => chunk)
  return { write, stream, written }
}

describe('createAttachStream', () => {
  it('never writes chunks pushed before beginLive(true) and writes later pushes in order', () => {
    const { stream, written } = setup()
    stream.push('a')
    stream.push('b')
    expect(written()).toEqual([])

    stream.beginLive(true)
    expect(written()).toEqual([])

    stream.push('c')
    stream.push('d')
    expect(written()).toEqual(['c', 'd'])
  })

  it('flushes buffered chunks in push order on beginLive(false), then writes later pushes', () => {
    const { stream, written } = setup()
    stream.push('a')
    stream.push('b')
    stream.push('c')
    expect(written()).toEqual([])

    stream.beginLive(false)
    expect(written()).toEqual(['a', 'b', 'c'])

    stream.push('d')
    expect(written()).toEqual(['a', 'b', 'c', 'd'])
  })

  describe('a second beginLive is a no-op', () => {
    const cases = [
      { name: 'true then true', first: true, second: true, expected: ['y', 'z'] },
      { name: 'true then false', first: true, second: false, expected: ['y', 'z'] },
      { name: 'false then true', first: false, second: true, expected: ['x', 'y', 'z'] },
      { name: 'false then false', first: false, second: false, expected: ['x', 'y', 'z'] }
    ]
    for (const { name, first, second, expected } of cases) {
      it(name, () => {
        const { stream, written } = setup()
        stream.push('x')
        stream.beginLive(first)
        stream.push('y')
        stream.beginLive(second)
        stream.push('z')
        expect(written()).toEqual(expected)
      })
    }
  })

  it('writes the failed-spawn error line pushed before the reply exactly once', () => {
    const errorLine = '\r\n\x1b[31mFailed to spawn "zsh": boom\x1b[0m\r\n'
    const { stream, written } = setup()
    stream.push(errorLine)
    stream.beginLive(false)
    stream.beginLive(false)
    expect(written()).toEqual([errorLine])
  })

  it('writes a spawned PTY first-output chunk once, before chunks pushed after the reply', () => {
    const { stream, written } = setup()
    stream.push('first-output')
    stream.beginLive(false)
    stream.push('after-1')
    stream.push('after-2')
    expect(written()).toEqual(['first-output', 'after-1', 'after-2'])
  })

  it('on attach replay, output is history followed by post-reply chunks with the pre-reply chunk only inside history', () => {
    const { write, stream, written } = setup()
    const d1 = 'c'
    const history = 'ab' + d1
    const d2 = 'def'

    stream.push(d1)
    write(history)
    stream.beginLive(true)
    stream.push(d2)

    const output = written().join('')
    expect(output).toBe('abc' + d2)
    expect(output.split(d1).length - 1).toBe(1)
  })
})
