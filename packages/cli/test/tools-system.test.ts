import { describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import path from 'node:path'
import {
  assertSafeArchiveEntries,
  assertSafeArchiveTypes,
  createSystemToolDependencies,
  toolArchitecture,
} from '../src/tools/system'
import { makeScratch } from './helpers'

describe('system curated-tool integration', () => {
  test('downloads through a bounded HTTPS redirect chain', async () => {
    const calls: string[] = []
    const deps = createSystemToolDependencies({
      fetch: (async (input: string | URL | Request) => {
        const url = String(input)
        calls.push(url)
        if (url === 'https://tools.example/start') {
          return new Response(null, {
            status: 302,
            headers: { location: 'https://cdn.example/tool.zip' },
          })
        }
        return new Response(new TextEncoder().encode('artifact'))
      }) as typeof fetch,
    })

    const artifact = await deps.artifacts.download('https://tools.example/start')

    expect(new TextDecoder().decode(artifact.bytes)).toBe('artifact')
    expect(artifact.redirects).toEqual(['https://cdn.example/tool.zip'])
    expect(artifact.finalUrl).toBe('https://cdn.example/tool.zip')
    expect(calls).toEqual(['https://tools.example/start', 'https://cdn.example/tool.zip'])
  })

  test('stages and replaces a tool directory on the destination volume', async () => {
    const scratch = makeScratch()
    try {
      const deps = createSystemToolDependencies()
      const destination = path.join(scratch.home, 'tools', 'ripgrep')
      fs.mkdirSync(destination, { recursive: true })
      fs.writeFileSync(path.join(destination, 'old'), 'old')
      const staging = await deps.files.stage(destination)
      fs.writeFileSync(path.join(staging, 'rg'), 'new')

      await deps.files.commit(staging, destination)

      expect(fs.readFileSync(path.join(destination, 'rg'), 'utf8')).toBe('new')
      expect(fs.existsSync(path.join(destination, 'old'))).toBe(false)
      expect(fs.readdirSync(path.dirname(destination))).toEqual(['ripgrep'])
    } finally {
      scratch.cleanup()
    }
  })

  test('rejects an insecure redirect before fetching its target', async () => {
    const calls: string[] = []
    const deps = createSystemToolDependencies({
      fetch: (async (input: string | URL | Request) => {
        calls.push(String(input))
        return new Response(null, { status: 302, headers: { location: 'http://unsafe.test/tool' } })
      }) as typeof fetch,
    })
    await expect(deps.artifacts.download('https://tools.test/start')).rejects.toThrow('HTTPS')
    expect(calls).toEqual(['https://tools.test/start'])
  })

  test('rejects links before invoking archive extraction', async () => {
    for (const entry of [
      'lrwxrwxrwx  0 user group 0 Jan 1 00:00 bin -> /outside',
      'hrw-r--r--  0 user group 0 Jan 1 00:00 bin link to /outside',
    ]) {
      const scratch = makeScratch()
      const commands: string[] = []
      try {
        const destination = path.join(scratch.home, 'staging')
        fs.mkdirSync(destination)
        const deps = createSystemToolDependencies({
          exec: async (_program, args) => {
            commands.push(args[0] ?? '')
            return { status: 0, stdout: args[0] === '-tf' ? 'bin\n' : `${entry}\n`, stderr: '' }
          },
        })
        await expect(
          deps.unpacker.unpack({
            bytes: new Uint8Array(),
            sourceName: 'tool.tar.gz',
            destination,
          }),
        ).rejects.toThrow('link or unsupported')
        expect(commands).toEqual(['-tf', '-tvf'])
        expect(fs.readdirSync(destination)).toEqual([])
      } finally {
        scratch.cleanup()
      }
    }
    expect(() =>
      assertSafeArchiveTypes('-rwxr-xr-x  0 user group 1 Jan 1 00:00 bin\n'),
    ).not.toThrow()
  })

  test('stores cache verification receipts inside the atomic tool directory', async () => {
    const scratch = makeScratch()
    try {
      const deps = createSystemToolDependencies()
      const destination = path.join(scratch.home, 'tools', 'ripgrep')
      const staging = await deps.files.stage(destination)
      if (deps.files.writeReceipt === undefined || deps.files.readReceipt === undefined) {
        throw new Error('tool receipts are unavailable')
      }

      await deps.files.writeReceipt(staging, {
        sha256: 'a'.repeat(64),
        sourceHost: 'cdn.example',
      })
      await deps.files.commit(staging, destination)

      expect(await deps.files.readReceipt(destination)).toEqual({
        sha256: 'a'.repeat(64),
        sourceHost: 'cdn.example',
      })
    } finally {
      scratch.cleanup()
    }
  })

  test('rejects archive paths that could escape staging', () => {
    expect(() => assertSafeArchiveEntries(['bin/rg', 'share/man/rg.1'])).not.toThrow()
    for (const unsafe of ['../outside', '/absolute', 'bin/../../outside', 'C:\\outside']) {
      expect(() => assertSafeArchiveEntries([unsafe])).toThrow('unsafe archive entry')
    }
    expect(toolArchitecture('arm64')).toBe('arm64')
    expect(toolArchitecture('x64')).toBe('x64')
    expect(() => toolArchitecture('ia32')).toThrow('unsupported client architecture')
  })
})
