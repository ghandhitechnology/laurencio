import { SurfaceId } from '@laurencio/protocol'
import type {
  AdapterContext,
  FileFormat,
  FileSurface,
  MergeStrategy,
  Platform,
  Policy,
  SecretRule,
  Surface,
  TransformKind,
  TreeSurface,
} from '../../types'

const braced = (name: string): string => `\${${name}}`

/** Expands to `$HOME/.claude` when the variable is unset (see paths.ts). */
const CONFIG_ROOT = braced('CLAUDE_CONFIG_DIR')

/** `~/.claude.json` sits beside the config directory unless CLAUDE_CONFIG_DIR moves everything. */
function globalConfigPath(ctx: AdapterContext): string {
  const override = ctx.env.CLAUDE_CONFIG_DIR
  return override === undefined || override === ''
    ? '$HOME/.claude.json'
    : `${CONFIG_ROOT}/.claude.json`
}

interface FileOptions {
  policy?: Policy
  format?: FileFormat
  merge?: MergeStrategy
  transforms?: TransformKind[]
  secretRules?: SecretRule[]
}

function claudeFile(
  id: string,
  filePath: string,
  description: string,
  options: FileOptions = {},
): FileSurface {
  return {
    id: SurfaceId.parse(`claude.${id}`),
    harness: 'claude',
    kind: 'file',
    path: filePath,
    policy: options.policy ?? 'sync',
    description,
    format: options.format ?? 'text',
    merge: options.merge ?? 'text3way',
    transforms: (options.transforms ?? []).map((kind) => ({ kind })),
    secretRules: options.secretRules ?? [],
  }
}

interface TreeOptions {
  policy?: Policy
  merge?: MergeStrategy
  exclude?: string[]
  transforms?: TransformKind[]
  secretRules?: SecretRule[]
}

function claudeTree(
  id: string,
  treePath: string,
  description: string,
  options: TreeOptions = {},
): TreeSurface {
  return {
    id: SurfaceId.parse(`claude.${id}`),
    harness: 'claude',
    kind: 'tree',
    path: treePath,
    policy: options.policy ?? 'sync',
    description,
    format: 'mixed',
    merge: options.merge ?? 'text3way',
    exclude: options.exclude ?? [],
    transforms: (options.transforms ?? []).map((kind) => ({ kind })),
    secretRules: options.secretRules ?? [],
  }
}

/** Managed policy location for this platform; it is outside the home and never syncs. */
function managedPolicyPath(platform: Platform): string {
  switch (platform) {
    case 'darwin':
      return '/Library/Application Support/ClaudeCode'
    case 'linux':
      return '/etc/claude-code'
    case 'win32':
      return 'C:\\Program Files\\ClaudeCode'
  }
}

export function claudeSurfaces(ctx: AdapterContext): Surface[] {
  const surfaces: Surface[] = [
    claudeFile(
      'settings',
      `${CONFIG_ROOT}/settings.json`,
      'model, permissions, hooks, statusLine, theme, and plugin enablement; env secrets stay on the device',
      {
        format: 'json',
        merge: 'jsonKeyMerge',
        transforms: ['pathTokenize'],
        secretRules: [{ kind: 'scan' }, { kind: 'indirect' }],
      },
    ),
    claudeFile(
      'instructions',
      `${CONFIG_ROOT}/CLAUDE.md`,
      'personal instructions loaded in every project; local marker blocks stay on this device',
      {
        format: 'markdown',
        transforms: ['markerBlocks'],
      },
    ),
    claudeTree('rules', `${CONFIG_ROOT}/rules`, 'personal instruction files split by topic'),
    claudeTree('agents', `${CONFIG_ROOT}/agents`, 'personal subagents'),
    claudeTree('commands', `${CONFIG_ROOT}/commands`, 'personal slash commands'),
    claudeTree(
      'skills',
      `${CONFIG_ROOT}/skills`,
      'personal skills; claude.ai-synced skills stay local',
      {
        exclude: ['synced', 'synced/**'],
      },
    ),
    claudeTree('output-styles', `${CONFIG_ROOT}/output-styles`, 'personal output styles'),
    claudeTree('themes', `${CONFIG_ROOT}/themes`, 'personal themes'),
    claudeTree('workflows', `${CONFIG_ROOT}/workflows`, 'personal workflows'),
    claudeFile('keybindings', `${CONFIG_ROOT}/keybindings.json`, 'key rebinds', { format: 'json' }),
    claudeTree('hooks', `${CONFIG_ROOT}/hooks`, 'hook scripts referenced by settings', {
      transforms: ['pathTokenize'],
    }),
    claudeFile(
      'statusline',
      `${CONFIG_ROOT}/statusline.sh`,
      'status line script referenced by settings',
      {
        format: 'script',
        transforms: ['pathTokenize'],
      },
    ),
    claudeFile(
      'plugins-installed',
      `${CONFIG_ROOT}/plugins/installed_plugins.json`,
      'plugin install records without machine paths or timestamps',
      { format: 'json', transforms: ['claudePluginRecords'] },
    ),
    claudeFile(
      'plugins-known-marketplaces',
      `${CONFIG_ROOT}/plugins/known_marketplaces.json`,
      'marketplace sources without machine paths or timestamps',
      { format: 'json', transforms: ['claudePluginRecords'] },
    ),
    claudeFile(
      'mcp',
      globalConfigPath(ctx),
      'user-scope MCP servers extracted from ~/.claude.json; the file itself never syncs',
      { format: 'json', transforms: ['claudeMcpExtract'], secretRules: [{ kind: 'scan' }] },
    ),
    // Auto memory shares the projects/ tree with session transcripts, so the memory surface
    // owns the tree and excludes everything that is not a <slug>/memory path before it is read.
    claudeTree(
      'memory',
      `${CONFIG_ROOT}/projects`,
      'auto memory per repository; slug re-keyed and machine state excluded',
      {
        policy: 'opt-in',
        transforms: ['claudeSlugRekey'],
        exclude: ['*/!(memory)', '*/!(memory)/**', '*.*', '**/.*'],
      },
    ),
    claudeFile('credentials', `${CONFIG_ROOT}/.credentials.json`, 'OAuth tokens', {
      policy: 'never',
      format: 'json',
    }),
    claudeFile(
      'local-settings',
      `${CONFIG_ROOT}/settings.local.json`,
      'machine-local permission grants',
      {
        policy: 'never',
        format: 'json',
      },
    ),
    claudeFile('history', `${CONFIG_ROOT}/history.jsonl`, 'prompt history', { policy: 'never' }),
    claudeFile('stats', `${CONFIG_ROOT}/stats-cache.json`, 'usage stats cache', {
      policy: 'never',
      format: 'json',
    }),
    claudeTree('sessions', `${CONFIG_ROOT}/sessions`, 'session state', { policy: 'never' }),
    claudeTree('shell-snapshots', `${CONFIG_ROOT}/shell-snapshots`, 'shell snapshots', {
      policy: 'never',
    }),
    claudeTree('backups', `${CONFIG_ROOT}/backups`, 'automatic backups of ~/.claude.json', {
      policy: 'never',
    }),
    claudeTree('cache', `${CONFIG_ROOT}/cache`, 'changelog and model catalog caches', {
      policy: 'never',
    }),
    claudeTree('jobs', `${CONFIG_ROOT}/jobs`, 'background job state', { policy: 'never' }),
    claudeTree('daemon', `${CONFIG_ROOT}/daemon`, 'daemon control state', { policy: 'never' }),
    claudeTree('plugins-cache', `${CONFIG_ROOT}/plugins/cache`, 'downloaded plugin copies', {
      policy: 'never',
    }),
    claudeTree(
      'plugins-marketplaces',
      `${CONFIG_ROOT}/plugins/marketplaces`,
      'downloaded marketplace copies',
      {
        policy: 'never',
      },
    ),
    claudeTree('plugins-data', `${CONFIG_ROOT}/plugins/data`, 'plugin local data', {
      policy: 'never',
    }),
    claudeTree('plugins-synced', `${CONFIG_ROOT}/plugins/synced`, 'account-keyed claude.ai sync', {
      policy: 'never',
    }),
    // Catch-all so every path under the config root is classified, including state a future
    // version adds. Named never surfaces above still declare the known DESIGN rows.
    claudeTree(
      'state',
      CONFIG_ROOT,
      'anything else under the config directory, including session state and caches',
      {
        policy: 'never',
      },
    ),
  ]

  surfaces.push(
    claudeTree('managed-policy', managedPolicyPath(ctx.platform), 'organization-managed policy', {
      policy: 'never',
    }),
  )

  return surfaces
}
