import { describe, expect, test } from 'bun:test'
import {
  assertCuratedToolSelection,
  defaultToolLockFor,
  resolveToolLock,
  shippedToolLock,
  ToolManager,
} from '../../src/tools'

const inertDependencies = {
  artifacts: {
    async download(): Promise<never> {
      throw new Error('download should not run')
    },
  },
  files: {
    async stage(): Promise<never> {
      throw new Error('stage should not run')
    },
    async commit(): Promise<void> {},
    async discard(): Promise<void> {},
  },
  unpacker: {
    async unpack(): Promise<void> {},
  },
}

describe('shipped curated-tool catalog', () => {
  test('contains only the portable runtime artifacts available for supported clients', () => {
    const lock = shippedToolLock()

    expect(lock).toEqual([
      {
        name: 'tmux',
        platform: 'darwin',
        arch: 'arm64',
        version: '3.7c',
        url: 'https://github.com/tmux/tmux-builds/releases/download/v3.7c/tmux-3.7c-macos-arm64.tar.gz',
        sha256: '0a763dd0380aa980d239509654da1bc7455843706a3c050f6709c8cd2e13d12d',
      },
      {
        name: 'tmux',
        platform: 'darwin',
        arch: 'x64',
        version: '3.7c',
        url: 'https://github.com/tmux/tmux-builds/releases/download/v3.7c/tmux-3.7c-macos-x86_64.tar.gz',
        sha256: '1c21f9ade964e4a539be05ffe3a4e95854ab76a0a9c4c05d0ffbe7fc6c4d783f',
      },
      {
        name: 'powershell',
        platform: 'win32',
        arch: 'arm64',
        version: '7.6.6',
        url: 'https://github.com/PowerShell/PowerShell/releases/download/v7.6.6/PowerShell-7.6.6-win-arm64.zip',
        sha256: 'bbde9dda31d148415eccb5fbe1638e6400a144187b006e5b3fd8ec2f39d781be',
      },
      {
        name: 'powershell',
        platform: 'win32',
        arch: 'x64',
        version: '7.6.6',
        url: 'https://github.com/PowerShell/PowerShell/releases/download/v7.6.6/PowerShell-7.6.6-win-x64.zip',
        sha256: '02fe458be20493fbdf43f61ea20610b811ee6c738ab1676c61b9cfcd1a33c860',
      },
      {
        name: 'wezterm',
        platform: 'win32',
        arch: 'x64',
        version: '20240203-110809-5046fc22',
        url: 'https://github.com/wezterm/wezterm/releases/download/20240203-110809-5046fc22/WezTerm-windows-20240203-110809-5046fc22.zip',
        sha256: '57e5d03b585303d81e8b8e96d1230362852eb39aca92b3b29c7a42cfb82f9ac4',
      },
    ])
    expect(lock.every((entry) => entry.platform === 'darwin' || entry.platform === 'win32')).toBe(
      true,
    )
    expect(() => new ToolManager(lock, inertDependencies)).not.toThrow()
  })

  test('selects defaults by exact platform and architecture', () => {
    expect(defaultToolLockFor('win32', 'x64').map((entry) => entry.name)).toEqual([
      'powershell',
      'wezterm',
    ])
    expect(defaultToolLockFor('win32', 'arm64').map((entry) => entry.name)).toEqual(['powershell'])
    expect(defaultToolLockFor('darwin', 'arm64').map((entry) => entry.name)).toEqual(['tmux'])
    expect(defaultToolLockFor('darwin', 'x64').map((entry) => entry.name)).toEqual(['tmux'])
  })

  test('enforces the shipped checksum before writing an artifact', async () => {
    const events: string[] = []
    const manager = new ToolManager(defaultToolLockFor('win32', 'arm64'), {
      ...inertDependencies,
      artifacts: {
        async download() {
          events.push('download')
          return {
            bytes: new TextEncoder().encode('modified artifact'),
            finalUrl:
              'https://github.com/PowerShell/PowerShell/releases/download/v7.6.6/PowerShell-7.6.6-win-arm64.zip',
            redirects: [],
          }
        },
      },
      files: {
        ...inertDependencies.files,
        async stage(): Promise<never> {
          events.push('stage')
          throw new Error('stage should not run')
        },
      },
    })

    await expect(
      manager.install({
        platform: 'win32',
        architecture: 'arm64',
        target: { kind: 'session', root: 'C:\\Temp\\tools' },
      }),
    ).rejects.toThrow('checksum mismatch for tool powershell')
    expect(events).toEqual(['download'])
  })

  test('falls back only for an empty profile lock and returns isolated copies', () => {
    const fallback = resolveToolLock([])
    const fallbackEntry = fallback[0]
    if (fallbackEntry === undefined) throw new Error('shipped catalog is empty')
    fallbackEntry.name = 'changed'
    expect(resolveToolLock([])[0]?.name).toBe('tmux')

    const shippedEntry = shippedToolLock()[0]
    if (shippedEntry === undefined) throw new Error('shipped catalog is empty')
    const override = [{ ...shippedEntry, name: 'custom-tmux' }]
    expect(() => resolveToolLock(override)).toThrow('not in the shipped curated catalog')
    expect(resolveToolLock(override, override)).toEqual(override)
    expect(resolveToolLock(override, override)).not.toBe(override)
  })

  test('allows catalog selections and rejects arbitrary executable pins', () => {
    const shipped = shippedToolLock()
    const first = shipped[0]
    if (first === undefined) throw new Error('shipped catalog is empty')
    expect(() => assertCuratedToolSelection(shipped.slice(0, 1))).not.toThrow()
    expect(() =>
      assertCuratedToolSelection([
        {
          ...first,
          url: 'https://tools.example/arbitrary',
        },
      ]),
    ).toThrow('not in the shipped curated catalog')
  })
})
