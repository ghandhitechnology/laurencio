import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { AdapterContext } from '../../src/types'

export interface FakeFileSpec {
  kind: 'file'
  path: string
  content?: string
  mode?: number
  /** When set, create a symlink at `path` pointing at this target ($HOME is expanded). */
  link?: string
}

export interface FakeDirSpec {
  kind: 'dir'
  path: string
  mode?: number
  link?: string
}

export type FakeEntry = FakeFileSpec | FakeDirSpec

export interface FakeHomeOptions {
  platform?: AdapterContext['platform']
  env?: Record<string, string | undefined>
  /** Relative paths skipped during creation, to prove a scan tolerates holes. */
  ignore?: string[]
  /**
   * How recipe `link` entries materialize: `symlink` (default) or `copy`, the Windows-style
   * layout where the link is a real tree. Materialization-map tests exercise both.
   */
  linkMode?: 'symlink' | 'copy'
  entries: FakeEntry[]
}

export interface FakeHome {
  home: string
  ctx: AdapterContext
  /** Resolve a home-relative path with forward slashes. */
  path(relative: string): string
  read(relative: string): string
  lstat(relative: string): fs.Stats
  write(relative: string, content: string, mode?: number): void
  symlink(relative: string, target: string): void
  cleanup(): void
}

const activeHomes = new Set<string>()

process.on('exit', () => {
  for (const home of activeHomes) {
    try {
      fs.rmSync(home, { recursive: true, force: true })
    } catch {
      // Best effort: the temp directory is disposable.
    }
  }
})

function expandHome(value: string, home: string): string {
  if (value === '$HOME') return home
  if (value.startsWith('$HOME/')) return path.join(home, value.slice('$HOME/'.length))
  return value
}

function linkType(target: string): 'dir' | 'file' {
  try {
    return fs.statSync(target).isDirectory() ? 'dir' : 'file'
  } catch {
    return 'file'
  }
}

export function buildFakeHome(options: FakeHomeOptions): FakeHome {
  const home = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'laurencio-home-'))
  activeHomes.add(home)
  const ignore = new Set(options.ignore ?? [])
  const linkMode = options.linkMode ?? 'symlink'
  const resolve = (relative: string): string =>
    path.join(home, ...relative.split('/').filter((segment) => segment !== ''))
  const ensureParent = (relative: string): void => {
    const parent = path.dirname(resolve(relative))
    fs.mkdirSync(parent, { recursive: true })
  }
  for (const entry of options.entries) {
    if (ignore.has(entry.path)) continue
    if (entry.link !== undefined) {
      ensureParent(entry.path)
      const target = expandHome(entry.link, home)
      if (linkMode === 'copy') {
        fs.cpSync(target, resolve(entry.path), { recursive: true })
      } else {
        fs.symlinkSync(target, resolve(entry.path), linkType(target))
      }
      continue
    }
    if (entry.kind === 'dir') {
      fs.mkdirSync(resolve(entry.path), { recursive: true, mode: 0o755 })
      continue
    }
    ensureParent(entry.path)
    const mode = entry.mode ?? 0o644
    fs.writeFileSync(resolve(entry.path), entry.content ?? '', { mode })
    fs.chmodSync(resolve(entry.path), mode)
  }
  return {
    home,
    ctx: {
      home,
      platform: options.platform ?? 'darwin',
      env: { ...options.env },
    },
    path: resolve,
    read: (relative) => fs.readFileSync(resolve(relative), 'utf8'),
    lstat: (relative) => fs.lstatSync(resolve(relative)),
    write: (relative, content, mode = 0o644) => {
      ensureParent(relative)
      fs.writeFileSync(resolve(relative), content, { mode })
      fs.chmodSync(resolve(relative), mode)
    },
    symlink: (relative, target) => {
      ensureParent(relative)
      const resolved = expandHome(target, home)
      fs.symlinkSync(resolved, resolve(relative), linkType(resolved))
    },
    cleanup: () => {
      activeHomes.delete(home)
      fs.rmSync(home, { recursive: true, force: true })
    },
  }
}
