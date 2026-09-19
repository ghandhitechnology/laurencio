import { SurfaceId } from '@laurencio/protocol'
import type {
  AdapterContext,
  FileFormat,
  FileSurface,
  KeyedFileSurface,
  KeyPolicy,
  MergeStrategy,
  Policy,
  Surface,
  TransformSpec,
  TreeSurface,
} from '../../types'
import { CODEX_MACHINE_KEYS, CODEX_PORTABLE_KEYS } from './transforms'

const sid = SurfaceId.parse

/** `${CODEX_HOME}` defaults to `$HOME/.codex` in `paths.tokenValue`. */
const CODEX_HOME = `\${CODEX_HOME}`
const AGENTS_SKILLS = '$HOME/.agents/skills'

const SKILL_EXCLUDES = ['**/node_modules/**']

/**
 * Bulk machine state that has no dedicated surface. The `codex.home` tree excludes these
 * instead of walking them, so a scan of a real home stays fast; none of them upload.
 */
const CODEX_HOME_EXCLUDES = [
  '.tmp',
  'ambient-suggestions',
  'artifacts',
  'attachments',
  'backups',
  'browser',
  'computer-use',
  'ipc',
  'node_repl',
  'packages',
  'pets',
  'process_manager',
  'prompts',
  'shell_snapshots',
  'thread-writer-locks',
  'vendor_imports',
  'visualizations',
]

const CODEX_KEY_POLICY: KeyPolicy = {
  sync: [...CODEX_PORTABLE_KEYS],
  machine: [...CODEX_MACHINE_KEYS],
  ignore: [],
}

interface FileOptions {
  id: string
  path: string
  format: FileFormat
  description: string
  policy?: Policy
  merge?: MergeStrategy
  transforms?: TransformSpec[]
}

function codexFile(options: FileOptions): FileSurface {
  return {
    id: sid(options.id),
    harness: 'codex',
    kind: 'file',
    path: options.path,
    policy: options.policy ?? 'sync',
    description: options.description,
    format: options.format,
    merge: options.merge ?? 'text3way',
    transforms: options.transforms ?? [],
    secretRules: [],
  }
}

interface TreeOptions {
  id: string
  path: string
  description: string
  policy?: Policy
  exclude?: string[]
  filePolicy?: TreeSurface['filePolicy']
  transforms?: TransformSpec[]
  shared?: boolean
}

function codexTree(options: TreeOptions): TreeSurface {
  return {
    id: sid(options.id),
    harness: 'codex',
    kind: 'tree',
    path: options.path,
    policy: options.policy ?? 'sync',
    description: options.description,
    format: 'mixed',
    merge: 'text3way',
    exclude: options.exclude ?? [],
    transforms: options.transforms ?? [],
    secretRules: [],
    ...(options.filePolicy === undefined ? {} : { filePolicy: options.filePolicy }),
    ...(options.shared === true ? { shared: true as const } : {}),
  }
}

function codexProfile(id: string, path: string, description: string): KeyedFileSurface {
  return {
    id: sid(id),
    harness: 'codex',
    kind: 'keyed-file',
    path,
    policy: 'sync',
    description,
    format: 'toml',
    merge: 'tomlKeyMerge',
    transforms: [{ kind: 'codexTomlSplit' }, { kind: 'pathTokenize' }],
    secretRules: [],
    keyPolicy: CODEX_KEY_POLICY,
  }
}

/** The complete Codex CLI surface map, keyed off the `CODEX_HOME` token. */
export function codexSurfaces(ctx: AdapterContext): Surface[] {
  const surfaces: Surface[] = [
    codexProfile(
      'codex.config',
      `${CODEX_HOME}/config.toml`,
      'portable preferences with trust, hook hashes, and marketplace sources stripped at the key level',
    ),
    codexProfile(
      'codex.default-profile',
      `${CODEX_HOME}/.config.toml`,
      'default profile-v2 overrides layered over config.toml',
    ),
    codexFile({
      id: 'codex.instructions',
      path: `${CODEX_HOME}/AGENTS.md`,
      format: 'markdown',
      description: 'global instruction chain',
    }),
    codexFile({
      id: 'codex.instructions-override',
      path: `${CODEX_HOME}/AGENTS.override.md`,
      format: 'markdown',
      description: 'global instructions override',
    }),
    codexFile({
      id: 'codex.hooks',
      path: `${CODEX_HOME}/hooks.json`,
      format: 'json',
      merge: 'jsonKeyMerge',
      transforms: [{ kind: 'pathTokenize' }],
      description: 'lifecycle commands with absolute paths tokenized',
    }),
    codexFile({
      id: 'codex.rules',
      path: `${CODEX_HOME}/rules/default.rules`,
      format: 'script',
      transforms: [{ kind: 'pathTokenize' }],
      description: 'Starlark execpolicy with absolute paths tokenized',
    }),
    codexTree({
      id: 'codex.skills',
      path: `${CODEX_HOME}/skills`,
      description: 'user skills',
      exclude: SKILL_EXCLUDES,
    }),
    codexTree({
      id: 'codex.agents-skills',
      path: AGENTS_SKILLS,
      description: 'shared agent skills read by Codex and OpenCode',
      exclude: SKILL_EXCLUDES,
      shared: true,
    }),
    codexTree({
      id: 'codex.automations',
      path: `${CODEX_HOME}/automations`,
      description: 'scheduled task definitions; cwds and run history stay on the device',
      transforms: [{ kind: 'codexAutomationSplit' }],
    }),
    codexFile({
      id: 'codex.auth',
      path: `${CODEX_HOME}/auth.json`,
      format: 'json',
      policy: 'never',
      description: 'tokens; Codex falls back to the OS keyring when this file is absent',
    }),
    codexFile({
      id: 'codex.global-state',
      path: `${CODEX_HOME}/.codex-global-state.json`,
      format: 'json',
      policy: 'never',
      description: 'window and app state',
    }),
    codexFile({
      id: 'codex.history',
      path: `${CODEX_HOME}/history.jsonl`,
      format: 'text',
      policy: 'never',
      description: 'prompt history',
    }),
    codexFile({
      id: 'codex.session-index',
      path: `${CODEX_HOME}/session_index.jsonl`,
      format: 'text',
      policy: 'never',
      description: 'session index',
    }),
    codexTree({
      id: 'codex.sessions',
      path: `${CODEX_HOME}/sessions`,
      policy: 'never',
      description: 'transcripts',
    }),
    codexTree({
      id: 'codex.archived-sessions',
      path: `${CODEX_HOME}/archived_sessions`,
      policy: 'never',
      description: 'archived transcripts',
    }),
    codexTree({
      id: 'codex.plugins',
      path: `${CODEX_HOME}/plugins`,
      policy: 'never',
      description: 'plugin cache; enable flags live in config.toml',
    }),
    codexTree({
      id: 'codex.cache',
      path: `${CODEX_HOME}/cache`,
      policy: 'never',
      description: 'caches',
    }),
    codexTree({
      id: 'codex.log',
      path: `${CODEX_HOME}/log`,
      policy: 'never',
      description: 'logs',
    }),
    codexTree({
      id: 'codex.tmp',
      path: `${CODEX_HOME}/tmp`,
      policy: 'never',
      description: 'scratch state',
    }),
    codexTree({
      id: 'codex.sqlite',
      path: `${CODEX_HOME}/sqlite`,
      policy: 'never',
      description: 'sqlite sidecar files',
    }),
    codexTree({
      id: 'codex.home',
      path: CODEX_HOME,
      policy: 'never',
      description: 'every other file under CODEX_HOME, including *_*.sqlite state and caches',
      exclude: CODEX_HOME_EXCLUDES,
      // Profile overrides live beside machine state; only `*.config.toml` syncs, and the
      // tree's transforms apply to exactly those files so machine keys never leave raw.
      transforms: [{ kind: 'codexTomlSplit' }, { kind: 'pathTokenize' }],
      filePolicy: [{ pattern: '*.config.toml', policy: 'sync' }],
    }),
  ]
  if (ctx.platform !== 'win32') {
    surfaces.push(
      codexTree({
        id: 'codex.managed',
        path: '/etc/codex',
        policy: 'never',
        description: 'admin layer',
      }),
    )
  }
  return surfaces
}
