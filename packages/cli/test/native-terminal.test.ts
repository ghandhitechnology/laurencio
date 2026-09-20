import { describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import path from 'node:path'
import { createFileRemote, migrateManifestToProfile, type PortableProfile } from '@laurencio/core'
import { DeviceId, RevisionId } from '@laurencio/protocol'
import {
  applyNativeTerminal,
  nativeTerminalConfigPath,
  planNativeTerminal,
} from '../src/workbench/native-terminal'
import { loadPortableProfile, savePortableProfile } from '../src/workbench/profile'
import { makeScratch, runForTest, STORE_ID, seedStore, writeHomeFile } from './helpers'

function profile(): PortableProfile {
  return {
    ...migrateManifestToProfile({
      revisionId: RevisionId.parse('00000000000000000000000001'),
      deviceId: DeviceId.parse('00000000000000000000000002'),
      createdAt: '2026-09-20T00:00:00.000Z',
      entries: [],
    }),
    shared: {
      keybindings: { 'split-horizontal': 'ctrl+alt+h' },
      layout: { columns: '120', rows: '40' },
    },
    platforms: { win32: { keybindings: { 'split-horizontal': 'ctrl+alt+s' } } },
  }
}

describe('native full-mode terminal integration', () => {
  test.each(['darwin', 'win32'] as const)(
    'leaves a fresh empty %s profile untouched',
    (platform) => {
      const empty = profile()
      empty.shared = { keybindings: {}, layout: {} }
      empty.platforms = {}
      const plan = planNativeTerminal(
        {
          home: platform === 'darwin' ? '/Users/test' : 'C:\\Users\\test',
          platform,
          environment: {},
          profile: empty,
        },
        () => null,
      )
      expect(plan.changes).toEqual([])
    },
  )

  test.skipIf(process.platform === 'win32')(
    'installs tmux once, preserves native settings, backs up the preimage, and updates only generated settings',
    () => {
      const scratch = makeScratch()
      try {
        const original = 'set -g mouse on\n# my theme'
        writeHomeFile(scratch.home, '.tmux.conf', original)
        const input = {
          home: scratch.home,
          platform: 'darwin' as const,
          environment: {},
          profile: profile(),
        }
        const first = applyNativeTerminal(input)
        const native = fs.readFileSync(first.configPath, 'utf8')
        expect(native.startsWith(`${original}\n`)).toBe(true)
        expect(native).toContain(`source-file "${first.generatedPath}"`)
        expect(fs.readFileSync(first.generatedPath, 'utf8')).toContain(
          'bind-key -n "C-M-h" split-window -h',
        )
        expect(fs.readFileSync(first.generatedPath, 'utf8')).toContain('default-size 120x40')
        const backupRoot = path.join(scratch.home, '.laurencio', 'backups', 'terminal')
        expect(
          fs
            .readdirSync(backupRoot)
            .map((file) => fs.readFileSync(path.join(backupRoot, file), 'utf8')),
        ).toContain(original)
        expect(applyNativeTerminal(input).changes).toEqual([])
        input.profile.shared.keybindings['split-horizontal'] = 'ctrl+j'
        const changed = applyNativeTerminal(input)
        expect(changed.changes.map((change) => change.path)).not.toContain(first.configPath)
        expect(fs.readFileSync(first.configPath, 'utf8')).toBe(native)
        expect(fs.readFileSync(first.generatedPath, 'utf8')).toContain('"C-j"')
      } finally {
        scratch.cleanup()
      }
    },
  )

  test.skipIf(process.platform === 'win32')(
    'keeps an in-home native symlink and backs up its target',
    () => {
      const scratch = makeScratch()
      try {
        writeHomeFile(scratch.home, 'dotfiles/tmux.conf', 'set -g mouse on\n')
        fs.symlinkSync(
          path.join(scratch.home, 'dotfiles', 'tmux.conf'),
          path.join(scratch.home, '.tmux.conf'),
        )
        const input = {
          home: scratch.home,
          platform: 'darwin' as const,
          environment: {},
          profile: profile(),
        }
        const result = applyNativeTerminal(input)
        expect(fs.lstatSync(result.configPath).isSymbolicLink()).toBe(true)
        expect(fs.readFileSync(path.join(scratch.home, 'dotfiles', 'tmux.conf'), 'utf8')).toContain(
          'source-file',
        )
        expect(applyNativeTerminal(input).changes).toEqual([])
      } finally {
        scratch.cleanup()
      }
    },
  )

  test.skipIf(process.platform === 'win32')(
    'refuses dangling or outside-home native symlinks before writing generated config',
    () => {
      const scratch = makeScratch()
      const outside = makeScratch()
      try {
        const native = path.join(scratch.home, '.tmux.conf')
        writeHomeFile(outside.home, 'tmux.conf', 'external config\n')
        fs.symlinkSync(path.join(outside.home, 'tmux.conf'), native)
        const input = {
          home: scratch.home,
          platform: 'darwin' as const,
          environment: {},
          profile: profile(),
        }
        expect(() => applyNativeTerminal(input)).toThrow('outside the home directory')
        fs.unlinkSync(native)
        fs.symlinkSync(path.join(scratch.home, 'missing.conf'), native)
        expect(() => applyNativeTerminal(input)).toThrow('cannot be resolved')
        expect(fs.existsSync(path.join(scratch.home, '.laurencio', 'generated'))).toBe(false)
        expect(fs.readFileSync(path.join(outside.home, 'tmux.conf'), 'utf8')).toBe(
          'external config\n',
        )
      } finally {
        scratch.cleanup()
        outside.cleanup()
      }
    },
  )

  test('preserves Windows Lua, applies its platform override, and uses PowerShell with native profiles', () => {
    const home = 'C:\\Users\\Andy'
    const native = path.win32.join(home, '.wezterm.lua')
    const original =
      '\uFEFFlocal wezterm = require "wezterm"\r\nlocal config = wezterm.config_builder()\r\nconfig.font_size = 15\r\nreturn config'
    const files = new Map([[native, original]])
    const input = {
      home,
      platform: 'win32' as const,
      environment: {},
      profile: profile(),
      powershell: 'C:\\Tools\\pwsh.exe',
    }
    const read = (file: string) => files.get(file) ?? null
    const first = planNativeTerminal(input, read)
    for (const change of first.changes) files.set(change.path, change.after)
    expect(first.configPath).toBe(native)
    const wrapper = files.get(native) ?? ''
    expect(wrapper.startsWith('\uFEFF-- laurencio:terminal:begin')).toBe(true)
    expect(wrapper).toContain(original.slice(1))
    expect(wrapper).toContain('laurencio_native_config(...)')
    const generated = files.get(first.generatedPath) ?? ''
    expect(generated).toContain('"C:\\\\Tools\\\\pwsh.exe", "-NoLogo"')
    expect(generated).not.toContain('-NoProfile')
    expect(generated).toContain('key = "s"')
    expect(generated).toContain('SplitHorizontal')
    expect(generated).toContain('config.initial_cols = 120')
    expect(generated).toContain('add_to_config_reload_watch_list')
    expect(planNativeTerminal(input, read).changes).toEqual([])
    files.set(native, wrapper.replace('font_size = 15', 'font_size = 18'))
    input.profile.shared.layout.columns = '140'
    const second = planNativeTerminal(input, read)
    expect(second.changes.map((change) => change.path)).not.toContain(native)
    expect(files.get(native)).toContain('font_size = 18')
  })

  test.each(['darwin', 'win32'] as const)(
    'refuses malformed and duplicate %s markers without a write plan',
    (platform) => {
      const home = platform === 'darwin' ? '/Users/test' : 'C:\\Users\\test'
      const input = { home, platform, environment: {}, profile: profile() }
      const files = new Map<string, string>()
      const read = (file: string) => files.get(file) ?? null
      const first = planNativeTerminal(input, read)
      for (const change of first.changes) files.set(change.path, change.after)
      const native = files.get(first.configPath) ?? ''
      for (const broken of [
        native.replace('laurencio:terminal:end', 'laurencio:terminal:broken'),
        `${native}${native}`,
        native.replace('dofile(', 'missing(').replace('source-file', 'source-wrong'),
      ]) {
        files.set(first.configPath, broken)
        expect(() => planNativeTerminal(input, read)).toThrow('modified or has duplicate markers')
      }
    },
  )

  test('refuses local edits to generated settings and invalid merge state', () => {
    const input = {
      home: '/Users/test',
      platform: 'darwin' as const,
      environment: {},
      profile: profile(),
    }
    const files = new Map<string, string>()
    const read = (file: string) => files.get(file) ?? null
    const first = planNativeTerminal(input, read)
    for (const change of first.changes) files.set(change.path, change.after)
    const original = files.get(first.generatedPath) ?? ''
    files.set(first.generatedPath, `${original}set -g mouse on\n`)
    expect(() => planNativeTerminal(input, read)).toThrow('edited locally')
    files.set(first.generatedPath, original)
    files.set(`${first.generatedPath}.state.json`, '{}')
    expect(() => planNativeTerminal(input, read)).toThrow('merge state is invalid')
  })

  test('uses native Windows precedence and existing XDG tmux configs', () => {
    const input = {
      home: 'C:\\Users\\test',
      platform: 'win32' as const,
      environment: { XDG_CONFIG_HOME: 'C:\\Config' },
      wezterm: 'C:\\Tools\\wezterm-gui.exe',
    }
    const existing = new Set([
      'C:\\Tools\\wezterm.lua',
      'C:\\Config\\wezterm\\wezterm.lua',
      'C:\\Users\\test\\.config\\wezterm\\wezterm.lua',
    ])
    expect(nativeTerminalConfigPath(input, (file) => existing.has(file))).toBe(
      'C:\\Tools\\wezterm.lua',
    )
    existing.delete('C:\\Tools\\wezterm.lua')
    expect(nativeTerminalConfigPath(input, (file) => existing.has(file))).toBe(
      'C:\\Config\\wezterm\\wezterm.lua',
    )
    expect(
      nativeTerminalConfigPath(
        { ...input, environment: { WEZTERM_CONFIG_FILE: 'D:\\settings.lua' } },
        () => true,
      ),
    ).toBe('D:\\settings.lua')
    expect(
      nativeTerminalConfigPath(
        {
          home: '/Users/test',
          platform: 'darwin',
          environment: { XDG_CONFIG_HOME: '/Users/test/config' },
        },
        (file) => file === '/Users/test/config/tmux/tmux.conf',
      ),
    ).toBe('/Users/test/config/tmux/tmux.conf')
  })

  test('applies encrypted profile semantics after a successful full sync', async () => {
    const scratch = makeScratch()
    try {
      const seeded = await seedStore({ home: scratch.home, remoteDir: scratch.remoteDir })
      writeHomeFile(scratch.home, '.codex/skills/example/SKILL.md', '# Example\n')
      const platform = process.platform === 'win32' ? 'win32' : 'darwin'
      const options = {
        home: scratch.home,
        remoteDir: scratch.remoteDir,
        deps: { platform: platform as 'win32' | 'darwin', quiescence: { windowMs: 0 } },
      }
      expect((await runForTest(['init', '--yes'], options)).exitCode).toBe(0)
      const remote = createFileRemote({ dir: scratch.remoteDir })
      const store = { remote, storeId: STORE_ID, key: seeded.key }
      const stored = await loadPortableProfile(store)
      expect(stored).not.toBeNull()
      if (!stored) throw new Error('Expected an initialized profile')
      stored.profile.shared = profile().shared
      await savePortableProfile({
        ...store,
        profile: stored.profile,
        expectedGeneration: stored.head.generation,
      })
      const result = await runForTest(['sync', '--json'], options)
      expect(result.exitCode).toBe(0)
      expect(
        fs.readFileSync(
          path.join(scratch.home, platform === 'win32' ? '.wezterm.lua' : '.tmux.conf'),
          'utf8',
        ),
      ).toContain('laurencio:terminal:begin')
      expect(
        fs.readFileSync(
          path.join(
            scratch.home,
            '.laurencio',
            'generated',
            platform === 'win32' ? 'wezterm.lua' : 'tmux.conf',
          ),
          'utf8',
        ),
      ).toContain(platform === 'win32' ? 'config.initial_cols = 120' : 'default-size 120x40')
    } finally {
      scratch.cleanup()
    }
  })
})
