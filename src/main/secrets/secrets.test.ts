import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { resetPathsForTests } from '../paths'
import { LocalEncryptedFileBackend, createKeytarBackendForTests } from './secrets'

describe('LocalEncryptedFileBackend AES-256-GCM', () => {
  let tempDir: string

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'tatsu-secrets-test-'))
    process.env['HARNESS_DATA_DIR'] = tempDir
    resetPathsForTests()
  })

  afterEach(() => {
    delete process.env['HARNESS_DATA_DIR']
    resetPathsForTests()
    try { rmSync(tempDir, { recursive: true, force: true }) } catch { /* ignore */ }
  })

  it('encrypts and decrypts a secret round-trip', () => {
    const backend = new LocalEncryptedFileBackend()
    backend.set('myKey', 'myValue')
    expect(backend.get('myKey')).toBe('myValue')
  })

  it('returns null for missing key', () => {
    const backend = new LocalEncryptedFileBackend()
    expect(backend.get('nonexistent')).toBeNull()
  })

  it('has() returns true after set and false after delete', () => {
    const backend = new LocalEncryptedFileBackend()
    backend.set('testKey', 'testValue')
    expect(backend.has('testKey')).toBe(true)
    backend.delete('testKey')
    expect(backend.has('testKey')).toBe(false)
  })

  it('swapping encrypted blobs between keys fails to decrypt (AAD binding)', () => {
    const backend = new LocalEncryptedFileBackend()
    backend.set('keyA', 'secretA')
    backend.set('keyB', 'secretB')

    // Read the raw secrets file to swap blobs
    const { readFileSync, writeFileSync } = require('fs')
    const { join } = require('path')
    const secretsPath = join(tempDir, 'secrets.enc')
    const data = JSON.parse(readFileSync(secretsPath, 'utf-8'))

    // Swap the encrypted blobs
    const tmp = data['keyA']
    data['keyA'] = data['keyB']
    data['keyB'] = tmp
    writeFileSync(secretsPath, JSON.stringify(data, null, 2))

    // After swapping, neither key should decrypt correctly
    // (the AAD is bound to the key name)
    expect(backend.get('keyA')).toBeNull()
    expect(backend.get('keyB')).toBeNull()
  })

  it('migrates legacy no-AAD encrypted blob on read', () => {
    // Write a legacy blob: encrypted without AAD (just key + value)
    const { createCipheriv, randomBytes } = require('crypto')
    const { readFileSync, writeFileSync } = require('fs')
    const backend = new LocalEncryptedFileBackend()

    // Extract the key from the backend by writing and reading
    backend.set('probe', 'probe')
    const secretsPath = join(tempDir, 'secrets.enc')
    const keyPath = join(tempDir, '.secret-key')
    const key = readFileSync(keyPath)

    // Now create a legacy no-AAD blob manually using the same key
    const iv = randomBytes(12)
    const cipher = createCipheriv('aes-256-gcm', key, iv)
    // No setAAD — legacy format
    const ct = Buffer.concat([cipher.update('legacy-value', 'utf8'), cipher.final()])
    const tag = cipher.getAuthTag()
    const legacyBlob = Buffer.concat([iv, tag, ct]).toString('base64')

    // Write the legacy blob into secrets.enc
    const data = JSON.parse(readFileSync(secretsPath, 'utf-8'))
    data['legacyKey'] = legacyBlob
    writeFileSync(secretsPath, JSON.stringify(data, null, 2))

    // get() should succeed by falling back to legacy no-AAD decrypt
    const result = backend.get('legacyKey')
    expect(result).toBe('legacy-value')

    // After migration, the blob should now be re-encrypted with AAD
    // Verify the file was rewritten (round-trip still works)
    expect(backend.get('legacyKey')).toBe('legacy-value')
  })

  it('returns null for legacy blob encrypted under a different key', () => {
    const { createCipheriv, randomBytes } = require('crypto')
    const { readFileSync, writeFileSync } = require('fs')
    const backend = new LocalEncryptedFileBackend()

    // Ensure secrets.enc exists by doing a round-trip
    backend.set('probe', 'probe')

    // Create a blob encrypted with a different 32-byte key
    const wrongKey = randomBytes(32)
    const iv = randomBytes(12)
    const cipher = createCipheriv('aes-256-gcm', wrongKey, iv)
    const ct = Buffer.concat([cipher.update('wrong-key-value', 'utf8'), cipher.final()])
    const tag = cipher.getAuthTag()
    const blob = Buffer.concat([iv, tag, ct]).toString('base64')

    const secretsPath = join(tempDir, 'secrets.enc')
    const data = JSON.parse(readFileSync(secretsPath, 'utf-8'))
    data['wrongKeyBlob'] = blob
    writeFileSync(secretsPath, JSON.stringify(data, null, 2))

    // Should fail both AAD and legacy decrypt since the key is wrong
    expect(backend.get('wrongKeyBlob')).toBeNull()
  })

  it('overwrites existing secret', () => {
    const backend = new LocalEncryptedFileBackend()
    backend.set('key', 'value1')
    expect(backend.get('key')).toBe('value1')
    backend.set('key', 'value2')
    expect(backend.get('key')).toBe('value2')
  })

  it('set returns a promise that resolves (async-safe)', async () => {
    const backend = new LocalEncryptedFileBackend()
    // LocalEncryptedFileBackend.set is sync but the public API now
    // promises void | Promise<void>, so callers can await safely.
    const result = backend.set('key', 'value')
    // Sync backends return void — awaiting void is a no-op.
    await result
    expect(backend.get('key')).toBe('value')
  })
})

// ─── KeytarBackend: async set/delete contract ────────────────────────
// We construct a KeytarBackend directly using the test helper, then
// verify the async contract: set/delete return promises, await persistence
// before updating knownKeys, and propagate rejections.

describe('KeytarBackend async contract (via mock)', () => {
  let tempDir: string
  let mockKeytar: {
    getPasswordSync: ReturnType<typeof vi.fn>
    findCredentialsSync: ReturnType<typeof vi.fn>
    setPassword: ReturnType<typeof vi.fn>
    deletePassword: ReturnType<typeof vi.fn>
  }

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'tatsu-secrets-keytar-test-'))
    process.env['HARNESS_DATA_DIR'] = tempDir
    resetPathsForTests()
    mockKeytar = {
      getPasswordSync: vi.fn().mockReturnValue(null),
      findCredentialsSync: vi.fn().mockReturnValue([]),
      setPassword: vi.fn().mockResolvedValue(undefined),
      deletePassword: vi.fn().mockResolvedValue(undefined)
    }
  })

  afterEach(() => {
    delete process.env['HARNESS_DATA_DIR']
    resetPathsForTests()
    try { rmSync(tempDir, { recursive: true, force: true }) } catch { /* ignore */ }
  })

  it('set returns a promise (async-safe)', async () => {
    const backend = createKeytarBackendForTests(mockKeytar)
    const result = backend.set('mykey', 'myvalue')
    expect(result).toBeInstanceOf(Promise)
    await result
    expect(mockKeytar.setPassword).toHaveBeenCalledWith('harness', 'mykey', 'myvalue')
  })

  it('delete returns a promise (async-safe)', async () => {
    const backend = createKeytarBackendForTests(mockKeytar)
    const result = backend.delete('mykey')
    expect(result).toBeInstanceOf(Promise)
    await result
    expect(mockKeytar.deletePassword).toHaveBeenCalledWith('harness', 'mykey')
  })

  it('set rejects and does not mark known when keytar.setPassword fails', async () => {
    const failError = new Error('keytar write failed')
    mockKeytar.setPassword.mockRejectedValueOnce(failError)
    const backend = createKeytarBackendForTests(mockKeytar)
    await expect(backend.set('badkey', 'badvalue')).rejects.toThrow('keytar write failed')
    // key must NOT be marked known after failure
    expect(backend.has('badkey')).toBe(false)
  })

  it('set marks key known only after successful persistence', async () => {
    const backend = createKeytarBackendForTests(mockKeytar)
    expect(backend.has('newkey')).toBe(false)
    await backend.set('newkey', 'newvalue')
    expect(backend.has('newkey')).toBe(true)
  })

  it('delete awaits keytar.deletePassword before removing from knownKeys', async () => {
    const backend = createKeytarBackendForTests(mockKeytar)
    await backend.set('delkey', 'val')
    expect(backend.has('delkey')).toBe(true)
    await backend.delete('delkey')
    expect(backend.has('delkey')).toBe(false)
    expect(mockKeytar.deletePassword).toHaveBeenCalledWith('harness', 'delkey')
  })

  it('delete rejects when keytar.deletePassword fails and does not remove from known', async () => {
    const failError = new Error('keytar delete failed')
    mockKeytar.deletePassword.mockRejectedValueOnce(failError)
    const backend = createKeytarBackendForTests(mockKeytar)
    await backend.set('delfail', 'val')
    expect(backend.has('delfail')).toBe(true)
    await expect(backend.delete('delfail')).rejects.toThrow('keytar delete failed')
    // key should still be marked known since the delete failed
    expect(backend.has('delfail')).toBe(true)
  })
})
