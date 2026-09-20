import { createHash, timingSafeEqual } from 'node:crypto'
import { expand, type TokenEnv } from '../paths'
import type { AgentAuthVaultReference, McpSecretVaultReference, VaultReference } from '../profile'
import type { Vault } from '../vault'

const INSPECT = Symbol.for('nodejs.util.inspect.custom')
const PRIVATE_FILE_MODE = 0o600
const ID_COMPONENT = /^[A-Za-z0-9][A-Za-z0-9._-]*$/
const VAULT_ID = /^[a-z0-9][a-z0-9._:-]{0,127}$/

export interface CredentialIo {
  /** Returns an owned byte buffer, or null when the file does not exist. */
  readFile(path: string): Promise<Uint8Array | null>
  /** Replaces a file through a same-directory atomic rename with the requested mode. */
  writeFileAtomic(path: string, value: Uint8Array, mode: number): Promise<void>
  /** Reads an MCP value scoped to one harness and named server. */
  readMcpSecret(
    harness: VaultReference['harness'],
    server: string,
    env: string,
  ): Promise<Uint8Array | null>
  /** Writes an MCP value for one harness and named server. */
  writeMcpSecret(
    harness: VaultReference['harness'],
    server: string,
    env: string,
    value: Uint8Array,
  ): Promise<void>
}

export type CredentialOperationStatus =
  | 'captured'
  | 'materialized'
  | 'missing'
  | 'unchanged'
  | 'conflict'

export interface CredentialBaseline {
  version: number
  digest: string
}

export interface CredentialReconcileResult {
  results: CredentialOperationResult[]
  baselines: Record<string, CredentialBaseline>
}

export interface CredentialOperationResult {
  name: string
  kind: VaultReference['kind']
  harness: VaultReference['harness']
  recordId: string
  status: CredentialOperationStatus
  version?: number
}

interface PreparedAgentReference {
  kind: 'agent-auth'
  reference: AgentAuthVaultReference
  recordId: string
  path: string
}

interface PreparedMcpReference {
  kind: 'mcp-secret'
  reference: McpSecretVaultReference
  recordId: string
}

type PreparedReference = PreparedAgentReference | PreparedMcpReference

export class CredentialAdapterError extends Error {
  readonly operation: 'capture' | 'materialize' | 'validate'
  readonly reference?: string

  constructor(
    operation: 'capture' | 'materialize' | 'validate',
    message: string,
    reference?: string,
  ) {
    super(message)
    this.name = 'CredentialAdapterError'
    this.operation = operation
    if (reference !== undefined) this.reference = reference
  }
}

/**
 * Moves explicitly referenced credentials between native targets and an encrypted Vault.
 * Values remain opaque and every returned result contains metadata only.
 */
export class CredentialAdapter {
  readonly #io: CredentialIo
  readonly #tokenEnv: TokenEnv
  readonly #now: () => string

  constructor(
    io: CredentialIo,
    tokenEnv: TokenEnv,
    now: () => string = () => new Date().toISOString(),
  ) {
    this.#io = io
    this.#tokenEnv = tokenEnv
    this.#now = now
    Object.defineProperty(this, INSPECT, {
      value: () => '[CredentialAdapter]',
      enumerable: false,
    })
  }

  async capture(
    vault: Vault,
    references: readonly VaultReference[],
    selected?: readonly string[],
  ): Promise<CredentialOperationResult[]> {
    const prepared = selectReferences(prepareReferences(references, this.#tokenEnv), selected)
    const versions = new Map(vault.list().map((record) => [record.id, record.version]))
    const results: CredentialOperationResult[] = []

    for (const entry of prepared) {
      const value =
        entry.kind === 'agent-auth' ? await this.#readFile(entry) : await this.#readMcpSecret(entry)
      if (value === null) {
        results.push(resultOf(entry, 'missing'))
        continue
      }
      const previous = vault.read(entry.recordId)
      try {
        const previousVersion = versions.get(entry.recordId)
        if (
          previous !== null &&
          previousVersion !== undefined &&
          previous.length === value.length &&
          timingSafeEqual(previous, value)
        ) {
          results.push(resultOf(entry, 'unchanged', previousVersion))
          continue
        }
        const metadata = vault.put({
          id: entry.recordId,
          kind: entry.reference.kind,
          provider:
            entry.reference.kind === 'agent-auth'
              ? entry.reference.harness
              : entry.reference.server.toLowerCase(),
          value,
          expectedVersion: versions.get(entry.recordId) ?? null,
          updatedAt: this.#now(),
        })
        versions.set(entry.recordId, metadata.version)
        results.push(resultOf(entry, 'captured', metadata.version))
      } finally {
        previous?.fill(0)
        value.fill(0)
      }
    }
    return results
  }

  async materialize(
    vault: Vault,
    references: readonly VaultReference[],
    selected?: readonly string[],
  ): Promise<CredentialOperationResult[]> {
    const prepared = selectReferences(prepareReferences(references, this.#tokenEnv), selected)
    const versions = new Map(vault.list().map((record) => [record.id, record.version]))
    const results: CredentialOperationResult[] = []

    for (const entry of prepared) {
      const value = vault.read(entry.recordId)
      const version = versions.get(entry.recordId)
      if (value === null || version === undefined) {
        value?.fill(0)
        results.push(resultOf(entry, 'missing'))
        continue
      }
      try {
        if (entry.kind === 'agent-auth') {
          await this.#writeFile(entry, value)
        } else {
          await this.#writeMcpSecret(entry, value)
        }
        results.push(resultOf(entry, 'materialized', version))
      } finally {
        value.fill(0)
      }
    }
    return results
  }

  /**
   * Reconciles native credentials against a versioned vault without allowing a stale device to
   * overwrite a rotation. A first-seen local/remote divergence is a conflict; later one-sided
   * changes flow in either direction and simultaneous changes are reported as conflicts.
   */
  async reconcile(
    vault: Vault,
    references: readonly VaultReference[],
    baselines: Readonly<Record<string, CredentialBaseline>>,
  ): Promise<CredentialReconcileResult> {
    const prepared = prepareReferences(references, this.#tokenEnv)
    const versions = new Map(vault.list().map((record) => [record.id, record.version]))
    const nextBaselines: Record<string, CredentialBaseline> = { ...baselines }
    const results: CredentialOperationResult[] = []

    for (const entry of prepared) {
      const local =
        entry.kind === 'agent-auth' ? await this.#readFile(entry) : await this.#readMcpSecret(entry)
      const remote = vault.read(entry.recordId)
      try {
        const remoteVersion = versions.get(entry.recordId)
        if (local === null && (remote === null || remoteVersion === undefined)) {
          results.push(resultOf(entry, 'missing'))
          delete nextBaselines[entry.recordId]
          continue
        }
        if (remote === null || remoteVersion === undefined) {
          if (local === null) continue
          const metadata = this.#captureValue(vault, entry, local, null)
          versions.set(entry.recordId, metadata.version)
          nextBaselines[entry.recordId] = baselineOf(metadata.version, local)
          results.push(resultOf(entry, 'captured', metadata.version))
          continue
        }
        if (local === null) {
          await this.#writeValue(entry, remote)
          nextBaselines[entry.recordId] = baselineOf(remoteVersion, remote)
          results.push(resultOf(entry, 'materialized', remoteVersion))
          continue
        }
        if (equalBytes(local, remote)) {
          nextBaselines[entry.recordId] = baselineOf(remoteVersion, remote)
          results.push(resultOf(entry, 'unchanged', remoteVersion))
          continue
        }

        const baseline = baselines[entry.recordId]
        if (baseline === undefined) {
          results.push(resultOf(entry, 'conflict', remoteVersion))
          continue
        }
        if (baseline.version === remoteVersion) {
          const metadata = this.#captureValue(vault, entry, local, remoteVersion)
          versions.set(entry.recordId, metadata.version)
          nextBaselines[entry.recordId] = baselineOf(metadata.version, local)
          results.push(resultOf(entry, 'captured', metadata.version))
          continue
        }
        if (baseline.digest !== digest(local)) {
          results.push(resultOf(entry, 'conflict', remoteVersion))
          continue
        }

        await this.#writeValue(entry, remote)
        nextBaselines[entry.recordId] = baselineOf(remoteVersion, remote)
        results.push(resultOf(entry, 'materialized', remoteVersion))
      } finally {
        local?.fill(0)
        remote?.fill(0)
      }
    }

    return { results, baselines: nextBaselines }
  }

  toString(): string {
    return '[CredentialAdapter]'
  }

  async #readFile(entry: PreparedAgentReference): Promise<Uint8Array | null> {
    try {
      return await this.#io.readFile(entry.path)
    } catch {
      throw new CredentialAdapterError(
        'capture',
        'could not read credential file',
        entry.reference.name,
      )
    }
  }

  async #writeFile(entry: PreparedAgentReference, value: Uint8Array): Promise<void> {
    try {
      await this.#io.writeFileAtomic(entry.path, value, PRIVATE_FILE_MODE)
    } catch {
      throw new CredentialAdapterError(
        'materialize',
        'could not write credential file',
        entry.reference.name,
      )
    }
  }

  async #readMcpSecret(entry: PreparedMcpReference): Promise<Uint8Array | null> {
    try {
      return await this.#io.readMcpSecret(
        entry.reference.harness,
        entry.reference.server,
        entry.reference.env,
      )
    } catch {
      throw new CredentialAdapterError(
        'capture',
        'could not read MCP credential',
        entry.reference.name,
      )
    }
  }

  async #writeMcpSecret(entry: PreparedMcpReference, value: Uint8Array): Promise<void> {
    try {
      await this.#io.writeMcpSecret(
        entry.reference.harness,
        entry.reference.server,
        entry.reference.env,
        value,
      )
    } catch {
      throw new CredentialAdapterError(
        'materialize',
        'could not write MCP credential',
        entry.reference.name,
      )
    }
  }

  async #writeValue(entry: PreparedReference, value: Uint8Array): Promise<void> {
    if (entry.kind === 'agent-auth') await this.#writeFile(entry, value)
    else await this.#writeMcpSecret(entry, value)
  }

  #captureValue(
    vault: Vault,
    entry: PreparedReference,
    value: Uint8Array,
    expectedVersion: number | null,
  ) {
    return vault.put({
      id: entry.recordId,
      kind: entry.reference.kind,
      provider:
        entry.reference.kind === 'agent-auth'
          ? entry.reference.harness
          : entry.reference.server.toLowerCase(),
      value,
      expectedVersion,
      updatedAt: this.#now(),
    })
  }
}

function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
  return left.length === right.length && timingSafeEqual(left, right)
}

function digest(value: Uint8Array): string {
  return createHash('sha256').update(value).digest('hex')
}

function baselineOf(version: number, value: Uint8Array): CredentialBaseline {
  return { version, digest: digest(value) }
}

export function vaultRecordId(reference: VaultReference): string {
  const parts =
    reference.kind === 'agent-auth'
      ? [reference.kind, reference.harness, reference.name]
      : [reference.kind, reference.harness, reference.server, reference.env]
  for (const part of parts) assertIdComponent(part, reference.name)
  const id = parts.map((part) => part.toLowerCase()).join(':')
  if (!VAULT_ID.test(id)) {
    throw new CredentialAdapterError(
      'validate',
      `credential reference ${reference.name} is too long`,
    )
  }
  return id
}

function prepareReferences(
  references: readonly VaultReference[],
  tokenEnv: TokenEnv,
): PreparedReference[] {
  const seen = new Map<string, string>()
  return references.map((reference) => {
    const recordId = vaultRecordId(reference)
    const collision = seen.get(recordId)
    if (collision !== undefined) {
      throw new CredentialAdapterError(
        'validate',
        `credential references ${collision} and ${reference.name} resolve to the same vault record`,
      )
    }
    seen.set(recordId, reference.name)
    if (reference.kind === 'agent-auth') {
      return { kind: reference.kind, reference, recordId, path: expand(reference.path, tokenEnv) }
    }
    return { kind: reference.kind, reference, recordId }
  })
}

function assertIdComponent(value: string, reference: string): void {
  if (!ID_COMPONENT.test(value)) {
    throw new CredentialAdapterError(
      'validate',
      `credential reference ${reference} has an invalid vault id component`,
      reference,
    )
  }
}

function selectReferences(
  references: PreparedReference[],
  selected: readonly string[] | undefined,
): PreparedReference[] {
  if (selected === undefined) return references
  const names = new Set(references.map((entry) => entry.reference.name))
  const requested = new Set(selected)
  for (const name of requested) {
    if (!names.has(name)) {
      throw new CredentialAdapterError('validate', `unknown credential reference: ${name}`, name)
    }
  }
  return references.filter((entry) => requested.has(entry.reference.name))
}

function resultOf(
  entry: PreparedReference,
  status: CredentialOperationStatus,
  version?: number,
): CredentialOperationResult {
  return {
    name: entry.reference.name,
    kind: entry.reference.kind,
    harness: entry.reference.harness,
    recordId: entry.recordId,
    status,
    ...(version === undefined ? {} : { version }),
  }
}
