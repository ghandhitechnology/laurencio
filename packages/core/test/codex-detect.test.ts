import { describe, expect, test } from 'bun:test'
import { codexAdapter, codexCredentialStorage, codexDetect } from '../src/adapters/codex'
import type { AdapterContext } from '../src/types'
import { buildCodexHome } from './helpers/codex-fixture'

function ctxWith(home: AdapterContext['home'], notes: string[]): AdapterContext {
  return {
    home,
    platform: 'darwin',
    env: {},
    probes: { codex: { installed: true, version: '0.155.0', notes } },
  }
}

describe('codex detect', () => {
  test('takes install state and version from the probe', () => {
    const detection = codexDetect(ctxWith('/Users/laurencio', []))
    expect(detection.installed).toBe(true)
    expect(detection.version).toBe('0.155.0')
    expect(detection.configRoots).toEqual([`\${CODEX_HOME}`])
  })

  test('reports an absent probe as not installed without touching the disk', () => {
    const detection = codexDetect({
      home: '/nonexistent-home/.codex',
      platform: 'darwin',
      env: {},
    })
    expect(detection.installed).toBe(false)
    expect(detection.version).toBeUndefined()
  })

  test('detects auth.json versus keyring from declared-path probe notes', () => {
    expect(
      codexCredentialStorage(ctxWith('/Users/laurencio', ['credential-storage: auth.json'])),
    ).toBe('auth.json')
    expect(
      codexCredentialStorage(ctxWith('/Users/laurencio', ['credential-storage: keyring'])),
    ).toBe('keyring')
    expect(codexCredentialStorage(ctxWith('/Users/laurencio', []))).toBe('unknown')
    const note = codexDetect(
      ctxWith('/Users/laurencio', ['credential-storage: auth.json']),
    ).notes.join('\n')
    expect(note).toContain('auth.json')
    expect(note).toContain('encrypted credential vault')
  })

  test('never reads credential values into the detection report', () => {
    const home = buildCodexHome()
    home.write('.codex/auth.json', '{"tokens":"CANARY-DO-NOT-REPORT"}')
    const detection = codexDetect(home.ctx)
    expect(JSON.stringify(detection)).not.toContain('CANARY-DO-NOT-REPORT')
    home.cleanup()
  })

  test('reports SQLite memory as unsupported with a reason', () => {
    const detection = codexDetect(ctxWith('/Users/laurencio', []))
    const memory = detection.notes.find((note) => note.includes('memory'))
    expect(memory).toContain(`\${CODEX_HOME}/memories_*.sqlite`)
    expect(memory).toContain('opaque SQLite store')
  })

  test('notes a CODEX_HOME override', () => {
    const ctx: AdapterContext = {
      home: '/Users/laurencio',
      platform: 'darwin',
      env: { CODEX_HOME: '/Volumes/scratch/codex' },
    }
    expect(codexDetect(ctx).notes).toContain('CODEX_HOME override: /Volumes/scratch/codex')
  })

  test('keeps the admin-layer surface off Windows paths', () => {
    const home = buildCodexHome()
    const darwin = codexAdapter.surfaces(home.ctx).map((surface) => surface.path)
    const windows = codexAdapter
      .surfaces({ ...home.ctx, platform: 'win32' })
      .map((surface) => surface.path)
    expect(darwin).toContain('/etc/codex')
    expect(windows).not.toContain('/etc/codex')
    home.cleanup()
  })
})
