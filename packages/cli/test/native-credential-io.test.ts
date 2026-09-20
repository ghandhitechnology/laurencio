import { expect, test } from 'bun:test'
import fs from 'node:fs'
import path from 'node:path'
import { DEFAULT_VAULT_REFERENCES, hashContent, StaleWriteError, SyncState } from '@laurencio/core'
import { parseCliArgs } from '../src/args'
import { createContext } from '../src/context'
import { createNativeCredentialIo } from '../src/native-credential-io'
import { makeScratch, runForTest, seedStore, writeHomeFile } from './helpers'

test('native account credential resolution preserves auth symlinks and backs up original bytes', async () => {
  const source = makeScratch()
  const target = makeScratch()
  try {
    await seedStore({ home: source.home, remoteDir: source.remoteDir })
    writeHomeFile(source.home, '.claude/.credentials.json', '{"accessToken":"account-login"}')
    const uploaded = await runForTest(['sync', '--yes'], {
      home: source.home,
      remoteDir: source.remoteDir,
      deps: { quiescence: { windowMs: 0 } },
    })
    expect(uploaded.exitCode, uploaded.errorOutput).toBe(0)
    await seedStore({ home: target.home, remoteDir: source.remoteDir })
    writeHomeFile(target.home, 'native-login.json', '{"accessToken":"local-login"}')
    fs.mkdirSync(path.join(target.home, '.claude'), { recursive: true })
    const link = path.join(target.home, '.claude/.credentials.json')
    fs.symlinkSync('../native-login.json', link)
    const restored = await runForTest(
      ['credentials', 'resolve', 'claude-login', '--keep-remote', '--json'],
      { home: target.home, remoteDir: source.remoteDir },
    )
    expect(restored.exitCode, restored.errorOutput).toBe(0)
    expect(fs.readlinkSync(link)).toBe('../native-login.json')
    expect(fs.readFileSync(link, 'utf8')).toBe('{"accessToken":"account-login"}')
    const backups = await runForTest(['backups', '--json'], { home: target.home })
    expect(
      (JSON.parse(backups.output) as { backups: { hash: string }[] }).backups.some(
        (item) => item.hash === hashContent('{"accessToken":"local-login"}'),
      ),
    ).toBe(true)
  } finally {
    source.cleanup()
    target.cleanup()
  }
})

test('native credential CAS preserves rotations during remote fetch and after a local read', async () => {
  const scratch = makeScratch()
  const state = SyncState.open({ home: scratch.home })
  const ctx = createContext('credentials', 'resolve', [], parseCliArgs(['credentials']).flags, {
    home: scratch.home,
    platform: 'darwin',
    env: {},
  })
  const refs = DEFAULT_VAULT_REFERENCES.filter((reference) => reference.name === 'claude-login')
  const file = path.join(scratch.home, '.claude/.credentials.json')
  try {
    writeHomeFile(scratch.home, '.claude/.credentials.json', 'original')
    const eager = createNativeCredentialIo(ctx, state, refs)
    fs.writeFileSync(file, 'rotated during fetch')
    await expect(
      eager.writeFileAtomic(file, new TextEncoder().encode('remote'), 0o600),
    ).rejects.toThrow(StaleWriteError)
    expect(fs.readFileSync(file, 'utf8')).toBe('rotated during fetch')
    const io = createNativeCredentialIo(ctx, state, refs)
    await io.readFile(file)
    fs.writeFileSync(file, 'rotated after read')
    await expect(
      io.writeFileAtomic(file, new TextEncoder().encode('remote'), 0o600),
    ).rejects.toThrow(StaleWriteError)
    expect(fs.readFileSync(file, 'utf8')).toBe('rotated after read')
  } finally {
    state.close()
    scratch.cleanup()
  }
})
