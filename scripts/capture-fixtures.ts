/**
 * Fixture lever: walk a real harness directory read-only and write a redacted structural
 * report plus sanitized file bodies under packages/core/test/fixtures/<harness>/<version>/.
 *
 * Usage:
 *   bun scripts/capture-fixtures.ts --harness claude --root ~/.claude --version 2.1.5
 *
 * Rerun it when a harness updates; the output diff shows what the adapter must change.
 * Structure and bodies are deterministic (no timestamps), and a final leak gate refuses to
 * leave identity strings in the output.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

interface CaptureArgs {
  harness: string
  root: string
  version: string
  out: string
  maxBytes: number
  maxFiles: number
}

interface RedactionCounts {
  home: number
  roots: number
  account: number
  secretValue: number
  secretToken: number
}

interface StructureEntry {
  path: string
  kind: 'file' | 'dir' | 'symlink' | 'other'
  size: number
  mode: number
  linkTarget: string | null
  /** Path of the sanitized body relative to the capture root, or null when none was kept. */
  body: string | null
  bodyReason: 'secret-name' | 'binary' | 'too-large' | null
}

/** Filenames whose capture is a credential hazard, matched case-insensitively. */
const secretNamePatterns = [
  /^\.credentials\.json$/i,
  /^auth\.json$/i,
  /^service\.json$/i,
  /^mcp-auth\.json$/i,
  /^settings\.local\.json$/i,
  /^id_(rsa|ed25519|ecdsa|dsa)$/i,
  /^\.env(\.|$)/i,
  /\.(pem|key|p12|pfx|jks)$/i,
  /^credentials\.(json|toml|yaml|yml)$/i,
  /^secrets?\.(json|toml|yaml|yml)$/i,
  /(^|[-_.])token(s)?([-_.]|$)/i,
]

function isSecretName(name: string): boolean {
  return secretNamePatterns.some((pattern) => pattern.test(name))
}

function usage(): never {
  console.error(
    [
      'usage: bun scripts/capture-fixtures.ts --harness <id> --root <dir> [--version <v>]',
      '       [--out <dir>] [--max-bytes <n>] [--max-files <n>]',
    ].join('\n'),
  )
  process.exit(1)
}

function parseArgs(argv: string[]): CaptureArgs {
  const values = new Map<string, string>()
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index]
    if (flag === undefined || !flag.startsWith('--')) usage()
    const next = argv[index + 1]
    if (next === undefined || next.startsWith('--')) usage()
    values.set(flag.slice(2), next)
    index += 1
  }
  const harness = values.get('harness')
  const root = values.get('root')
  if (harness === undefined || root === undefined) usage()
  const maxBytes = Number(values.get('max-bytes') ?? '262144')
  const maxFiles = Number(values.get('max-files') ?? '20000')
  if (!Number.isFinite(maxBytes) || !Number.isFinite(maxFiles)) usage()
  return {
    harness,
    root: path.resolve(root.replace(/^~(?=\/|$)/, os.homedir())),
    version: values.get('version') ?? 'unknown',
    out: path.resolve(values.get('out') ?? 'packages/core/test/fixtures'),
    maxBytes,
    maxFiles,
  }
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * Identity replacement deliberately ignores the preceding character: JSONL transcripts
 * escape newlines, so `pyu@host` often sits right after the letter `n`. The lookahead keeps
 * it from eating words that merely start with the name (`pyupgrade`).
 */
function identityPattern(needle: string): RegExp {
  return new RegExp(`${escapeRegExp(needle)}(?![A-Za-z0-9_])`, 'g')
}

function replaceAll(text: string, find: string, replace: string): [string, number] {
  if (find === '' || !text.includes(find)) return [text, 0]
  const parts = text.split(find)
  return [parts.join(replace), parts.length - 1]
}

interface Redactor {
  redact(text: string): [string, RedactionCounts]
}

function createRedactor(root: string): Redactor {
  const home = os.homedir()
  const substitutions: { find: string; replace: string; countKey: 'home' | 'roots' }[] = [
    { find: home, replace: '$HOME', countKey: 'home' },
  ]
  for (const name of ['CODEX_HOME', 'CLAUDE_CONFIG_DIR', 'XDG_CONFIG_HOME']) {
    const value = process.env[name]
    if (value !== undefined && value !== '' && value !== home) {
      substitutions.push({ find: value, replace: `\${${name}}`, countKey: 'roots' })
    }
  }
  // A capture root outside home (a scratch tree in tests) still gets a stable token.
  if (root !== home && !root.startsWith(home + path.sep)) {
    substitutions.push({ find: root, replace: '$CAPTURE_ROOT', countKey: 'roots' })
  }
  substitutions.sort((a, b) => b.find.length - a.find.length)

  const identities = [
    { find: os.userInfo().username, replace: '$USER' },
    { find: os.hostname(), replace: '$HOST' },
    { find: os.hostname().split('.')[0] ?? '', replace: '$HOST' },
  ].filter((identity) => identity.find.length >= 3)

  const secretValuePattern =
    /("?(?:api[_-]?key|token|secret|password|authorization|access[_-]?token|refresh[_-]?token|client[_-]?secret)"?\s*[:=]\s*)("[^"]*"|'[^']*'|[^\s,}\]]+)/gi
  const secretTokenPattern =
    /(sk-[A-Za-z0-9_-]{8,}|ghp_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|xox[baprs]-[A-Za-z0-9-]{8,}|AKIA[0-9A-Z]{16}|-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----)/g
  const accountPattern = /[\w.+-]+@[\w-]+\.[\w.-]+/g

  return {
    redact(text: string): [string, RedactionCounts] {
      const counts: RedactionCounts = {
        home: 0,
        roots: 0,
        account: 0,
        secretValue: 0,
        secretToken: 0,
      }
      let result = text
      for (const substitution of substitutions) {
        const [next, hits] = replaceAll(result, substitution.find, substitution.replace)
        result = next
        counts[substitution.countKey] += hits
      }
      for (const identity of identities) {
        result = result.replace(identityPattern(identity.find), () => {
          counts.account += 1
          return identity.replace
        })
      }
      result = result.replace(accountPattern, () => {
        counts.account += 1
        return '<account@example.invalid>'
      })
      result = result.replace(secretValuePattern, (_match, prefix: string) => {
        counts.secretValue += 1
        return `${prefix}"<redacted>"`
      })
      result = result.replace(secretTokenPattern, () => {
        counts.secretToken += 1
        return '[redacted-secret]'
      })
      return [result, counts]
    },
  }
}

function isBinary(buffer: Buffer): boolean {
  return buffer.subarray(0, 8192).includes(0)
}

interface WalkState {
  entries: StructureEntry[]
  bodies: number
  files: number
  truncated: boolean
}

function walk(state: WalkState, args: CaptureArgs, dir: string, rel: string): void {
  const names = fs.readdirSync(dir).sort()
  for (const name of names) {
    if (state.files >= args.maxFiles) {
      state.truncated = true
      return
    }
    const localPath = path.join(dir, name)
    const relPath = rel === '' ? name : `${rel}/${name}`
    let stat: fs.Stats
    try {
      stat = fs.lstatSync(localPath)
    } catch {
      continue
    }
    const entry: StructureEntry = {
      path: relPath,
      kind: 'other',
      size: stat.size,
      mode: stat.mode & 0o777,
      linkTarget: null,
      body: null,
      bodyReason: null,
    }
    if (stat.isSymbolicLink()) {
      entry.kind = 'symlink'
      try {
        entry.linkTarget = fs.readlinkSync(localPath)
      } catch {
        entry.linkTarget = null
      }
      state.entries.push(entry)
      continue
    }
    if (stat.isDirectory()) {
      entry.kind = 'dir'
      state.entries.push(entry)
      walk(state, args, localPath, relPath)
      continue
    }
    if (!stat.isFile()) {
      state.entries.push(entry)
      continue
    }
    entry.kind = 'file'
    state.files += 1
    if (isSecretName(name)) {
      entry.bodyReason = 'secret-name'
      state.entries.push(entry)
      continue
    }
    if (stat.size > args.maxBytes) {
      entry.bodyReason = 'too-large'
      state.entries.push(entry)
      continue
    }
    const buffer = fs.readFileSync(localPath)
    if (isBinary(buffer)) {
      entry.bodyReason = 'binary'
      state.entries.push(entry)
      continue
    }
    entry.body = relPath
    state.entries.push(entry)
  }
}

/**
 * Last gate before a fixture lands: fail closed when an identity string survives redaction.
 * A capture that cannot be redacted cleanly is worse than no capture.
 */
function findIdentityLeaks(target: string): string[] {
  const needles = [os.userInfo().username, os.hostname(), os.hostname().split('.')[0] ?? '']
    .filter((needle) => needle.length >= 3)
    .map((needle) => identityPattern(needle))
  const leaks: string[] = []
  const visit = (dir: string): void => {
    for (const name of fs.readdirSync(dir).sort()) {
      const localPath = path.join(dir, name)
      const stat = fs.lstatSync(localPath)
      if (stat.isDirectory()) {
        visit(localPath)
        continue
      }
      const text = fs.readFileSync(localPath, 'utf8')
      if (needles.some((pattern) => pattern.test(text))) {
        leaks.push(path.relative(target, localPath))
      }
    }
  }
  visit(target)
  return leaks
}

function main(): void {
  const args = parseArgs(process.argv.slice(2))
  if (!fs.existsSync(args.root) || !fs.statSync(args.root).isDirectory()) {
    console.error(`root is not a directory: ${args.root}`)
    process.exit(1)
  }
  if (args.root.startsWith(args.out + path.sep)) {
    console.error(`output directory ${args.out} is inside the source root`)
    process.exit(1)
  }
  const target = path.join(args.out, args.harness, args.version)
  fs.rmSync(target, { recursive: true, force: true })
  fs.mkdirSync(target, { recursive: true })

  const state: WalkState = { entries: [], bodies: 0, files: 0, truncated: false }
  walk(state, args, args.root, '')

  const redactor = createRedactor(args.root)
  const counts: RedactionCounts = { home: 0, roots: 0, account: 0, secretValue: 0, secretToken: 0 }
  const mergeCounts = (delta: RedactionCounts): void => {
    counts.home += delta.home
    counts.roots += delta.roots
    counts.account += delta.account
    counts.secretValue += delta.secretValue
    counts.secretToken += delta.secretToken
  }

  for (const entry of state.entries) {
    const [safePath, pathCounts] = redactor.redact(entry.path)
    entry.path = safePath
    mergeCounts(pathCounts)
    if (entry.linkTarget !== null) {
      const [safeTarget, targetCounts] = redactor.redact(entry.linkTarget)
      entry.linkTarget = safeTarget
      mergeCounts(targetCounts)
    }
    if (entry.body === null) continue
    const bodySource = path.join(args.root, entry.body)
    const [safeBody, bodyCounts] = redactor.redact(fs.readFileSync(bodySource, 'utf8'))
    mergeCounts(bodyCounts)
    const bodyPath = path.join('bodies', entry.path)
    const bodyTarget = path.join(target, bodyPath)
    fs.mkdirSync(path.dirname(bodyTarget), { recursive: true })
    fs.writeFileSync(bodyTarget, safeBody)
    entry.body = bodyPath.split(path.sep).join('/')
    state.bodies += 1
  }

  const [sourceRoot, rootCounts] = redactor.redact(args.root)
  mergeCounts(rootCounts)
  const structure = {
    harness: args.harness,
    version: args.version,
    sourceRoot,
    truncated: state.truncated,
    redactions: counts,
    entries: state.entries,
  }
  fs.writeFileSync(path.join(target, 'structure.json'), `${JSON.stringify(structure, null, 2)}\n`)

  const leaked = findIdentityLeaks(target)
  if (leaked.length > 0) {
    console.error(`redaction failed: identity strings survived in ${leaked.slice(0, 5).join(', ')}`)
    process.exit(1)
  }
  console.log(
    `captured ${state.entries.length} entries (${state.bodies} bodies, ${state.files} files) to ${path.relative(process.cwd(), target)}`,
  )
}

main()
