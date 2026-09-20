import type { AdapterContext, AdapterDetection } from '../../types'
import { assertNever } from '../../types'
import { CODEX_MEMORY_UNSUPPORTED } from './transforms'

export const CODEX_HOME_ROOT = `\${CODEX_HOME}`

export type CodexCredentialStorage = 'auth.json' | 'keyring' | 'unknown'

const CREDENTIAL_PROBE_PREFIX = 'credential-storage:'

/**
 * Pure credential detection. The CLI edge stats the declared `auth.json` path and reports
 * the result as a probe note, so adapter code never opens the file or reads token values.
 */
export function codexCredentialStorage(ctx: AdapterContext): CodexCredentialStorage {
  for (const note of ctx.probes?.codex?.notes ?? []) {
    if (!note.startsWith(CREDENTIAL_PROBE_PREFIX)) continue
    const value = note.slice(CREDENTIAL_PROBE_PREFIX.length).trim()
    if (value === 'auth.json') return 'auth.json'
    if (value === 'keyring') return 'keyring'
    return 'unknown'
  }
  return 'unknown'
}

function credentialNote(storage: CodexCredentialStorage): string {
  switch (storage) {
    case 'auth.json':
      return 'credentials: auth.json file; portable profiles sync it through the encrypted credential vault'
    case 'keyring':
      return 'credentials: OS keyring; encrypted vault sync starts when auth.json is present'
    case 'unknown':
      return 'credentials: auth.json or OS keyring (not probed); encrypted vault sync uses auth.json when present'
    default:
      return assertNever(storage)
  }
}

export function codexDetect(ctx: AdapterContext): AdapterDetection {
  const probe = ctx.probes?.codex
  const notes = [...(probe?.notes ?? [])]
  notes.push(credentialNote(codexCredentialStorage(ctx)))
  if (ctx.env.CODEX_HOME !== undefined) notes.push(`CODEX_HOME override: ${ctx.env.CODEX_HOME}`)
  notes.push(
    `unsupported: Codex memory (${CODEX_MEMORY_UNSUPPORTED.path}): ${CODEX_MEMORY_UNSUPPORTED.reason}`,
  )
  return {
    installed: probe?.installed ?? false,
    ...(probe?.version === undefined ? {} : { version: probe.version }),
    configRoots: [CODEX_HOME_ROOT],
    notes,
  }
}
