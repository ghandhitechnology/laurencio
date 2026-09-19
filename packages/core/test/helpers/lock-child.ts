/**
 * Child process for the cross-process lock race test. Runs one real sync in
 * `hold` mode (blocks inside the first apply, after the intent row and temp
 * file exist) or `once` mode, and reports the outcome as one JSON line.
 */

import fs from 'node:fs'
import { DeviceId, StoreId } from '@laurencio/protocol'
import { deriveMasterKey, type KdfParams, kdfParamsToWire } from '../../src/crypto/kdf'
import { sync } from '../../src/engine'
import { createFileRemote } from '../../src/remote/file'
import { LockHeldError, SyncState, stateDbPath } from '../../src/state'
import type { Surface } from '../../src/types'
import { file, testAdapter } from './adapter-fixtures'

export const LOCK_STORE_ID = StoreId.parse('00000000000000000000000700')
export const LOCK_DEVICE_SEED = DeviceId.parse('00000000000000000000000701')
export const LOCK_DEVICE_HOLDER = DeviceId.parse('00000000000000000000000702')
export const LOCK_DEVICE_RACER = DeviceId.parse('00000000000000000000000703')
export const LOCK_KDF: KdfParams = {
  algo: 'argon2id',
  salt: '00000000000000000000000000000000',
  m: 8,
  t: 1,
  p: 1,
  version: 0x13,
}
const CREATED_AT = '2026-01-01T00:00:00.000Z'
const PASSPHRASE = 'lock-race'

export function lockSurfaces(): Surface[] {
  return [file({ id: 'claude.instructions', path: '$HOME/.claude/CLAUDE.md', format: 'markdown' })]
}

function argument(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`)
  return index === -1 ? undefined : process.argv[index + 1]
}

function required(name: string): string {
  const value = argument(name)
  if (value === undefined) throw new Error(`--${name} is required`)
  return value
}

function sleep(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
}

async function main(): Promise<void> {
  const mode = required('mode')
  const home = required('home')
  const remoteDir = required('remote')
  const deviceId = DeviceId.parse(required('device'))
  const marker = argument('marker')
  const release = argument('release')
  const hooks =
    mode === 'hold' && marker !== undefined && release !== undefined
      ? {
          beforeRename: (): void => {
            fs.writeFileSync(marker, 'holding')
            while (!fs.existsSync(release)) sleep(10)
          },
        }
      : undefined

  const state = SyncState.open({ path: stateDbPath(home) })
  try {
    const report = await sync({
      adapters: [testAdapter('claude', lockSurfaces())],
      ctx: { home, platform: 'darwin', env: {} },
      deviceId,
      storeId: LOCK_STORE_ID,
      key: deriveMasterKey(PASSPHRASE, LOCK_KDF),
      state,
      remote: createFileRemote({
        dir: remoteDir,
        storeId: LOCK_STORE_ID,
        kdf: kdfParamsToWire(LOCK_KDF, CREATED_AT),
        now: () => new Date(),
      }),
      quiescence: { windowMs: 0 },
      ...(hooks !== undefined ? { hooks } : {}),
    })
    process.stdout.write(`${JSON.stringify({ ok: true, revisionId: report.revisionId })}\n`)
  } catch (error) {
    if (error instanceof LockHeldError) {
      process.stdout.write(`${JSON.stringify({ busy: true, holder: error.holder })}\n`)
      return
    }
    throw error
  } finally {
    state.close()
  }
}

// `bun test` scans every file under test/, so only run when spawned with args.
if (process.argv.includes('--mode')) {
  main().catch((error: unknown) => {
    console.error(error)
    process.exit(1)
  })
}
