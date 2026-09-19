/**
 * Test harness for the CLI. Every test gets a scratch HOME and a FileRemote
 * store, plus scripted prompts, so no test touches the real HOME, network,
 * keychain, or terminal.
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  createFileRemote,
  crypto,
  type DeviceIdentity,
  storeCredentials,
  writeDeviceIdentity,
} from '@laurencio/core'
import { DeviceId, RevisionId, StoreId } from '@laurencio/protocol'
import { type CliRunResult, runCli } from '../src/cli'
import type { CliDeps } from '../src/context'
import type { CliIo } from '../src/ui'

export const STORE_ID = StoreId.parse('00000000000000000000000001')
export const DEVICE_ID = DeviceId.parse('00000000000000000000000002')
export const TOKEN = 'lrn_cli-test-token-value'
export const PASSPHRASE = 'cli-test-passphrase'
export const NOW = '2026-09-19T12:00:00.000Z'

export const KDF: crypto.KdfParams = {
  algo: 'argon2id',
  salt: '00000000000000000000000000000000',
  m: 8,
  t: 1,
  p: 1,
  version: 0x13,
}

export interface MemoryKeychain extends crypto.CredentialStore {
  readonly entries: Map<string, Uint8Array>
}

export function memoryKeychain(): MemoryKeychain {
  const entries = new Map<string, Uint8Array>()
  const key = (service: string, account: string): string => `${service}\u0000${account}`
  return {
    backend: 'keychain',
    entries,
    get: async (service, account) => entries.get(key(service, account))?.slice() ?? null,
    set: async (service, account, secret) => {
      entries.set(key(service, account), secret.slice())
    },
    delete: async (service, account) => {
      entries.delete(key(service, account))
    },
  }
}

export interface Scratch {
  home: string
  remoteDir: string
  cleanup(): void
}

export function makeScratch(): Scratch {
  const base = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'laurencio-cli-'))
  const home = path.join(base, 'home')
  const remoteDir = path.join(base, 'remote')
  fs.mkdirSync(home, { recursive: true })
  return {
    home,
    remoteDir,
    cleanup: () => fs.rmSync(base, { recursive: true, force: true }),
  }
}

export interface SeedOptions {
  home: string
  remoteDir: string
  keychain?: crypto.CredentialStore | null
  storeId?: StoreId
  deviceId?: DeviceId
  deviceName?: string
  /** Seed the store key cache too. True by default. */
  cacheKey?: boolean
  /** Seed a device record in the FileRemote. */
  recordDevice?: boolean
}

export interface Seeded {
  home: string
  remoteDir: string
  identity: DeviceIdentity
  key: crypto.KeyMaterial
}

/** Seeds a FileRemote store, a device identity, a token, and the key cache. */
export async function seedStore(options: SeedOptions): Promise<Seeded> {
  const storeId = options.storeId ?? STORE_ID
  const deviceId = options.deviceId ?? DEVICE_ID
  const keychain = options.keychain ?? null
  const remote = createFileRemote({
    dir: options.remoteDir,
    storeId,
    kdf: crypto.kdfParamsToWire(KDF, NOW),
    now: () => new Date(NOW),
  })
  const identity: DeviceIdentity = {
    version: 1,
    deviceId,
    storeId,
    name: options.deviceName ?? 'test-laptop',
    platform: 'darwin',
    createdAt: NOW,
  }
  await storeCredentials({ home: options.home, keychain }, { identity, token: TOKEN })
  writeDeviceIdentity(options.home, identity)
  const key = crypto.deriveMasterKey(PASSPHRASE, KDF)
  if (options.cacheKey !== false) {
    const cache = await crypto.openKeyCache({ home: options.home, keychain })
    await cache.save(storeId, key)
  }
  if (options.recordDevice !== false) {
    remote.upsertDevice({ id: deviceId, name: identity.name, platform: 'darwin', createdAt: NOW })
  }
  return { home: options.home, remoteDir: options.remoteDir, identity, key }
}

export interface ScriptedIo extends CliIo {
  readonly output: string[]
  readonly answers: string[]
}

let revisionCounter = 0

/** Deterministic revision ids, in creation order, for stable snapshots. */
export function nextRevisionId(): RevisionId {
  revisionCounter += 1
  return RevisionId.parse(`01${String(revisionCounter).padStart(24, '0')}`)
}

export function scriptedIo(answers: readonly string[] = []): ScriptedIo {
  const output: string[] = []
  const queue = [...answers]
  return {
    output,
    answers: queue,
    out: (text) => {
      output.push(text)
    },
    err: (text) => {
      output.push(text)
    },
    readLine: async () => queue.shift() ?? '',
    readSecret: async () => queue.shift() ?? '',
  }
}

export interface RunOptions {
  home: string
  remoteDir?: string
  keychain?: crypto.CredentialStore | null
  answers?: readonly string[]
  env?: Record<string, string | undefined>
  deps?: Partial<CliDeps>
}

export interface RunOutcome extends CliRunResult {
  io: ScriptedIo
  /** Rendered result plus anything the command wrote through the injected IO. */
  combined: string
}

export async function runForTest(
  args: readonly string[],
  options: RunOptions,
): Promise<RunOutcome> {
  const io = scriptedIo(options.answers)
  const env: Record<string, string | undefined> = {
    LAURENCIO_KEYCHAIN: 'file',
    ...options.env,
  }
  if (options.remoteDir !== undefined) env.LAURENCIO_REMOTE_DIR = options.remoteDir
  const deps: CliDeps = {
    home: options.home,
    platform: 'darwin',
    env,
    now: () => new Date(NOW),
    io,
    keychain: options.keychain === undefined ? null : options.keychain,
    probes: {},
    createRevisionId: nextRevisionId,
    ...options.deps,
  }
  const result = await runCli(args, deps)
  const combined = [result.output, io.output.join('\n')]
    .filter((part) => part.trim() !== '')
    .join('\n')
  return { ...result, io, combined }
}

export function writeHomeFile(home: string, relative: string, content: string): void {
  const target = path.join(home, relative)
  fs.mkdirSync(path.dirname(target), { recursive: true })
  fs.writeFileSync(target, content)
}

export function readHomeFile(home: string, relative: string): string {
  return fs.readFileSync(path.join(home, relative), 'utf8')
}

const HEX = /\b[0-9a-f]{32,64}\b/g
const ULID = /\b[0-9A-HJKMNP-TV-Z]{26}\b/g
const ISO = /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z/g

/** Normalizes volatile values so output snapshots stay stable. */
export function normalizeOutput(
  text: string,
  options: { home?: string; remoteDir?: string } = {},
): string {
  let result = text
  if (options.home !== undefined) result = result.split(options.home).join('<HOME>')
  if (options.remoteDir !== undefined) result = result.split(options.remoteDir).join('<REMOTE>')
  return result.replace(ISO, '<TIME>').replace(HEX, '<HASH>').replace(ULID, '<ID>')
}
