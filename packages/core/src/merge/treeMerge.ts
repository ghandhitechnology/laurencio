/**
 * Keyed three-way merge over parsed JSON-ish and TOML trees. Format modules
 * turn the resulting ops into text edits; the value rules live here once.
 */

export interface KeyConflict {
  path: string[]
  base: unknown
  local: unknown
  remote: unknown
}

export type KeyMergeOp =
  | { kind: 'set'; path: string[]; value: unknown; origin: 'remote' | 'union' }
  | { kind: 'delete'; path: string[]; origin: 'remote' }

export interface KeyMergePlan {
  ops: KeyMergeOp[]
  conflicts: KeyConflict[]
}

export interface KeyMergeOptions {
  /** Dot-joined key paths whose arrays merge by union; everything else conflicts. */
  unionArrays?: readonly string[]
  /**
   * TOML arrays of tables: merge element by element when both sides have the
   * same shape. Off for JSON, where array order is positional.
   */
  mergeObjectArraysByIndex?: boolean
}

export function planKeyMerge(
  base: unknown,
  local: unknown,
  remote: unknown,
  options: KeyMergeOptions = {},
): KeyMergePlan {
  const plan: KeyMergePlan = { ops: [], conflicts: [] }
  walk(base, local, remote, [], options, plan)
  return plan
}

function walk(
  base: unknown,
  local: unknown,
  remote: unknown,
  path: string[],
  options: KeyMergeOptions,
  plan: KeyMergePlan,
): void {
  if (deepEqual(local, remote)) return
  if (
    options.mergeObjectArraysByIndex === true &&
    Array.isArray(base) &&
    Array.isArray(local) &&
    Array.isArray(remote) &&
    base.length === local.length &&
    local.length === remote.length &&
    local.every(isPlainObject) &&
    remote.every(isPlainObject)
  ) {
    for (let index = 0; index < local.length; index++) {
      walk(base[index], local[index], remote[index], [...path, String(index)], options, plan)
    }
    return
  }
  if (deepEqual(base, local)) {
    // Local is unchanged, so the remote version wins or the key was deleted.
    if (remote === undefined) {
      plan.ops.push({ kind: 'delete', path, origin: 'remote' })
      return
    }
    if (isPlainObject(base) && isPlainObject(local) && isPlainObject(remote)) {
      walkChildren(base, local, remote, path, options, plan)
      return
    }
    if (isUnionArray(path, options) && Array.isArray(remote)) {
      plan.ops.push({
        kind: 'set',
        path,
        value: mergeArrayUnion(base, local, remote),
        origin: 'union',
      })
      return
    }
    plan.ops.push({ kind: 'set', path, value: remote, origin: 'remote' })
    return
  }
  if (deepEqual(base, remote)) return
  // Both sides changed differently. Objects merge key by key so untouched keys
  // from either side survive; anything else is a conflict and stays local.
  if (isPlainObject(local) && isPlainObject(remote)) {
    walkChildren(base, local, remote, path, options, plan)
    return
  }
  if (isUnionArray(path, options) && Array.isArray(local) && Array.isArray(remote)) {
    plan.ops.push({
      kind: 'set',
      path,
      value: mergeArrayUnion(base, local, remote),
      origin: 'union',
    })
    return
  }
  plan.conflicts.push({ path, base, local, remote })
}

function walkChildren(
  base: unknown,
  local: Record<string, unknown>,
  remote: Record<string, unknown>,
  path: string[],
  options: KeyMergeOptions,
  plan: KeyMergePlan,
): void {
  const keys = new Set([...Object.keys(local), ...Object.keys(remote)])
  if (isPlainObject(base)) for (const key of Object.keys(base)) keys.add(key)
  for (const key of keys) {
    walk(
      readKey(base, key),
      readKey(local, key),
      readKey(remote, key),
      [...path, key],
      options,
      plan,
    )
  }
}

/** Base order first, then new items from local, then remote; duplicates collapse. */
function mergeArrayUnion(base: unknown, local: unknown, remote: unknown): unknown[] {
  const items: unknown[] = []
  for (const side of [base, local, remote]) {
    if (!Array.isArray(side)) continue
    for (const item of side) {
      if (!items.some((existing) => deepEqual(existing, item))) items.push(item)
    }
  }
  return items
}

function isUnionArray(path: readonly string[], options: KeyMergeOptions): boolean {
  const joined = path.join('.')
  return options.unionArrays?.includes(joined) === true
}

export function deepEqual(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true
  if (a === null || b === null || a === undefined || b === undefined) return false
  if (a instanceof Date || b instanceof Date) {
    return a instanceof Date && b instanceof Date && Object.is(a.getTime(), b.getTime())
  }
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false
    return a.every((item, index) => deepEqual(item, b[index]))
  }
  if (isPlainObject(a) && isPlainObject(b)) {
    const aKeys = Object.keys(a)
    const bKeys = Object.keys(b)
    if (aKeys.length !== bKeys.length) return false
    return aKeys.every((key) => Object.hasOwn(b, key) && deepEqual(a[key], b[key]))
  }
  return false
}

export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === 'object' && value !== null && !Array.isArray(value) && !(value instanceof Date)
  )
}

function readKey(value: unknown, key: string): unknown {
  return isPlainObject(value) ? value[key] : undefined
}
