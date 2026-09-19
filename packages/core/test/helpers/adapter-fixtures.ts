import { SurfaceId } from '@laurencio/protocol'
import type {
  FileFormat,
  FileSurface,
  HarnessAdapter,
  HarnessId,
  KeyedFileSurface,
  MergeStrategy,
  Policy,
  Surface,
  TreeSurface,
} from '../../src/types'

export function testAdapter(
  id: HarnessId,
  surfaces: Surface[],
  displayName = `${id} test adapter`,
): HarnessAdapter {
  return {
    id,
    displayName,
    detect: () => ({ installed: true, version: 'test', configRoots: [], notes: [] }),
    surfaces: () => surfaces,
  }
}

export interface TreeOptions {
  id: string
  path: string
  policy?: Policy
  exclude?: string[]
  merge?: MergeStrategy
  shared?: boolean
  transforms?: TreeSurface['transforms']
  secretRules?: TreeSurface['secretRules']
}

export function tree(options: TreeOptions): TreeSurface {
  return {
    id: SurfaceId.parse(options.id),
    harness: options.id.split('.')[0] as HarnessId,
    kind: 'tree',
    path: options.path,
    policy: options.policy ?? 'sync',
    description: options.id,
    format: 'mixed',
    merge: options.merge ?? 'text3way',
    exclude: options.exclude ?? [],
    transforms: options.transforms ?? [],
    secretRules: options.secretRules ?? [],
    ...(options.shared === true ? { shared: true as const } : {}),
  }
}

export interface FileOptions {
  id: string
  path: string
  format?: FileFormat
  policy?: Policy
  merge?: MergeStrategy
}

export function file(options: FileOptions): FileSurface {
  return {
    id: SurfaceId.parse(options.id),
    harness: options.id.split('.')[0] as HarnessId,
    kind: 'file',
    path: options.path,
    policy: options.policy ?? 'sync',
    description: options.id,
    format: options.format ?? 'text',
    merge: options.merge ?? 'text3way',
    transforms: [],
    secretRules: [],
  }
}

export function keyedFile(options: FileOptions): KeyedFileSurface {
  return {
    id: SurfaceId.parse(options.id),
    harness: options.id.split('.')[0] as HarnessId,
    kind: 'keyed-file',
    path: options.path,
    policy: options.policy ?? 'sync',
    description: options.id,
    format: 'toml',
    merge: 'tomlKeyMerge',
    transforms: [],
    secretRules: [],
    keyPolicy: { sync: [], machine: [], ignore: [] },
  }
}
