import { describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { DeviceId } from '@laurencio/protocol'
import { copyModeFor, ensureLayoutLink, resolveLayoutTarget } from '../src/materialize'
import type { LocalLayout } from '../src/model'

const deviceId = DeviceId.parse('00000000000000000000000001')

function tempDir(): string {
  return fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'laurencio-materialize-'))
}

function layoutFor(declaredPath: string, linkTarget: string): LocalLayout {
  return { deviceId, entries: [{ path: declaredPath, mode: 'symlink', linkTarget }] }
}

describe('materialize', () => {
  test('a symlinked target is written through and the link survives', () => {
    const home = tempDir()
    const owner = path.join(home, '.agents', 'skills')
    const declared = path.join(home, '.claude', 'skills')
    fs.mkdirSync(owner, { recursive: true })
    fs.mkdirSync(path.dirname(declared), { recursive: true })
    fs.symlinkSync(owner, declared, 'dir')

    const target = resolveLayoutTarget({
      declaredPath: path.join(declared, 'SKILL.md'),
      layout: layoutFor(declared, owner),
      platform: 'darwin',
    })
    expect(target.viaLink).toBe(true)
    expect(target.writePaths).toEqual([path.join(owner, 'SKILL.md')])
    expect(fs.lstatSync(declared).isSymbolicLink()).toBe(true)
    fs.rmSync(home, { recursive: true, force: true })
  })

  test('a missing link is recreated only when the layout says so', () => {
    const home = tempDir()
    const declared = path.join(home, '.claude', 'skills')
    const owner = path.join(home, '.agents', 'skills')
    fs.mkdirSync(owner, { recursive: true })

    const described = resolveLayoutTarget({
      declaredPath: path.join(declared, 'SKILL.md'),
      layout: layoutFor(declared, owner),
      platform: 'darwin',
    })
    expect(described.linkMissing).toBe(true)
    expect(described.writePaths).toEqual([path.join(owner, 'SKILL.md')])
    expect(ensureLayoutLink(described)).toBe(true)
    expect(fs.lstatSync(declared).isSymbolicLink()).toBe(true)
    expect(ensureLayoutLink(described)).toBe(false)

    const undeclared = resolveLayoutTarget({
      declaredPath: path.join(home, '.config', 'opencode', 'skills', 'SKILL.md'),
      layout: { deviceId, entries: [] },
      platform: 'darwin',
    })
    expect(undeclared.linkMissing).toBe(false)
    expect(undeclared.writePaths).toEqual([
      path.join(home, '.config', 'opencode', 'skills', 'SKILL.md'),
    ])
    fs.rmSync(home, { recursive: true, force: true })
  })

  test('a real file where the layout expects a link is never replaced', () => {
    const home = tempDir()
    const declared = path.join(home, '.claude', 'skills')
    fs.mkdirSync(declared, { recursive: true })
    const target = resolveLayoutTarget({
      declaredPath: path.join(declared, 'SKILL.md'),
      layout: layoutFor(declared, path.join(home, '.agents', 'skills')),
      platform: 'darwin',
    })
    expect(target.linkMissing).toBe(false)
    expect(target.writePaths).toEqual([path.join(declared, 'SKILL.md')])
    fs.rmSync(home, { recursive: true, force: true })
  })

  test('copy mode keeps the declared path and the owner copy in step', () => {
    const home = tempDir()
    const declared = path.join(home, '.claude', 'skills')
    const owner = path.join(home, '.agents', 'skills')
    fs.mkdirSync(owner, { recursive: true })
    const target = resolveLayoutTarget({
      declaredPath: path.join(declared, 'SKILL.md'),
      layout: layoutFor(declared, owner),
      platform: 'win32',
    })
    expect(target.copyMode).toBe(true)
    expect(target.linkMissing).toBe(false)
    expect(target.writePaths).toEqual([
      path.join(declared, 'SKILL.md'),
      path.join(owner, 'SKILL.md'),
    ])
    expect(copyModeFor('darwin', true)).toBe(true)
    expect(copyModeFor('darwin')).toBe(false)
    fs.rmSync(home, { recursive: true, force: true })
  })
})
