import type { AdapterContext, AdapterDetection } from '../../types'

const braced = (name: string): string => `\${${name}}`

/**
 * Pure detection. The CLI edge gathers the `claude --version` probe; the adapter only
 * reads the probe channel and the environment, so it stays testable and I/O free.
 */
export function detectClaude(ctx: AdapterContext): AdapterDetection {
  const probe = ctx.probes?.claude
  const notes: string[] = []
  const override = ctx.env.CLAUDE_CONFIG_DIR
  if (override !== undefined && override !== '') {
    notes.push('CLAUDE_CONFIG_DIR overrides the default ~/.claude config root')
  }
  if (probe === undefined) {
    notes.push('no claude probe was collected; version is unknown')
  } else {
    notes.push(...probe.notes)
  }
  return {
    installed: probe?.installed ?? false,
    ...(probe?.version === undefined ? {} : { version: probe.version }),
    configRoots: [braced('CLAUDE_CONFIG_DIR')],
    notes,
  }
}
