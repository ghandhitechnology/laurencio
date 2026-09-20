import type { ProfilePlatform, ToolLockEntry } from '../profile'

export type CuratedToolArchitecture = 'arm64' | 'x64'

const shippedEntries: readonly ToolLockEntry[] = Object.freeze([
  Object.freeze({
    name: 'tmux',
    platform: 'darwin',
    arch: 'arm64',
    version: '3.7c',
    url: 'https://github.com/tmux/tmux-builds/releases/download/v3.7c/tmux-3.7c-macos-arm64.tar.gz',
    sha256: '0a763dd0380aa980d239509654da1bc7455843706a3c050f6709c8cd2e13d12d',
  }),
  Object.freeze({
    name: 'tmux',
    platform: 'darwin',
    arch: 'x64',
    version: '3.7c',
    url: 'https://github.com/tmux/tmux-builds/releases/download/v3.7c/tmux-3.7c-macos-x86_64.tar.gz',
    sha256: '1c21f9ade964e4a539be05ffe3a4e95854ab76a0a9c4c05d0ffbe7fc6c4d783f',
  }),
  Object.freeze({
    name: 'powershell',
    platform: 'win32',
    arch: 'arm64',
    version: '7.6.6',
    url: 'https://github.com/PowerShell/PowerShell/releases/download/v7.6.6/PowerShell-7.6.6-win-arm64.zip',
    sha256: 'bbde9dda31d148415eccb5fbe1638e6400a144187b006e5b3fd8ec2f39d781be',
  }),
  Object.freeze({
    name: 'powershell',
    platform: 'win32',
    arch: 'x64',
    version: '7.6.6',
    url: 'https://github.com/PowerShell/PowerShell/releases/download/v7.6.6/PowerShell-7.6.6-win-x64.zip',
    sha256: '02fe458be20493fbdf43f61ea20610b811ee6c738ab1676c61b9cfcd1a33c860',
  }),
  Object.freeze({
    name: 'wezterm',
    platform: 'win32',
    arch: 'x64',
    version: '20240203-110809-5046fc22',
    url: 'https://github.com/wezterm/wezterm/releases/download/20240203-110809-5046fc22/WezTerm-windows-20240203-110809-5046fc22.zip',
    sha256: '57e5d03b585303d81e8b8e96d1230362852eb39aca92b3b29c7a42cfb82f9ac4',
  }),
])

/** Returns a copy of the release-pinned tool catalog shipped with this client. */
export function shippedToolLock(): ToolLockEntry[] {
  return shippedEntries.map((entry) => ({ ...entry }))
}

/** Local lock files may select shipped pins, but cannot introduce executable sources. */
export function assertCuratedToolSelection(
  selection: readonly ToolLockEntry[],
  catalog: readonly ToolLockEntry[] = shippedEntries,
): void {
  for (const candidate of selection) {
    const matched = catalog.some(
      (entry) =>
        entry.name === candidate.name &&
        entry.platform === candidate.platform &&
        entry.arch === candidate.arch &&
        entry.version === candidate.version &&
        entry.url === candidate.url &&
        entry.sha256 === candidate.sha256,
    )
    if (!matched) {
      throw new Error(
        `tool ${candidate.name} (${candidate.platform}/${candidate.arch}) is not in the shipped curated catalog`,
      )
    }
  }
}

/** An empty profile lock means the profile follows the catalog shipped with the client. */
export function resolveToolLock(
  profileLock: readonly ToolLockEntry[],
  catalog: readonly ToolLockEntry[] = shippedEntries,
): ToolLockEntry[] {
  if (profileLock.length > 0) assertCuratedToolSelection(profileLock, catalog)
  return (profileLock.length === 0 ? catalog : profileLock).map((entry) => ({ ...entry }))
}

export function defaultToolLockFor(
  platform: ProfilePlatform,
  architecture: CuratedToolArchitecture,
): ToolLockEntry[] {
  return shippedEntries
    .filter((entry) => entry.platform === platform && entry.arch === architecture)
    .map((entry) => ({ ...entry }))
}
