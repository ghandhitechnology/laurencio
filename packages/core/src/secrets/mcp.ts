import { applyEdits, modify, type ParseError, parse as parseJsonc } from 'jsonc-parser'
import { parse as parseToml, stringify as stringifyToml } from 'smol-toml'
import type { McpSecretVaultReference } from '../profile'
import type { HarnessId } from '../types'
import { allowlistReason, isSensitiveSecretValue } from './patterns'
import { envVarName, looksLikeSecretValue } from './placeholders'

type ObjectValue = Record<string, unknown>
function object(value: unknown): value is ObjectValue {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export interface DiscoveredMcpSecret {
  reference: McpSecretVaultReference
  /** Null for an existing native environment reference. Never log this object. */
  value: string | null
}

/** Only named MCP server fields are eligible; unrelated configuration is never a vault source. */
export function discoverMcpSecrets(
  harness: HarnessId,
  content: string,
): { content: string; secrets: DiscoveredMcpSecret[] } {
  let document: unknown
  try {
    if (harness === 'codex') document = parseToml(content)
    else {
      const errors: ParseError[] = []
      document = parseJsonc(content, errors, { allowTrailingComma: true })
      if (errors.length > 0) return { content, secrets: [] }
    }
  } catch {
    return { content, secrets: [] }
  }
  if (!object(document)) return { content, secrets: [] }
  const root = harness === 'codex' ? 'mcp_servers' : harness === 'opencode' ? 'mcp' : 'mcpServers'
  const servers = document[root]
  if (!object(servers)) return { content, secrets: [] }
  const secrets: DiscoveredMcpSecret[] = []
  let changed = false
  let rewritten = content
  const groups = [{ values: servers, path: [root] }]
  if (harness === 'opencode' && object(servers.servers))
    groups.push({ values: servers.servers, path: [root, 'servers'] })
  const definitions = groups.flatMap((group) =>
    Object.entries(group.values)
      .filter(
        ([name]) => !(harness === 'opencode' && group.path.length === 1 && name === 'servers'),
      )
      .map(([server, definition]) => ({ server, definition, serverPath: group.path })),
  )
  for (const { server, definition, serverPath } of definitions) {
    if (!object(definition)) continue
    // These identifiers become vault addresses, so ambiguous names fail closed elsewhere.
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(server)) continue
    const add = (env: string, value: string | null): void => {
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(env)) return
      const previous = secrets.find(
        (entry) => entry.reference.server === server && entry.reference.env === env,
      )
      if (previous !== undefined && (value === null || previous.value === value)) return
      if (previous !== undefined && previous.value === null) {
        previous.value = value
        return
      }
      secrets.push({
        reference: {
          kind: 'mcp-secret',
          name: `${harness}-${server}-${env}`,
          harness,
          vault: 'laurencio',
          item: server,
          field: env,
          server,
          env,
        },
        value,
      })
    }
    const fields =
      harness === 'codex'
        ? ['env', 'http_headers']
        : [harness === 'opencode' ? 'environment' : 'env', 'headers']
    for (const field of fields) {
      const values = definition[field]
      if (!object(values)) continue
      for (const [key, value] of Object.entries(values)) {
        if (typeof value !== 'string') continue
        const native =
          harness === 'opencode'
            ? /\{env:([A-Za-z_][A-Za-z0-9_]*)\}/g
            : /\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g
        const matched = harness === 'codex' ? [] : [...value.matchAll(native)]
        if (matched.length > 0) {
          for (const match of matched) if (match[1] !== undefined) add(match[1], null)
          continue
        }
        if (
          !isSensitiveSecretValue(key, value) &&
          (!looksLikeSecretValue(value) || allowlistReason(value) !== null)
        )
          continue
        const env =
          harness === 'codex' && field === 'env'
            ? key
            : envVarName(
                server,
                field === 'headers' || field === 'http_headers' ? `header_${key}` : key,
              )
        if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(env)) continue
        add(env, value)
        if (harness === 'codex') {
          delete values[key]
          if (field === 'http_headers') {
            const headers = object(definition.env_http_headers) ? definition.env_http_headers : {}
            headers[key] = env
            definition.env_http_headers = headers
          } else {
            const existing = Array.isArray(definition.env_vars)
              ? definition.env_vars.filter((item): item is string => typeof item === 'string')
              : []
            definition.env_vars = [...new Set([...existing, env])]
          }
        } else {
          values[key] = harness === 'opencode' ? `{env:${env}}` : `\${${env}}`
          rewritten = applyEdits(
            rewritten,
            modify(rewritten, [...serverPath, server, field, key], values[key], {}),
          )
        }
        changed = true
      }
    }
    if (harness === 'codex') {
      for (const env of Array.isArray(definition.env_vars) ? definition.env_vars : []) {
        if (
          typeof env === 'string' &&
          !secrets.some((entry) => entry.reference.server === server && entry.reference.env === env)
        )
          add(env, null)
      }
      if (typeof definition.bearer_token_env_var === 'string')
        add(definition.bearer_token_env_var, null)
      if (object(definition.env_http_headers))
        for (const env of Object.values(definition.env_http_headers))
          if (typeof env === 'string') add(env, null)
    }
  }
  return {
    content: changed
      ? harness === 'codex'
        ? stringifyToml(document as Parameters<typeof stringifyToml>[0])
        : rewritten
      : content,
    secrets,
  }
}
