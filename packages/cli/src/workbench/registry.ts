import fs from 'node:fs'
import path from 'node:path'
import { secrets } from '@laurencio/core'
import {
  type RevisionId,
  type WorkbenchSession,
  type WorkbenchSessionId,
  WorkbenchSession as WorkbenchSessionSchema,
} from '@laurencio/protocol'
import { hasSafeWindowsHostArtifacts, type WorkbenchSession as RuntimeSession } from './runtime'

const REGISTRY_DIRECTORY = 'workbenches'
const TOKEN_FILE = 'session-token'

export interface RegisteredWorkbench {
  remote: WorkbenchSession
  runtime: RuntimeSession
  server: string
  /** Revision materialized at launch. */
  revisionId: RevisionId | null
}

export interface WorkbenchRegistry {
  save(record: RegisteredWorkbench, token: string): void
  get(id: WorkbenchSessionId): RegisteredWorkbench | null
  list(): RegisteredWorkbench[]
  token(record: RegisteredWorkbench): string | null
  remove(id: WorkbenchSessionId): void
  pending?(record: PendingWorkbench): void
  pendingList?(): PendingWorkbench[]
  forgetPending?(id: WorkbenchSessionId): void
}

export interface PendingWorkbench {
  remote: WorkbenchSession
  server: string
  root: string
  ownerPid: number
  phase: 'materializing' | 'launching'
}

export function workbenchRegistryDirectory(home: string): string {
  return path.join(home, secrets.LAURENCIO_DIR, REGISTRY_DIRECTORY)
}

export function workbenchTokenPath(root: string): string {
  return path.join(root, TOKEN_FILE)
}

export function openWorkbenchRegistry(home: string): WorkbenchRegistry {
  const directory = workbenchRegistryDirectory(home)
  const recordPath = (id: WorkbenchSessionId): string => path.join(directory, `${id}.json`)
  const pendingPath = (id: WorkbenchSessionId): string => path.join(directory, `${id}.pending.json`)

  const readRecord = (filePath: string): RegisteredWorkbench | null => {
    try {
      return parseRecord(JSON.parse(fs.readFileSync(filePath, 'utf8')))
    } catch {
      return null
    }
  }

  return {
    save(record, token) {
      const parsed = parseRecord(record)
      if (parsed === null) throw new Error('workbench registry record is invalid')
      if (token.trim() === '') throw new Error('workbench session token is empty')
      fs.mkdirSync(directory, { recursive: true, mode: 0o700 })
      fs.mkdirSync(parsed.runtime.root, { recursive: true, mode: 0o700 })
      writePrivate(workbenchTokenPath(parsed.runtime.root), `${token}\n`)
      writePrivate(recordPath(parsed.remote.id), `${JSON.stringify(parsed, null, 2)}\n`)
      fs.rmSync(pendingPath(parsed.remote.id), { force: true })
    },
    pending(record) {
      fs.mkdirSync(directory, { recursive: true, mode: 0o700 })
      writePrivate(pendingPath(record.remote.id), `${JSON.stringify(record)}\n`)
    },
    pendingList() {
      if (!fs.existsSync(directory)) return []
      return fs
        .readdirSync(directory)
        .filter((name) => /^[0-9A-HJKMNP-TV-Z]{26}\.pending\.json$/.test(name))
        .flatMap((name) => {
          try {
            const value = JSON.parse(fs.readFileSync(path.join(directory, name), 'utf8'))
            const remote = WorkbenchSessionSchema.parse(value.remote)
            if (
              name !== `${remote.id}.pending.json` ||
              !Number.isSafeInteger(value.ownerPid) ||
              value.ownerPid < 1 ||
              !['materializing', 'launching'].includes(value.phase) ||
              typeof value.root !== 'string' ||
              !path.isAbsolute(value.root) ||
              path.parse(value.root).root === value.root ||
              typeof value.server !== 'string' ||
              !isHttpUrl(value.server)
            )
              return []
            return [{ ...value, remote } as PendingWorkbench]
          } catch {
            return []
          }
        })
    },
    forgetPending(id) {
      fs.rmSync(pendingPath(id), { force: true })
    },
    get(id) {
      return readRecord(recordPath(id))
    },
    list() {
      let names: string[]
      try {
        names = fs.readdirSync(directory)
      } catch {
        return []
      }
      return names
        .filter((name) => /^[0-9A-HJKMNP-TV-Z]{26}\.json$/.test(name))
        .map((name) => readRecord(path.join(directory, name)))
        .filter((record): record is RegisteredWorkbench => record !== null)
        .sort((left, right) => left.remote.createdAt.localeCompare(right.remote.createdAt))
    },
    token(record) {
      try {
        const value = fs.readFileSync(workbenchTokenPath(record.runtime.root), 'utf8').trim()
        return value === '' ? null : value
      } catch {
        return null
      }
    },
    remove(id) {
      fs.rmSync(recordPath(id), { force: true })
    },
  }
}

function writePrivate(filePath: string, content: string): void {
  const temporary = `${filePath}.tmp-${process.pid}`
  fs.writeFileSync(temporary, content, { mode: 0o600 })
  if (process.platform !== 'win32') fs.chmodSync(temporary, 0o600)
  fs.renameSync(temporary, filePath)
}

export function parseWorkbenchRecord(value: unknown): RegisteredWorkbench | null {
  if (!isRecord(value)) return null
  const remote = WorkbenchSessionSchema.safeParse(value.remote)
  if (!remote.success || !isRecord(value.runtime)) return null
  const runtime = parseRuntime(value.runtime)
  if (runtime === null || runtime.id !== remote.data.id) return null
  if (typeof value.server !== 'string' || !isHttpUrl(value.server)) return null
  const revisionId = value.revisionId
  if (revisionId !== null && !/^[0-9A-HJKMNP-TV-Z]{26}$/.test(String(revisionId))) return null
  return {
    remote: remote.data,
    runtime,
    server: value.server,
    revisionId: revisionId as RevisionId | null,
  }
}

const parseRecord = parseWorkbenchRecord

function parseRuntime(value: Record<string, unknown>): RuntimeSession | null {
  if (value.platform !== 'darwin' && value.platform !== 'win32') return null
  const required = ['id', 'root', 'home', 'cwd', 'executable', 'configPath', 'socketPath'] as const
  if (required.some((key) => typeof value[key] !== 'string' || value[key] === '')) return null
  const runtime = value as unknown as RuntimeSession
  const paths = runtime.platform === 'win32' ? path.win32 : path.posix
  if (!paths.isAbsolute(runtime.root) || paths.parse(runtime.root).root === runtime.root)
    return null
  for (const candidate of [runtime.home, runtime.configPath, runtime.socketPath]) {
    const relative = paths.relative(runtime.root, candidate)
    if (relative === '' || relative === '..' || relative.startsWith(`..${paths.sep}`)) return null
  }
  if (runtime.powershell !== undefined && typeof runtime.powershell !== 'string') return null
  if (runtime.process !== undefined) {
    if (!isRecord(runtime.process)) return null
    if (!Number.isSafeInteger(runtime.process.pid) || runtime.process.pid < 1) return null
    if (typeof runtime.process.identity !== 'string' || runtime.process.identity === '') return null
  }
  if (value.windowsHostArtifacts !== undefined && !hasSafeWindowsHostArtifacts(runtime)) return null
  return runtime
}

function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value)
    return url.protocol === 'https:' || url.protocol === 'http:'
  } catch {
    return false
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
