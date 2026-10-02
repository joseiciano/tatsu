import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { readAttachmentImage, writeAttachmentImage } from '.'
import { existsSync, mkdirSync, rmSync, symlinkSync, unlinkSync, writeFileSync as writeFileSyncSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'

const ATTACHMENT_DIR = join(tmpdir(), 'harness-attachments')

describe('readAttachmentImage', () => {
  beforeAll(() => {
    if (!existsSync(ATTACHMENT_DIR)) {
      mkdirSync(ATTACHMENT_DIR, { recursive: true, mode: 0o700 })
    }
  })

  afterAll(() => {
    // Only clean up files we created, not the whole dir
    // (other tests may share it)
  })

  it('returns base64 data for a valid file inside ATTACHMENT_DIR', () => {
    const savedPath = writeAttachmentImage(
      Buffer.from('hello-image-content').toString('base64'),
      'image/png'
    )
    expect(savedPath).toContain(ATTACHMENT_DIR)

    const result = readAttachmentImage(savedPath)
    expect(result).toBe(Buffer.from('hello-image-content').toString('base64'))
  })

  it('returns null for path outside ATTACHMENT_DIR (path traversal)', () => {
    const result = readAttachmentImage('/tmp/../../etc/passwd')
    expect(result).toBeNull()
  })

  it('returns null for absolute path not under ATTACHMENT_DIR', () => {
    const result = readAttachmentImage('/some/other/path/image.png')
    expect(result).toBeNull()
  })

  it('returns null for non-existent file', () => {
    const result = readAttachmentImage(join(ATTACHMENT_DIR, 'does-not-exist.png'))
    expect(result).toBeNull()
  })

  it('returns null when ATTACHMENT_DIR itself is passed as a directory', () => {
    const result = readAttachmentImage(ATTACHMENT_DIR)
    expect(result).toBeNull()
  })

  it('returns null for symlink inside ATTACHMENT_DIR pointing outside', () => {
    // Create a real target file outside the attachment dir
    const targetFile = join(tmpdir(), 'harness-attachment-escape-target.txt')
    writeFileSyncSync(targetFile, 'escape-test-content')

    const symlinkPath = join(ATTACHMENT_DIR, `escape-symlink-${Date.now()}.txt`)
    try {
      symlinkSync(targetFile, symlinkPath)
      const result = readAttachmentImage(symlinkPath)
      expect(result).toBeNull()
    } finally {
      // Clean up
      try { unlinkSync(symlinkPath) } catch { /* may not exist */ }
      try { unlinkSync(targetFile) } catch { /* may not exist */ }
    }
  })

  it('returns base64 data for symlink inside ATTACHMENT_DIR pointing to a file also inside ATTACHMENT_DIR', () => {
    // Write a real file inside ATTACHMENT_DIR
    const realFile = join(ATTACHMENT_DIR, `real-${Date.now()}.png`)
    const content = Buffer.from('symlink-inside-content').toString('base64')
    writeFileSyncSync(realFile, Buffer.from(content, 'base64'), { mode: 0o600 })

    const symlinkPath = join(ATTACHMENT_DIR, `link-${Date.now()}.png`)
    try {
      symlinkSync(realFile, symlinkPath)
      const result = readAttachmentImage(symlinkPath)
      expect(result).toBe(content)
    } finally {
      try { unlinkSync(symlinkPath) } catch { /* may not exist */ }
      try { unlinkSync(realFile) } catch { /* may not exist */ }
    }
  })
})
