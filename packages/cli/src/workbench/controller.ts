import fs from 'node:fs'
import path from 'node:path'
import type { RevisionId, WorkbenchSession, WorkbenchSessionId } from '@laurencio/protocol'
import type { WorkbenchClient } from './client'
import {
  type PendingWorkbench,
  parseWorkbenchRecord,
  type RegisteredWorkbench,
  type WorkbenchRegistry,
} from './registry'
import {
  type WorkbenchSession as RuntimeSession,
  type WorkbenchLaunch,
  WorkbenchLaunchError,
  type WorkbenchRuntime,
} from './runtime'

export interface WorkbenchMaterializeInput {
  server: string
  token: string
  remote: WorkbenchSession
  root: string
  home: string
  /** Mutable launch-only overlay for materialized credentials. */
  environment: NodeJS.ProcessEnv
  /** Host discoveries may be completed by verified tools installed during materialization. */
  executables: WorkbenchLaunch['executables']
}

export interface WorkbenchOpenInput {
  server: string
  accountBearer: string
  name: string
  platform: 'darwin' | 'win32'
  cwd: string
  executables: WorkbenchLaunch['executables']
  materialize(input: WorkbenchMaterializeInput): Promise<RevisionId | null>
}

export interface WorkbenchOpenResult {
  record: RegisteredWorkbench
  disposition: 'running' | 'closed'
}

export interface WorkbenchStatus {
  record: RegisteredWorkbench
  state: 'running' | 'stopped' | 'unknown'
}

export interface WorkbenchControllerDeps {
  runtime: WorkbenchRuntime
  registry: WorkbenchRegistry
  client(server: string, bearer: string): WorkbenchClient
  root(id: WorkbenchSessionId): string
}

/** Owns the boundary between the expiring server actor and its private terminal runtime. */
export class WorkbenchController {
  readonly #runtime: WorkbenchRuntime
  readonly #registry: WorkbenchRegistry
  readonly #client: WorkbenchControllerDeps['client']
  readonly #root: WorkbenchControllerDeps['root']

  constructor(deps: WorkbenchControllerDeps) {
    this.#runtime = deps.runtime
    this.#registry = deps.registry
    this.#client = deps.client
    this.#root = deps.root
  }

  async open(input: WorkbenchOpenInput): Promise<WorkbenchOpenResult> {
    const client = this.#client(input.server, input.accountBearer)
    const created = await client.create({ name: input.name, platform: input.platform })
    client.setBearer(created.token)
    const root = this.#root(created.session.id)
    const paths = input.platform === 'win32' ? path.win32 : path.posix
    const home = paths.join(root, 'home')
    const environment: NodeJS.ProcessEnv = {}
    const pending: PendingWorkbench = {
      remote: created.session,
      server: input.server,
      root,
      ownerPid: process.pid,
      phase: 'materializing',
    }
    let runtimeSession: RuntimeSession | null = null
    let registered = false
    try {
      fs.mkdirSync(home, { recursive: true, mode: 0o700 })
      fs.writeFileSync(paths.join(root, 'launch-owner.json'), JSON.stringify(pending), {
        mode: 0o600,
      })
      this.#registry.pending?.(pending)
      const revisionId = await input.materialize({
        server: input.server,
        token: created.token,
        remote: created.session,
        root,
        home,
        environment,
        executables: input.executables,
      })
      pending.phase = 'launching'
      fs.writeFileSync(paths.join(root, 'launch-owner.json'), JSON.stringify(pending), {
        mode: 0o600,
      })
      this.#registry.pending?.(pending)
      runtimeSession = await this.#runtime.launch({
        id: created.session.id,
        root,
        cwd: input.cwd,
        executables: input.executables,
        environment,
      })
      const record: RegisteredWorkbench = {
        remote: created.session,
        runtime: runtimeSession,
        server: input.server,
        revisionId,
      }
      this.#registry.save(record, created.token)
      registered = true
      await this.#runtime.attach(runtimeSession)
      const state = await this.#runtime.inspect(runtimeSession)
      if (state.state !== 'stopped') return { record, disposition: 'running' }
      await this.#closeRecord(record, created.token)
      return { record, disposition: 'closed' }
    } catch (error) {
      if (!registered) {
        try {
          await client.close(created.session.id)
        } catch {
          // The actor expires server-side even when cleanup cannot reach the service.
        }
        if (runtimeSession !== null) {
          try {
            await this.#runtime.close(runtimeSession)
          } catch {
            // Preserve an unknown live runtime rather than deleting its files.
          }
        } else if (!(error instanceof WorkbenchLaunchError)) {
          fs.rmSync(root, { recursive: true, force: true })
          this.#registry.forgetPending?.(created.session.id)
        }
      }
      throw error
    }
  }

  async statuses(): Promise<WorkbenchStatus[]> {
    const results: WorkbenchStatus[] = []
    for (const record of this.#registry.list()) {
      results.push({ record, state: (await this.#runtime.inspect(record.runtime)).state })
    }
    return results
  }

  async withSession<T>(
    id: WorkbenchSessionId,
    operation: (input: { record: RegisteredWorkbench; token: string }) => Promise<T>,
  ): Promise<T | null> {
    const record = this.#registry.get(id)
    if (record === null) return null
    const token = this.#registry.token(record)
    if (token === null) throw new Error(`workbench ${id} has no session token`)
    return operation({ record, token })
  }

  async close(id: WorkbenchSessionId): Promise<boolean> {
    const record = this.#registry.get(id)
    if (record === null) return false
    const token = this.#registry.token(record)
    if (token === null) await this.#closeLocal(record)
    else await this.#closeRecord(record, token)
    return true
  }

  async reap(): Promise<WorkbenchSessionId[]> {
    const removed: WorkbenchSessionId[] = []
    for (const pending of this.#registry.pendingList?.() ?? []) {
      // A live PID (including a reused PID) or an inspection failure retains the root.
      try {
        process.kill(pending.ownerPid, 0)
        continue
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ESRCH') continue
      }
      try {
        if (!fs.existsSync(pending.root)) {
          this.#registry.forgetPending?.(pending.remote.id)
          continue
        }
        if (!fs.lstatSync(pending.root).isDirectory()) continue
        const marker = JSON.parse(
          fs.readFileSync(path.join(pending.root, 'launch-owner.json'), 'utf8'),
        )
        if (JSON.stringify(marker) !== JSON.stringify(pending)) continue
        if (pending.phase === 'materializing') {
          fs.rmSync(pending.root, { recursive: true, force: true })
        } else {
          const runtime = JSON.parse(
            fs.readFileSync(path.join(pending.root, 'runtime-session.json'), 'utf8'),
          )
          const record = parseWorkbenchRecord({
            remote: pending.remote,
            server: pending.server,
            revisionId: null,
            runtime,
          })
          if (record === null || record.runtime.root !== pending.root) continue
          if ((await this.#runtime.inspect(record.runtime)).state !== 'stopped') continue
          await this.#runtime.close(record.runtime)
        }
        this.#registry.forgetPending?.(pending.remote.id)
        removed.push(pending.remote.id)
      } catch {
        // Partial records and unknown launch states remain available for recovery.
      }
    }
    for (const status of await this.statuses()) {
      if (status.state !== 'stopped') continue
      const token = this.#registry.token(status.record)
      if (token === null) await this.#closeLocal(status.record)
      else await this.#closeRecord(status.record, token)
      removed.push(status.record.remote.id)
    }
    return removed
  }

  async #closeRecord(record: RegisteredWorkbench, token: string): Promise<void> {
    const client = this.#client(record.server, token)
    try {
      await client.close(record.remote.id)
    } catch {
      // The expiring actor will close server-side; local secret cleanup still proceeds.
    }
    await this.#closeLocal(record)
  }

  async #closeLocal(record: RegisteredWorkbench): Promise<void> {
    await this.#runtime.close(record.runtime)
    if (fs.existsSync(record.runtime.root)) {
      throw new Error(`workbench private root still exists at ${record.runtime.root}`)
    }
    this.#registry.remove(record.remote.id)
  }
}
