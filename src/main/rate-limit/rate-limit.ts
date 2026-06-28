export interface TokenBucket {
  tokens: number
  updatedAt: number
}

export function createTokenBucket(capacity: number, now = Date.now()): TokenBucket {
  return { tokens: capacity, updatedAt: now }
}

export function consumeToken(
  bucket: TokenBucket,
  capacity: number,
  refillPerSecond: number,
  now = Date.now()
): boolean {
  const elapsedMs = Math.max(0, now - bucket.updatedAt)
  bucket.tokens = Math.min(capacity, bucket.tokens + (elapsedMs / 1000) * refillPerSecond)
  bucket.updatedAt = now
  if (bucket.tokens < 1) return false
  bucket.tokens -= 1
  return true
}
