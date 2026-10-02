import { describe, it, expect } from 'vitest'
import { consumeToken, createTokenBucket } from '.'

describe('token bucket rate limiter', () => {
  it('allows burst capacity then rejects until tokens refill', () => {
    const bucket = createTokenBucket(2, 1000)

    expect(consumeToken(bucket, 2, 1, 1000)).toBe(true)
    expect(consumeToken(bucket, 2, 1, 1000)).toBe(true)
    expect(consumeToken(bucket, 2, 1, 1000)).toBe(false)
    expect(consumeToken(bucket, 2, 1, 2000)).toBe(true)
    expect(consumeToken(bucket, 2, 1, 2000)).toBe(false)
  })

  it('caps refilled tokens at capacity', () => {
    const bucket = createTokenBucket(2, 1000)

    expect(consumeToken(bucket, 2, 1, 1000)).toBe(true)
    expect(consumeToken(bucket, 2, 1, 10_000)).toBe(true)
    expect(consumeToken(bucket, 2, 1, 10_000)).toBe(true)
    expect(consumeToken(bucket, 2, 1, 10_000)).toBe(false)
  })
})
