import { SurfaceId } from '@laurencio/protocol'
import type {
  AdapterContext,
  FileFormat,
  FileSurface,
  MergeStrategy,
  Surface,
  TransformSpec,
  TreeSurface,
} from '../../types'
import { OPENCODE_CONFIG_ROOT } from './detect'
import { opencodeSkillOwnership } from './transforms'

/** Everything OpenCode writes under the data root is machine state: auth, sessions, OAuth. */
export const OPENCODE_DATA_ROOT = '$HOME/.local/share/opencode'
export const OPENCODE_STATE_ROOT = '$HOME/.local/state/opencode'
export const OPENCODE_CACHE_ROOT = '$HOME/.cache/opencode'
/** The user-built single source that the config dir symlinks into on this machine. */
export const OPENCODE_SOURCE_ROOT = '$HOME/.agents-opencode'

function configPath(relative: string): string {
  return `${OPENCODE_CONFIG_ROOT}/${relative}`
}

interface FileOptions {
  id: string
  path: string
  description: string
  format?: FileFormat
  merge?: MergeStrategy
  policy?: 'sync' | 'never'
  transforms?: TransformSpec[]
}

function file(options: FileOptions): FileSurface {
  return {
    id: SurfaceId.parse(`opencode.${options.id}`),
    harness: 'opencode',
    kind: 'file',
    path: options.path,
    policy: options.policy ?? 'sync',
    description: options.description,
    format: options.format ?? 'text',
    merge: options.merge ?? 'text3way',
    transforms: options.transforms ?? [],
    secretRules: [],
  }
}

interface TreeOptions {
  id: string
  path: string
  description: string
  policy?: 'sync' | 'never'
  exclude?: string[]
  transforms?: TransformSpec[]
}

function tree(options: TreeOptions): TreeSurface {
  return {
    id: SurfaceId.parse(`opencode.${options.id}`),
    harness: 'opencode',
    kind: 'tree',
    path: options.path,
    policy: options.policy ?? 'sync',
    description: options.description,
    format: 'mixed',
    merge: 'text3way',
    exclude: options.exclude ?? [],
    transforms: options.transforms ?? [],
    secretRules: [],
  }
}

const NEVER_SERVICE = 'Never synced: generated local service password.'
const NEVER_DATA = 'Never synced: credentials, sessions, and OAuth state live here.'
const NEVER_STATE = 'Never synced: last model, session, and prompt history are machine state.'
const NEVER_CACHE = 'Never synced: binaries and model lists are reproducible caches.'

/** The complete global surface map from DESIGN section 2. Paths are templates, expanded per machine. */
export function opencodeSurfaces(_ctx: AdapterContext): Surface[] {
  const schemaNormalize: TransformSpec[] = [
    { kind: 'opencodeSchemaNormalize' },
    { kind: 'pathTokenize' },
  ]
  return [
    file({
      id: 'config-json',
      path: configPath('opencode.json'),
      description: 'Global config (v1 and v2 share the file with different key shapes).',
      format: 'jsonc',
      merge: 'jsonKeyMerge',
      transforms: schemaNormalize,
    }),
    file({
      id: 'config-jsonc',
      path: configPath('opencode.jsonc'),
      description:
        'Global config, JSONC form (v1 and v2 share the file with different key shapes).',
      format: 'jsonc',
      merge: 'jsonKeyMerge',
      transforms: schemaNormalize,
    }),
    file({
      id: 'cli',
      path: configPath('cli.json'),
      description: 'v2 CLI preferences; absolute sound paths are tokenized.',
      format: 'jsonc',
      merge: 'jsonKeyMerge',
      transforms: [{ kind: 'pathTokenize' }],
    }),
    file({
      id: 'tui',
      path: configPath('tui.json'),
      description: 'v1 TUI preferences; absolute sound paths are tokenized.',
      format: 'jsonc',
      merge: 'jsonKeyMerge',
      transforms: [{ kind: 'pathTokenize' }],
    }),
    file({
      id: 'instructions',
      path: configPath('AGENTS.md'),
      description:
        'Global rules. Symlinked into the source tree on this machine; the link is preserved, never dereferenced.',
      format: 'markdown',
      transforms: [{ kind: 'markerBlocks' }],
    }),
    tree({
      id: 'agents',
      path: configPath('agents'),
      description: 'Global agent definitions; often a symlink into the source tree.',
    }),
    tree({
      id: 'commands',
      path: configPath('commands'),
      description: 'Global command definitions.',
    }),
    tree({
      id: 'skills',
      path: configPath('skills'),
      description: 'Global skills; often a symlink into the source tree.',
    }),
    tree({ id: 'themes', path: configPath('themes'), description: 'Global themes.' }),
    tree({
      id: 'plugins',
      path: configPath('plugins'),
      description: 'Local plugins; dependencies are excluded.',
      exclude: ['**/node_modules/**'],
    }),
    file({
      id: 'package',
      path: configPath('package.json'),
      description: 'Plugin dependency manifest.',
      format: 'json',
      merge: 'jsonKeyMerge',
    }),
    file({
      id: 'package-lock',
      path: configPath('package-lock.json'),
      description: 'npm dependency lockfile.',
      format: 'json',
      merge: 'jsonKeyMerge',
    }),
    file({
      id: 'bun-lock',
      path: configPath('bun.lock'),
      description: 'bun dependency lockfile.',
      format: 'jsonc',
      merge: 'jsonKeyMerge',
    }),
    tree({ id: 'tools', path: configPath('tools'), description: 'v1 custom tools.' }),
    tree({
      id: 'source',
      path: OPENCODE_SOURCE_ROOT,
      description:
        'User-built single source that config-dir AGENTS.md, agents, and skills symlink into. Syncs the content once; links stay links.',
    }),
    file({
      id: 'service',
      path: configPath('service.json'),
      description: NEVER_SERVICE,
      policy: 'never',
    }),
    tree({
      id: 'node-modules',
      path: configPath('node_modules'),
      description: 'Never synced: reinstalled dependencies.',
      policy: 'never',
    }),
    tree({
      id: 'data',
      path: OPENCODE_DATA_ROOT,
      description: NEVER_DATA,
      policy: 'never',
    }),
    file({
      id: 'auth',
      path: `${OPENCODE_DATA_ROOT}/auth.json`,
      description: NEVER_DATA,
      policy: 'never',
    }),
    file({
      id: 'database',
      path: `${OPENCODE_DATA_ROOT}/opencode.db`,
      description: `${NEVER_DATA} The v2 SQLite store holds sessions and secrets.`,
      policy: 'never',
    }),
    file({
      id: 'mcp-auth',
      path: `${OPENCODE_DATA_ROOT}/mcp-auth.json`,
      description: `${NEVER_DATA} OAuth tokens for MCP servers.`,
      policy: 'never',
    }),
    tree({ id: 'state', path: OPENCODE_STATE_ROOT, description: NEVER_STATE, policy: 'never' }),
    tree({ id: 'cache', path: OPENCODE_CACHE_ROOT, description: NEVER_CACHE, policy: 'never' }),
    ...opencodeSkillOwnership(),
  ]
}

export interface OpenCodeProjectSurface {
  path: string
  policy: 'never'
  reason: string
}

/**
 * Repo-owned and managed surfaces. They live outside any home root, and surface paths must
 * expand to absolute paths, so they are diagnostic declarations rather than scan surfaces.
 * The reason string is what the CLI shows when a user asks why project config never syncs.
 */
export const OPENCODE_PROJECT_SURFACES: readonly OpenCodeProjectSurface[] = [
  {
    path: '.opencode/',
    policy: 'never',
    reason: 'Project config travels with the repository git; Laurencio never syncs it.',
  },
  {
    path: 'opencode.json',
    policy: 'never',
    reason: 'Repo config travels with the repository git; Laurencio never syncs it.',
  },
  {
    path: 'opencode.jsonc',
    policy: 'never',
    reason: 'Repo config travels with the repository git; Laurencio never syncs it.',
  },
  {
    path: '.well-known/opencode/',
    policy: 'never',
    reason: 'Org defaults and admin policy are not user config; never synced.',
  },
]
