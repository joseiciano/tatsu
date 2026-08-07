import { describe, it, expect, vi } from 'vitest'
import { resolveBundledRuntimes, spawnBounded } from './smoke-bundled-runtimes.mjs'

const FAKE_ROOT = '/opt/harness'

function fakeResolve(id) {
  const map = {
    '@agentclientprotocol/codex-acp/dist/index.js': `${FAKE_ROOT}/node_modules/@agentclientprotocol/codex-acp/dist/index.js`,
    '@openai/codex/package.json': `${FAKE_ROOT}/node_modules/@openai/codex/package.json`
  }
  const hit = map[id]
  if (!hit) throw new Error(`not found: ${id}`)
  return hit
}

// Stub the codex platform package resolution that uses createRequire under the
// hood by injecting execRoot pointing at a fake tree with real node_modules.
// The default createRequire path won't hit the fake root, so instead we only
// assert opencode + codexScript + platform skip paths here, and cover the
// codex native path via the real install in runBundledRuntimeSmoke integration.
describe('resolveBundledRuntimes', () => {
  it('skips cleanly on an unsupported platform', () => {
    const r = resolveBundledRuntimes({ platform: 'win32', arch: 'x64' })
    expect(r.supported).toBe(false)
    expect(r.reason).toContain('unsupported platform')
  })

  it('resolves the opencode launcher path', () => {
    const r = resolveBundledRuntimes({
      platform: 'darwin',
      arch: 'arm64',
      execRoot: FAKE_ROOT
    })
    expect(r.supported).toBe(true)
    expect(r.openCode).toBe(`${FAKE_ROOT}/node_modules/opencode-ai/bin/opencode.exe`)
  })
})

describe('spawnBounded', () => {
  it('resolves ok=true when the process stays alive through the grace window', async () => {
    const child = new (require('node:events').EventEmitter)()
    child.kill = vi.fn()
    const spawnFn = vi.fn(() => child)
    const promise = spawnBounded(['/bin/true'], {}, { spawnFn, bootGraceMs: 20 })
    child.emit('spawn')
    const result = await promise
    expect(result.ok).toBe(true)
    expect(child.kill).toHaveBeenCalled()
  })

  it('resolves ok=false when the process exits before the grace window', async () => {
    const child = new (require('node:events').EventEmitter)()
    child.kill = vi.fn()
    const spawnFn = vi.fn(() => child)
    const promise = spawnBounded(['/bin/true'], {}, { spawnFn, bootGraceMs: 5000 })
    child.emit('spawn')
    child.emit('exit', 1)
    const result = await promise
    expect(result.ok).toBe(false)
    expect(String(result.code)).toContain('exited 1')
  })
})
