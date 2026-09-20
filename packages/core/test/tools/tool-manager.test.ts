import { describe, expect, test } from 'bun:test'
import type { ToolLockEntry } from '../../src/profile'
import {
  type ArtifactSource,
  type AtomicToolFilesystem,
  ToolManager,
  type ToolUnpacker,
} from '../../src/tools'

const artifact = new TextEncoder().encode('ripgrep artifact')
const artifactHash = '6ac91ca94709408e1f06af5638e77fc300c6197b901b1c4e97f16ad513895b28'

function lock(overrides: Partial<ToolLockEntry> = {}): ToolLockEntry {
  return {
    name: 'ripgrep',
    platform: 'darwin',
    arch: 'arm64',
    version: '14.1.1',
    url: 'https://tools.example/ripgrep.tar.gz?download_token=secret',
    sha256: artifactHash,
    ...overrides,
  }
}

function harness(bytes: Uint8Array = artifact) {
  const events: string[] = []
  const receipts = new Map<string, { sha256: string; sourceHost: string }>()
  const artifacts: ArtifactSource = {
    async download(url) {
      events.push(`download:${new URL(url).hostname}`)
      return { bytes, finalUrl: url, redirects: [] }
    },
  }
  const files: AtomicToolFilesystem = {
    async stage(destination) {
      events.push(`stage:${destination}`)
      return `${destination}.partial`
    },
    async commit(staging, destination) {
      events.push(`commit:${staging}->${destination}`)
      const receipt = receipts.get(staging)
      if (receipt !== undefined) {
        receipts.delete(staging)
        receipts.set(destination, receipt)
      }
    },
    async discard(staging) {
      events.push(`discard:${staging}`)
    },
    async readReceipt(destination) {
      events.push(`receipt:${destination}`)
      return receipts.get(destination) ?? null
    },
    async writeReceipt(staging, receipt) {
      events.push(`write-receipt:${staging}`)
      receipts.set(staging, receipt)
    },
  }
  const unpacker: ToolUnpacker = {
    async unpack(input) {
      events.push(`unpack:${input.destination}`)
    },
  }
  return { artifacts, events, files, receipts, unpacker }
}

describe('ToolManager', () => {
  test('installs only exact target pins into a session directory', async () => {
    const io = harness()
    const manager = new ToolManager(
      [
        lock(),
        lock({ arch: 'x64', sha256: '1'.repeat(64) }),
        lock({ platform: 'win32', sha256: '2'.repeat(64) }),
      ],
      io,
    )

    const installed = await manager.install({
      platform: 'darwin',
      architecture: 'arm64',
      target: { kind: 'session', root: '/private/session/tools' },
    })

    expect(installed).toEqual([
      {
        name: 'ripgrep',
        platform: 'darwin',
        architecture: 'arm64',
        version: '14.1.1',
        sourceHost: 'tools.example',
        integrity: 'verified',
        target: 'session',
        directory: '/private/session/tools/ripgrep/14.1.1/darwin-arm64',
      },
    ])
    expect(io.events).toEqual([
      'download:tools.example',
      'stage:/private/session/tools/ripgrep/14.1.1/darwin-arm64',
      'unpack:/private/session/tools/ripgrep/14.1.1/darwin-arm64.partial',
      'commit:/private/session/tools/ripgrep/14.1.1/darwin-arm64.partial->/private/session/tools/ripgrep/14.1.1/darwin-arm64',
    ])
    const serialized = JSON.stringify(installed)
    expect(serialized).not.toContain('download_token')
    expect(serialized).not.toContain(artifactHash)
    expect(serialized).not.toContain('secret')
  })

  test('verifies every checksum before starting an install', async () => {
    const io = harness()
    const manager = new ToolManager([lock(), lock({ name: 'zoxide', sha256: '9'.repeat(64) })], io)

    await expect(
      manager.install({
        platform: 'darwin',
        architecture: 'arm64',
        target: { kind: 'cache', root: '/managed/cache' },
      }),
    ).rejects.toThrow('checksum mismatch for tool zoxide')
    expect(io.events).toEqual([
      'receipt:/managed/cache/ripgrep/14.1.1/darwin-arm64',
      'download:tools.example',
      'receipt:/managed/cache/zoxide/14.1.1/darwin-arm64',
      'download:tools.example',
    ])
  })

  test('rejects non-HTTPS artifact sources before downloading', () => {
    const io = harness()

    expect(
      () => new ToolManager([lock({ url: 'http://tools.example/ripgrep.tar.gz' })], io),
    ).toThrow('tool ripgrep requires an HTTPS source')
    expect(io.events).toEqual([])
  })

  test('rejects a redirect chain that leaves HTTPS', async () => {
    const io = harness()
    io.artifacts.download = async () => {
      io.events.push('download:tools.example')
      return {
        bytes: artifact,
        finalUrl: 'http://mirror.example/ripgrep.tar.gz',
        redirects: ['https://cdn.example/ripgrep.tar.gz', 'http://mirror.example/ripgrep.tar.gz'],
      }
    }
    const manager = new ToolManager([lock()], io)

    await expect(
      manager.install({
        platform: 'darwin',
        architecture: 'arm64',
        target: { kind: 'session', root: '/private/session/tools' },
      }),
    ).rejects.toThrow('tool ripgrep followed a non-HTTPS redirect')
    expect(io.events).toEqual(['download:tools.example'])
  })

  test('keeps the pinned archive name when the final CDN URL has no extension', async () => {
    const io = harness()
    io.artifacts.download = async () => ({
      bytes: artifact,
      finalUrl: 'https://release-assets.example/artifact-id?signature=secret',
      redirects: ['https://release-assets.example/artifact-id?signature=secret'],
    })
    io.unpacker.unpack = async (input) => {
      io.events.push(`unpack:${input.sourceName}`)
    }
    const manager = new ToolManager(
      [lock({ url: 'https://github.com/example/tool/releases/download/v1.0.0/tool.tar.gz' })],
      io,
    )

    await manager.install({
      platform: 'darwin',
      architecture: 'arm64',
      target: { kind: 'session', root: '/private/session/tools' },
    })

    expect(io.events).toContain('unpack:tool.tar.gz')
  })

  test('rejects duplicate pins for the same tool target', () => {
    const io = harness()

    expect(() => new ToolManager([lock(), lock({ version: '14.1.2' })], io)).toThrow(
      'duplicate tool pin: ripgrep/darwin/arm64',
    )
    expect(io.events).toEqual([])
  })

  test('rejects version aliases and ranges instead of treating them as pins', () => {
    const io = harness()

    for (const version of ['latest', '*', '^14.1.0', '14.x']) {
      expect(() => new ToolManager([lock({ version })], io)).toThrow(
        'tool ripgrep has an unpinned version',
      )
    }
  })

  test('rejects locks for unsupported client targets', () => {
    const io = harness()

    expect(
      () => new ToolManager([lock({ platform: 'linux' as ToolLockEntry['platform'] })], io),
    ).toThrow('tool ripgrep has an unsupported platform: linux')
    expect(() => new ToolManager([lock({ arch: 'ia32' })], io)).toThrow(
      'tool ripgrep has an unsupported architecture: ia32',
    )
  })

  test('rejects unsupported install targets instead of returning an empty selection', async () => {
    const io = harness()
    const manager = new ToolManager([lock()], io)

    await expect(
      manager.install({
        platform: 'linux' as 'darwin',
        architecture: 'arm64',
        target: { kind: 'session', root: '/private/session/tools' },
      }),
    ).rejects.toThrow('unsupported install platform: linux')
    await expect(
      manager.install({
        platform: 'darwin',
        architecture: 'ia32' as 'arm64',
        target: { kind: 'session', root: '/private/session/tools' },
      }),
    ).rejects.toThrow('unsupported install architecture: ia32')
    expect(io.events).toEqual([])
  })

  test('rejects unsafe names and invalid integrity pins', () => {
    const io = harness()

    expect(() => new ToolManager([lock({ name: '../ripgrep' })], io)).toThrow(
      'tool name is invalid: ../ripgrep',
    )
    expect(() => new ToolManager([lock({ sha256: 'unverified' })], io)).toThrow(
      'tool ripgrep has an invalid sha256 pin',
    )
  })

  test('keeps a validated lock snapshot when the caller mutates its input', async () => {
    const io = harness()
    const mutableLock = lock()
    const manager = new ToolManager([mutableLock], io)
    mutableLock.name = '../escape'

    const installed = await manager.install({
      platform: 'darwin',
      architecture: 'arm64',
      target: { kind: 'session', root: '/private/session/tools' },
    })

    expect(installed[0]?.name).toBe('ripgrep')
    expect(installed[0]?.directory).toBe('/private/session/tools/ripgrep/14.1.1/darwin-arm64')
  })

  test('discards staging data when unpacking fails', async () => {
    const io = harness()
    io.unpacker.unpack = async (input) => {
      io.events.push(`unpack:${input.destination}`)
      throw new Error('unsupported archive')
    }
    const manager = new ToolManager([lock()], io)

    await expect(
      manager.install({
        platform: 'darwin',
        architecture: 'arm64',
        target: { kind: 'cache', root: '/managed/cache' },
      }),
    ).rejects.toThrow('unsupported archive')
    expect(io.events).toEqual([
      'receipt:/managed/cache/ripgrep/14.1.1/darwin-arm64',
      'download:tools.example',
      'stage:/managed/cache/ripgrep/14.1.1/darwin-arm64',
      'unpack:/managed/cache/ripgrep/14.1.1/darwin-arm64.partial',
      'discard:/managed/cache/ripgrep/14.1.1/darwin-arm64.partial',
    ])
  })

  test('reports cache installations without exposing the artifact lock', async () => {
    const io = harness()
    const manager = new ToolManager([lock()], io)

    const [installed] = await manager.install({
      platform: 'darwin',
      architecture: 'arm64',
      target: { kind: 'cache', root: '/managed/cache' },
    })

    expect(installed?.target).toBe('cache')
    expect(installed?.directory).toBe('/managed/cache/ripgrep/14.1.1/darwin-arm64')
    expect(installed).not.toHaveProperty('url')
    expect(installed).not.toHaveProperty('sha256')
  })

  test('reuses a matching verified cache receipt without downloading again', async () => {
    const io = harness()
    const destination = '/managed/cache/ripgrep/14.1.1/darwin-arm64'
    io.receipts.set(destination, { sha256: artifactHash, sourceHost: 'cdn.tools.example' })
    const manager = new ToolManager([lock()], io)

    const installed = await manager.install({
      platform: 'darwin',
      architecture: 'arm64',
      target: { kind: 'cache', root: '/managed/cache' },
    })

    expect(installed).toEqual([
      {
        name: 'ripgrep',
        platform: 'darwin',
        architecture: 'arm64',
        version: '14.1.1',
        sourceHost: 'cdn.tools.example',
        integrity: 'verified',
        target: 'cache',
        directory: destination,
      },
    ])
    expect(io.events).toEqual([`receipt:${destination}`])
  })

  test('records a verified cache install so the next launch reuses it', async () => {
    const io = harness()
    const destination = '/managed/cache/ripgrep/14.1.1/darwin-arm64'
    const manager = new ToolManager([lock()], io)
    const request = {
      platform: 'darwin' as const,
      architecture: 'arm64' as const,
      target: { kind: 'cache' as const, root: '/managed/cache' },
    }

    await manager.install(request)
    await manager.install(request)

    expect(io.events).toEqual([
      `receipt:${destination}`,
      'download:tools.example',
      `stage:${destination}`,
      `unpack:${destination}.partial`,
      `write-receipt:${destination}.partial`,
      `commit:${destination}.partial->${destination}`,
      `receipt:${destination}`,
    ])
  })

  test('produces a stable redacted diff for a lock update', () => {
    const io = harness()
    const manager = new ToolManager(
      [
        lock({ name: 'zoxide', version: '0.9.8', sha256: '4'.repeat(64) }),
        lock(),
        lock({ platform: 'win32', arch: 'x64', sha256: '5'.repeat(64) }),
      ],
      io,
    )

    const changes = manager.diff([
      lock({ platform: 'win32', arch: 'x64', sha256: '5'.repeat(64) }),
      lock({
        name: 'bun',
        version: '1.3.14',
        url: 'https://releases.example/bun.zip?signature=private',
        sha256: '6'.repeat(64),
      }),
      lock({
        version: '14.1.2',
        url: 'https://mirror.example/ripgrep.tar.gz?signature=private',
        sha256: '7'.repeat(64),
      }),
    ])

    expect(changes).toEqual([
      {
        kind: 'add',
        after: {
          name: 'bun',
          platform: 'darwin',
          architecture: 'arm64',
          version: '1.3.14',
          sourceHost: 'releases.example',
          integrity: 'sha256-pinned',
        },
      },
      {
        kind: 'update',
        changed: ['version', 'source', 'integrity'],
        before: {
          name: 'ripgrep',
          platform: 'darwin',
          architecture: 'arm64',
          version: '14.1.1',
          sourceHost: 'tools.example',
          integrity: 'sha256-pinned',
        },
        after: {
          name: 'ripgrep',
          platform: 'darwin',
          architecture: 'arm64',
          version: '14.1.2',
          sourceHost: 'mirror.example',
          integrity: 'sha256-pinned',
        },
      },
      {
        kind: 'remove',
        before: {
          name: 'zoxide',
          platform: 'darwin',
          architecture: 'arm64',
          version: '0.9.8',
          sourceHost: 'tools.example',
          integrity: 'sha256-pinned',
        },
      },
    ])
    const serialized = JSON.stringify(changes)
    expect(serialized).not.toContain('signature')
    expect(serialized).not.toContain('private')
    expect(serialized).not.toContain('7777777777')
  })
})
