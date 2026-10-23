import { createHash } from 'crypto'
import { describe, expect, it } from 'vitest'
import { sha256Hex } from '.'

function nodeSha256(value: string): string {
  return createHash('sha256').update(Buffer.from(value, 'utf8')).digest('hex')
}

describe('sha256Hex', () => {
  it('matches known vectors', () => {
    expect(sha256Hex('')).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855')
    expect(sha256Hex('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad')
  })

  it('matches Node crypto across block boundaries and multi-byte text', () => {
    const samples = ['a'.repeat(55), 'a'.repeat(56), 'a'.repeat(64), 'a'.repeat(1000), '---\nname: héllo ✓\n---\n']
    for (const sample of samples) expect(sha256Hex(sample)).toBe(nodeSha256(sample))
  })

  it('hashes bytes the same as the equivalent text', () => {
    expect(sha256Hex(new TextEncoder().encode('tatsu'))).toBe(sha256Hex('tatsu'))
  })
})
