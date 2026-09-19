import { describe, expect, test } from 'bun:test'
import {
  detectOpenCode,
  OPENCODE_SCHEMA_FILES,
  schemasForFile,
} from '../src/adapters/opencode/detect'
import { buildFakeHome } from './helpers/fake-home'

describe('opencode schema detection', () => {
  test('both binaries present means both schemas own the config dir', () => {
    const home = buildFakeHome({ entries: [] })
    const report = detectOpenCode({
      ...home.ctx,
      probes: {
        opencode: {
          installed: true,
          version: '1.18.23',
          notes: ['opencode 1.18.23', 'opencode2 0.0.0-beta-19059'],
        },
      },
    })
    expect(report.schemas).toEqual({ v1: true, v2: true })
    expect(report.binaries).toEqual([
      { name: 'opencode', version: '1.18.23' },
      { name: 'opencode2', version: '0.0.0-beta-19059' },
    ])
    expect(report.version).toBe('1.18.23')
    expect(report.notes).toContain('v1 schema present; v2 schema present')
    home.cleanup()
  })

  test('config-dir file shapes decide schema presence when versions are unknown', () => {
    const home = buildFakeHome({ entries: [] })
    const report = detectOpenCode({
      ...home.ctx,
      probes: {
        opencode: { installed: true, notes: ['config:cli.json', 'config:opencode.jsonc'] },
      },
    })
    expect(report.schemas).toEqual({ v1: false, v2: true })
    expect(report.files).toEqual([
      { name: 'cli.json', owners: [2] },
      { name: 'opencode.jsonc', owners: [1, 2] },
    ])
    home.cleanup()
  })

  test('a v1 shape is detected from tui.json or tools', () => {
    const home = buildFakeHome({ entries: [] })
    const report = detectOpenCode({
      ...home.ctx,
      probes: { opencode: { installed: true, notes: ['config:tui.json', 'config:tools'] } },
    })
    expect(report.schemas).toEqual({ v1: true, v2: false })
    home.cleanup()
  })

  test('reports which schema reads each declared file', () => {
    expect(schemasForFile('tui.json')).toEqual([1])
    expect(schemasForFile('cli.json')).toEqual([2])
    expect(schemasForFile('opencode.jsonc')).toEqual([1, 2])
    expect(schemasForFile('service.json')).toEqual([1, 2])
    expect(schemasForFile('unheard-of.json')).toEqual([])
    expect(
      OPENCODE_SCHEMA_FILES.some((file) => file.name === 'tools' && file.owners[0] === 1),
    ).toBe(true)
  })

  test('no probe reports absence and stays pure', () => {
    const home = buildFakeHome({ entries: [] })
    const first = detectOpenCode(home.ctx)
    const second = detectOpenCode(home.ctx)
    expect(first).toEqual(second)
    expect(first.installed).toBe(false)
    expect(first.schemas).toEqual({ v1: false, v2: false })
    expect(first.notes[0]).toContain('no opencode probe')
    home.cleanup()
  })

  test('an unknown observed file is reported with no declared owner', () => {
    const home = buildFakeHome({ entries: [] })
    const report = detectOpenCode({
      ...home.ctx,
      probes: { opencode: { installed: true, notes: ['config:mystery.json'] } },
    })
    expect(report.files).toEqual([{ name: 'mystery.json', owners: [] }])
    expect(report.notes.some((note) => note.includes('no declared schema'))).toBe(true)
    home.cleanup()
  })
})
