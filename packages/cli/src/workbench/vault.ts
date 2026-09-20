import {
  CredentialAdapter,
  type CredentialBaseline,
  type CredentialIo,
  type CredentialOperationResult,
  type crypto,
  type Remote,
  type TokenEnv,
  Vault,
  type VaultReference,
  type VaultRemote,
} from '@laurencio/core'
import type { StoreId, VaultHead } from '@laurencio/protocol'

interface CredentialVaultInput {
  remote: Remote & VaultRemote
  storeId: StoreId
  key: crypto.KeyMaterial
  references: readonly VaultReference[]
  tokenEnv: TokenEnv
  io: CredentialIo
}

export interface CaptureCredentialVaultInput extends CredentialVaultInput {
  now?: () => string
}

export interface CaptureCredentialVaultResult {
  head: VaultHead | null
  results: CredentialOperationResult[]
}

export interface ReconcileCredentialVaultInput extends CredentialVaultInput {
  baselines: Readonly<Record<string, CredentialBaseline>>
  now?: () => string
}

export interface ReconcileCredentialVaultResult extends CaptureCredentialVaultResult {
  baselines: Record<string, CredentialBaseline>
}

const vaultContext = (storeId: StoreId) => ({ storeId, protocolVersion: 1 })

/** Captures explicitly referenced credentials and rotates one opaque remote vault snapshot. */
export async function captureCredentialVault(
  input: CaptureCredentialVaultInput,
): Promise<CaptureCredentialVaultResult> {
  const current = await input.remote.getVaultHead()
  let vault: Vault
  if (current === null) {
    vault = Vault.empty()
  } else {
    const ciphertext = await input.remote.getBlob(current.blob.id)
    try {
      vault = Vault.open(input.key, ciphertext, vaultContext(input.storeId))
    } finally {
      ciphertext.fill(0)
    }
  }

  try {
    const adapter = new CredentialAdapter(input.io, input.tokenEnv, input.now)
    const results = await adapter.capture(vault, input.references)
    if (!results.some((result) => result.status === 'captured')) return { head: current, results }

    const sealed = vault.seal(input.key, vaultContext(input.storeId))
    try {
      const blob = await input.remote.putBlob({ blobId: sealed.blobId, bytes: sealed.bytes })
      const head = await input.remote.putVaultHead({
        blob,
        expectedGeneration: current?.generation ?? null,
      })
      return { head, results }
    } finally {
      sealed.bytes.fill(0)
    }
  } finally {
    vault.zeroize()
  }
}

/** Pulls remote rotations, pushes local rotations, and refuses simultaneous credential changes. */
export async function reconcileCredentialVault(
  input: ReconcileCredentialVaultInput,
): Promise<ReconcileCredentialVaultResult> {
  const current = await input.remote.getVaultHead()
  let vault: Vault
  if (current === null) {
    vault = Vault.empty()
  } else {
    const ciphertext = await input.remote.getBlob(current.blob.id)
    try {
      vault = Vault.open(input.key, ciphertext, vaultContext(input.storeId))
    } finally {
      ciphertext.fill(0)
    }
  }

  try {
    const reconciled = await new CredentialAdapter(input.io, input.tokenEnv, input.now).reconcile(
      vault,
      input.references,
      input.baselines,
    )
    if (!reconciled.results.some((result) => result.status === 'captured')) {
      return { head: current, ...reconciled }
    }

    const sealed = vault.seal(input.key, vaultContext(input.storeId))
    try {
      const blob = await input.remote.putBlob({ blobId: sealed.blobId, bytes: sealed.bytes })
      const head = await input.remote.putVaultHead({
        blob,
        expectedGeneration: current?.generation ?? null,
      })
      return { head, ...reconciled }
    } finally {
      sealed.bytes.fill(0)
    }
  } finally {
    vault.zeroize()
  }
}

/** Restores a vault snapshot only into the caller-provided private targets. */
export async function materializeCredentialVault(
  input: CredentialVaultInput,
): Promise<CredentialOperationResult[]> {
  const head = await input.remote.getVaultHead()
  if (head === null) return []
  const ciphertext = await input.remote.getBlob(head.blob.id)
  let vault: Vault
  try {
    vault = Vault.open(input.key, ciphertext, vaultContext(input.storeId))
  } finally {
    ciphertext.fill(0)
  }
  try {
    return await new CredentialAdapter(input.io, input.tokenEnv).materialize(
      vault,
      input.references,
    )
  } finally {
    vault.zeroize()
  }
}
