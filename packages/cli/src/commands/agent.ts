import { supportsProfile, type VaultReference } from '@laurencio/core'
import { selectedCredentialReferences } from '../credential-sync'
import { cliError } from '../errors'
import { fail, ok } from '../result'
import { openSession } from '../session'
import { createSystemCredentialIo, type DurableMcpCredentials } from '../workbench/credentials'
import { loadPortableProfile } from '../workbench/profile'
import type { CommandSpec } from './command'

/** Read only selected OS-store entries; never persist a plaintext launch environment. */
export async function agentEnvironment(
  inherited: Record<string, string | undefined>,
  references: readonly VaultReference[],
  durable: DurableMcpCredentials,
): Promise<Record<string, string | undefined>> {
  const restored: Record<string, string | undefined> = {}
  for (const reference of references) {
    if (reference.kind !== 'mcp-secret') continue
    // A launch is read-only: each account gets an empty bootstrap environment.
    const scoped: Record<string, string | undefined> = {}
    const io = createSystemCredentialIo(scoped, { durableMcp: durable })
    const previous = restored[reference.env]
    const value = await io.readMcpSecret(reference.harness, reference.server, reference.env)
    if (value === null)
      throw cliError(
        'mcp-secret-missing',
        'A selected MCP credential is missing from the OS credential store',
      )
    value?.fill(0)
    if (previous !== undefined && previous !== scoped[reference.env]) {
      throw cliError(
        'mcp-environment-conflict',
        'MCP servers require different values for the same environment variable',
      )
    }
    restored[reference.env] = scoped[reference.env]
  }
  return { ...inherited, ...restored }
}

export const agentCommand: CommandSpec = {
  name: 'agent',
  summary: 'Launch an enrolled agent with selected MCP credentials',
  usage: 'laurencio agent <claude|codex|opencode> -- [agent arguments]',
  details: [
    'Reads selected MCP secrets from the OS credential store into the child process environment.',
  ],
  async run(ctx) {
    if (ctx.platform !== 'darwin' && ctx.platform !== 'win32') {
      throw cliError('unsupported-platform', 'agent launches support macOS and Windows')
    }
    const harness = ctx.positionals[0]
    if (!harness || !['claude', 'codex', 'opencode'].includes(harness)) {
      throw cliError('unknown-harness', 'choose claude, codex, or opencode')
    }
    const executable = (ctx.deps.which ?? Bun.which)(harness)
    if (!executable) throw cliError('missing-agent', `${harness} is not installed`)
    const session = await openSession(ctx)
    try {
      const stored = supportsProfile(session.remote)
        ? await loadPortableProfile({
            remote: session.remote,
            storeId: session.credentials.storeId,
            key: session.credentials.key,
          })
        : null
      const references = selectedCredentialReferences(
        stored?.profile.vault ?? [],
        session.config.policy,
        [harness],
      )
      const environment = await agentEnvironment(ctx.env, references, {
        platform: ctx.platform,
        ...(ctx.deps.keychain === undefined ? {} : { keychain: ctx.deps.keychain }),
      })
      const code = await (
        ctx.deps.launchAgent ??
        (async (input) => {
          const child = Bun.spawn([input.executable, ...input.args], {
            cwd: input.cwd,
            env: input.environment,
            stdin: 'inherit',
            stdout: 'inherit',
            stderr: 'inherit',
          })
          return child.exited
        })
      )({ executable, args: ctx.positionals.slice(1), cwd: ctx.cwd, environment })
      return code === 0
        ? ok({ harness, exitCode: code }, () => '')
        : fail('agent-exited', `${harness} exited with code ${code}`)
    } finally {
      session.credentials.key.zeroize()
    }
  },
}
