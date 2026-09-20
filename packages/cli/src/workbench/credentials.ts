import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { type CredentialIo, crypto, type HarnessId } from '@laurencio/core'

export const MCP_KEYCHAIN_SERVICE = 'laurencio-mcp'

export interface DurableMcpCredentials {
  platform: 'darwin' | 'win32'
  /** Tests and embedded callers can provide the same keychain used by enrollment. */
  keychain?: crypto.CredentialStore | null
  /** Injectable native keychain resolution. */
  loadKeyring?: () => Promise<crypto.CredentialStore>
}

export interface SystemCredentialIoOptions {
  /** Full mode persists MCP values; agent launches read them from the OS store. */
  durableMcp?: DurableMcpCredentials
}

function mcpAccount(harness: HarnessId, server: string, name: string): string {
  return `${harness}:${server}:${name}`.toLowerCase()
}

/** Native credential IO used only after a profile has explicitly selected a reference. */
export function createSystemCredentialIo(
  environment: Record<string, string | undefined>,
  options: SystemCredentialIoOptions = {},
): CredentialIo {
  const inherited = { ...environment }
  let keychain: Promise<crypto.CredentialStore> | null = null
  const durable = options.durableMcp

  const credentialStore = async (): Promise<crypto.CredentialStore> => {
    if (durable === undefined) throw new Error('durable MCP credentials are not configured')
    if (durable.keychain === null) throw new Error('the OS credential store is unavailable')
    if (durable.keychain !== undefined) return durable.keychain
    keychain ??= (durable.loadKeyring ?? crypto.resolveKeychainStore)()
    return await keychain
  }

  const publish = async (name: string, value: string): Promise<void> => {
    environment[name] = value
  }

  return {
    async readFile(filePath) {
      try {
        return new Uint8Array(fs.readFileSync(filePath))
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
        throw error
      }
    },

    async writeFileAtomic(filePath, value, mode) {
      const parent = path.dirname(filePath)
      fs.mkdirSync(parent, { recursive: true, mode: 0o700 })
      const temporary = path.join(parent, `.${path.basename(filePath)}.${randomUUID()}.tmp`)
      try {
        fs.writeFileSync(temporary, value, { flag: 'wx', mode })
        fs.chmodSync(temporary, mode)
        fs.renameSync(temporary, filePath)
      } finally {
        fs.rmSync(temporary, { force: true })
      }
    },

    async readMcpSecret(harness, server, name) {
      const value = durable === undefined ? environment[name] : inherited[name]
      if (durable === undefined) return value === undefined ? null : new TextEncoder().encode(value)

      const store = await credentialStore()
      const account = mcpAccount(harness, server, name)
      const saved = await store.get(MCP_KEYCHAIN_SERVICE, account)
      if (saved === null && value !== undefined) {
        const encoded = new TextEncoder().encode(value)
        try {
          await store.set(MCP_KEYCHAIN_SERVICE, account, encoded)
          await publish(name, value)
          return encoded.slice()
        } finally {
          encoded.fill(0)
        }
      }
      if (saved === null) return null
      try {
        const decoded = new TextDecoder('utf-8', { fatal: true }).decode(saved)
        await publish(name, decoded)
        return saved.slice()
      } finally {
        saved.fill(0)
      }
    },

    async writeMcpSecret(harness, server, name, value) {
      const decoded = new TextDecoder('utf-8', { fatal: true }).decode(value)
      if (durable !== undefined) {
        const copy = value.slice()
        try {
          await (await credentialStore()).set(
            MCP_KEYCHAIN_SERVICE,
            mcpAccount(harness, server, name),
            copy,
          )
        } finally {
          copy.fill(0)
        }
      }
      await publish(name, decoded)
    },
  }
}
