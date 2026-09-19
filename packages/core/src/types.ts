import type { SurfaceId } from '@laurencio/protocol'

/** The harnesses supported in v1. The registry accepts any string id for future harnesses. */
export type HarnessId = 'claude' | 'codex' | 'opencode'

export type Platform = 'darwin' | 'linux' | 'win32'

/** Result of a harness probe, supplied by the CLI so adapters stay pure. */
export interface HarnessProbe {
  installed: boolean
  version?: string
  notes: string[]
}

/** Directory context an adapter sees. Pure data; adapters never touch the filesystem themselves. */
export interface AdapterContext {
  home: string
  platform: Platform
  /** Environment values used for token expansion and root overrides. */
  env: Record<string, string | undefined>
  /** Version and install probes gathered at the CLI edge. */
  probes?: Partial<Record<HarnessId, HarnessProbe>>
}

/** `sync` participates. `opt-in` requires explicit enablement. `never` is classified but excluded. */
export type Policy = 'sync' | 'opt-in' | 'never'

export type FileFormat =
  | 'markdown'
  | 'json'
  | 'jsonc'
  | 'toml'
  | 'yaml'
  | 'script'
  | 'text'
  | 'binary'

export type MergeStrategy =
  | 'text3way'
  | 'jsonKeyMerge'
  | 'tomlKeyMerge'
  | 'binaryNewestWins'
  | 'appendUnion'
  | 'none'

export type TransformKind =
  | 'pathTokenize'
  | 'claudeSlugRekey'
  | 'claudeMcpExtract'
  | 'claudePluginRecords'
  | 'codexTomlSplit'
  | 'codexAutomationSplit'
  | 'opencodeSchemaNormalize'
  | 'markerBlocks'

export interface TransformSpec {
  kind: TransformKind
}

export type SecretRuleKind = 'deny' | 'scan' | 'indirect'

export interface SecretRule {
  kind: SecretRuleKind
  /** For `deny`, glob patterns that must never be uploaded. */
  patterns?: string[]
}

/** Key-level policy for files that mix portable and machine state. */
export interface KeyPolicy {
  sync: string[]
  machine: string[]
  ignore: string[]
}

interface SurfaceBase {
  id: SurfaceId
  harness: HarnessId
  /** Tokenized path, never absolute. `$HOME`, `${XDG_CONFIG_HOME}`, `${CODEX_HOME}`, `${CLAUDE_CONFIG_DIR}`. */
  path: string
  policy: Policy
  description: string
  transforms: TransformSpec[]
  secretRules: SecretRule[]
}

export interface TreeSurface extends SurfaceBase {
  kind: 'tree'
  format: 'mixed'
  merge: MergeStrategy
  /** Glob patterns excluded from a tree, for example `**​/node_modules/**`. */
  exclude: string[]
  /**
   * Per-file policy overrides for trees that mix portable files with machine state.
   * Patterns are globs against the POSIX path relative to the tree root, matched with
   * picomatch and dotfiles included, like `exclude`. First match wins; unmatched files
   * keep the tree policy.
   */
  filePolicy?: { pattern: string; policy: Policy }[]
  /** Reserved for shared trees another surface owns. */
  shared?: true
}

export interface FileSurface extends SurfaceBase {
  kind: 'file'
  format: FileFormat
  merge: MergeStrategy
}

export interface KeyedFileSurface extends SurfaceBase {
  kind: 'keyed-file'
  format: 'jsonc' | 'toml'
  merge: 'jsonKeyMerge' | 'tomlKeyMerge'
  keyPolicy: KeyPolicy
}

export type Surface = TreeSurface | FileSurface | KeyedFileSurface

export interface HarnessAdapter {
  id: HarnessId
  displayName: string
  /** Detected presence, versions, and effective config roots. Pure data, no I/O. */
  detect(ctx: AdapterContext): AdapterDetection
  /** The complete surface inventory for this harness. */
  surfaces(ctx: AdapterContext): Surface[]
}

export interface AdapterDetection {
  installed: boolean
  version?: string
  configRoots: string[]
  notes: string[]
}

export function assertNever(value: never): never {
  throw new Error(`unhandled variant: ${JSON.stringify(value)}`)
}

export function isSyncable(surface: Surface): boolean {
  return surface.policy === 'sync' || surface.policy === 'opt-in'
}
