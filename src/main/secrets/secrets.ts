// Pluggable secrets storage. `getSecret` and `hasSecret` are synchronous;
// `setSecret` and `deleteSecret` are async/awaitable so callers can
// observe persistence completion.
//
// Backends (chosen at first use):
//   1. Electron mode → safeStorage. OS keychain-backed encryption,
//      same on-disk layout (`secrets.enc` JSON of base64 ciphertext) as
//      the original implementation, so an upgrading user's tokens
//      decrypt as before.
//   2. Headless + keytar available → keytar. OS keychain entries under
//      service `harness`, account = secret key. Nothing on disk.
//   3. Headless + no keytar → AES-256-GCM with a random key file at
//      `<userData>/.secret-key` (mode 0600). The `secrets.enc` file
//      stores `iv(12) || tag(16) || ciphertext`, base64-encoded per
//      key. This is dev/self-hosted only — a host with shell access can
//      trivially read both files. Not suitable for hosted multi-tenant.
//
// `keytar` is loaded via dynamic require so a missing native binding
// (Alpine, Docker without keytar deps, etc.) just falls through to the
// file backend instead of failing the boot.

import { createCipheriv, createDecipheriv, randomBytes } from 'crypto'
import { chmodSync, existsSync, readFileSync, writeFileSync } from 'fs'
import { createRequire } from 'module'
import { join } from 'path'
import { detectRuntime, userDataDir } from '../paths'
import { log } from '../debug'

interface SecretsBackend {
  set(key: string, value: string): void | Promise<void>
  get(key: string): string | null
  has(key: string): boolean
  delete(key: string): void | Promise<void>
}

interface SecretsFile {
  [key: string]: string
}

function readSecretsFile(): SecretsFile {
  const p = join(userDataDir(), 'secrets.enc')
  if (!existsSync(p)) return {}
  try {
    return JSON.parse(readFileSync(p, 'utf-8'))
  } catch (err) {
    log('secrets', 'failed to read secrets file', err instanceof Error ? err.message : err)
    return {}
  }
}

function writeSecretsFile(data: SecretsFile): void {
  const p = join(userDataDir(), 'secrets.enc')
  try {
    writeFileSync(p, JSON.stringify(data, null, 2), { mode: 0o600 })
  } catch (err) {
    log('secrets', 'failed to write secrets file', err instanceof Error ? err.message : err)
  }
}

class SafeStorageBackend implements SecretsBackend {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  constructor(private readonly safeStorage: any) {}

  set(key: string, value: string): void {
    if (!this.safeStorage.isEncryptionAvailable()) {
      log('secrets', 'safeStorage encryption not available, refusing to store')
      return
    }
    const data = readSecretsFile()
    data[key] = this.safeStorage.encryptString(value).toString('base64')
    writeSecretsFile(data)
  }

  get(key: string): string | null {
    if (!this.safeStorage.isEncryptionAvailable()) return null
    const data = readSecretsFile()
    const encrypted = data[key]
    if (!encrypted) return null
    try {
      return this.safeStorage.decryptString(Buffer.from(encrypted, 'base64'))
    } catch (err) {
      log('secrets', `failed to decrypt secret ${key}`, err instanceof Error ? err.message : err)
      return null
    }
  }

  has(key: string): boolean {
    const data = readSecretsFile()
    return key in data && !!data[key]
  }

  delete(key: string): void {
    const data = readSecretsFile()
    delete data[key]
    writeSecretsFile(data)
  }
}

class KeytarBackend implements SecretsBackend {
  private static readonly SERVICE = 'harness'
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private readonly keytar: any
  private readonly knownKeys = new Set<string>()
  // Synchronous index of which keys exist. Loaded once at construction;
  // updated on every set/delete.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  constructor(keytar: any) {
    this.keytar = keytar
    try {
      const list = keytar.findCredentialsSync?.(KeytarBackend.SERVICE)
      if (Array.isArray(list)) for (const c of list) this.knownKeys.add(c.account)
    } catch (err) {
      log('secrets', 'keytar findCredentialsSync failed (non-fatal)', err instanceof Error ? err.message : err)
    }
  }

  async set(key: string, value: string): Promise<void> {
    try {
      await this.keytar.setPassword(KeytarBackend.SERVICE, key, value)
    } catch (err) {
      log('secrets', `keytar set failed for ${key}`, err instanceof Error ? err.message : err)
      throw err
    }
    this.knownKeys.add(key)
  }

  get(key: string): string | null {
    try {
      if (typeof this.keytar.getPasswordSync === 'function') {
        const v = this.keytar.getPasswordSync(KeytarBackend.SERVICE, key)
        return v ?? null
      }
      log('secrets', 'keytar getPasswordSync unavailable on this platform — get returns null')
      return null
    } catch (err) {
      log('secrets', `keytar get failed for ${key}`, err instanceof Error ? err.message : err)
      return null
    }
  }

  has(key: string): boolean {
    return this.knownKeys.has(key)
  }

  async delete(key: string): Promise<void> {
    try {
      await this.keytar.deletePassword(KeytarBackend.SERVICE, key)
    } catch (err) {
      log('secrets', `keytar delete failed for ${key}`, err instanceof Error ? err.message : err)
      throw err
    }
    this.knownKeys.delete(key)
  }
}

export class LocalEncryptedFileBackend implements SecretsBackend {
  private readonly key: Buffer

  constructor() {
    this.key = this.loadOrCreateKey()
  }

  private loadOrCreateKey(): Buffer {
    const p = join(userDataDir(), '.secret-key')
    if (existsSync(p)) {
      const buf = readFileSync(p)
      if (buf.length === 32) return buf
      log('secrets', 'existing .secret-key is malformed; regenerating')
    }
    const fresh = randomBytes(32)
    writeFileSync(p, fresh, { mode: 0o600 })
    try { chmodSync(p, 0o600) } catch { /* ignore */ }
    return fresh
  }

  set(key: string, value: string): void {
    const data = readSecretsFile()
    const iv = randomBytes(12)
    const cipher = createCipheriv('aes-256-gcm', this.key, iv)
    cipher.setAAD(Buffer.from(key, 'utf8'))
    const ct = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()])
    const tag = cipher.getAuthTag()
    data[key] = Buffer.concat([iv, tag, ct]).toString('base64')
    writeSecretsFile(data)
  }

  get(key: string): string | null {
    const data = readSecretsFile()
    const blob = data[key]
    if (!blob) return null
    try {
      const buf = Buffer.from(blob, 'base64')
      if (buf.length < 12 + 16 + 1) return null
      const iv = buf.subarray(0, 12)
      const tag = buf.subarray(12, 28)
      const ct = buf.subarray(28)

      // Try AAD-bound decrypt first (current format)
      try {
        const decipher = createDecipheriv('aes-256-gcm', this.key, iv)
        decipher.setAAD(Buffer.from(key, 'utf8'))
        decipher.setAuthTag(tag)
        return Buffer.concat([decipher.update(ct), decipher.final()]).toString('utf8')
      } catch {
        // AAD-bound decrypt failed — fall through to legacy no-AAD attempt
      }

      // Legacy format: blob was encrypted without AAD. Decrypt and
      // re-encrypt under the current AAD-bound format so subsequent
      // reads hit the fast path.
      try {
        const decipher = createDecipheriv('aes-256-gcm', this.key, iv)
        // No setAAD — legacy format
        decipher.setAuthTag(tag)
        const plaintext = Buffer.concat([decipher.update(ct), decipher.final()]).toString('utf8')
        // Migrate: re-encrypt with AAD so future reads don't need
        // the legacy fallback. Errors here are non-fatal (we still
        // return the plaintext).
        try {
          this.set(key, plaintext)
        } catch {
          log('secrets', `failed to migrate legacy secret ${key} to AAD-bound format`)
        }
        return plaintext
      } catch {
        // Both AAD and legacy decrypt failed — corrupt or wrong key
      }

      log('secrets', `failed to decrypt secret ${key} (both AAD and legacy formats failed)`)
      return null
    } catch (err) {
      log('secrets', `failed to decrypt secret ${key}`, err instanceof Error ? err.message : err)
      return null
    }
  }

  has(key: string): boolean {
    const data = readSecretsFile()
    return key in data && !!data[key]
  }

  delete(key: string): void {
    const data = readSecretsFile()
    delete data[key]
    writeSecretsFile(data)
  }
}

let backendCache: SecretsBackend | null = null

function pickBackend(): SecretsBackend {
  if (backendCache) return backendCache
  const dynamicRequire = createRequire(__filename)
  if (detectRuntime() === 'electron') {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { safeStorage } = dynamicRequire('electron') as any
    backendCache = new SafeStorageBackend(safeStorage)
    return backendCache
  }
  // Headless: try keytar dynamically. Native modules are fragile in
  // Docker/Alpine/CI — fall through to the file backend on any load
  // error, including the binding being missing entirely.
  try {
    const keytar = dynamicRequire('keytar')
    if (typeof keytar.getPasswordSync !== 'function' || typeof keytar.findCredentialsSync !== 'function') {
      log('secrets', 'keytar sync methods unavailable; falling back to local encrypted file backend')
      throw new Error('keytar sync methods unavailable')
    }
    backendCache = new KeytarBackend(keytar)
    log('secrets', 'using keytar backend')
    return backendCache
  } catch {
    // Expected when keytar isn't installed.
  }
  backendCache = new LocalEncryptedFileBackend()
  log('secrets', 'using local encrypted file backend (dev/self-hosted only)')
  return backendCache
}

/** Store a secret. Returns a promise so callers can await persistence. */
export async function setSecret(key: string, value: string): Promise<void> {
  await pickBackend().set(key, value)
}

/** Retrieve a secret, or null if absent. */
export function getSecret(key: string): string | null {
  return pickBackend().get(key)
}

/** Check if a secret exists without decrypting it. */
export function hasSecret(key: string): boolean {
  return pickBackend().has(key)
}

/** Remove a secret. Returns a promise so callers can await persistence. */
export async function deleteSecret(key: string): Promise<void> {
  await pickBackend().delete(key)
}

/** Test-only: reset the backend cache so a fresh `pickBackend` runs. */
export function resetSecretsBackendForTests(): void {
  backendCache = null
}

/** Test-only: create a KeytarBackend with a mock keytar for unit tests. */
export function createKeytarBackendForTests(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  keytar: any
): SecretsBackend {
  return new KeytarBackend(keytar)
}
