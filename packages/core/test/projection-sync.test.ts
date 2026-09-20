/**
 * Projection pipeline integration. Real adapter surfaces drive the scan and the engine:
 * uploads must carry `toStore` projections (never raw bytes), manifest hashes must cover
 * those projections, opt-in surfaces need explicit policy, and a second HOME must expand
 * the stored tokens back into its own paths.
 */

import { describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { DeviceId, PROTOCOL_VERSION, RevisionId, StoreId, SurfaceId } from '@laurencio/protocol'
import { claudeAdapter, claudeSlug, claudeSurfaces } from '../src/adapters/claude'
import { codexAdapter } from '../src/adapters/codex'
import { opencodeAdapter } from '../src/adapters/opencode'
import { openText } from '../src/crypto/aead'
import { deriveMasterKey, type KdfParams, kdfParamsToWire } from '../src/crypto/kdf'
import { type SyncOptions, sync } from '../src/engine'
import type { DevicePolicy, Manifest, SyncReport } from '../src/model'
import { createFileRemote, type FileRemote } from '../src/remote/file'
import { envVarName } from '../src/secrets/placeholders'
import { SyncState, stateDbPath } from '../src/state'
import { applyTransforms, enforceUploadRules, TransformError } from '../src/transforms'
import type { HarnessAdapter, Surface, TransformKind } from '../src/types'
import { buildFakeHome, type FakeEntry, type FakeHome } from './helpers/fake-home'

const storeId = StoreId.parse('00000000000000000000000200')
const deviceA = DeviceId.parse('00000000000000000000000201')
const deviceB = DeviceId.parse('00000000000000000000000202')
const kdf: KdfParams = {
  algo: 'argon2id',
  salt: '00000000000000000000000000000000',
  m: 8,
  t: 1,
  p: 1,
  version: 0x13,
}
const key = deriveMasterKey('projection-pipeline', kdf)
const createdAt = '2026-02-01T00:00:00.000Z'

class Ids {
  #next = 10
  revision(): RevisionId {
    return RevisionId.parse(String(this.#next++).padStart(26, '0'))
  }
}

function tempDir(): string {
  return fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'laurencio-projection-'))
}

function must<T>(value: T | null | undefined, label: string): T {
  if (value === undefined || value === null) throw new Error(`missing ${label}`)
  return value
}

interface Engine {
  remoteDir: string
  run(home: FakeHome, deviceId: DeviceId, policy?: DevicePolicy): Promise<SyncReport>
  headManifest(): Promise<Manifest>
  blobFor(storePath: string): Promise<string | null>
  revisionCount(): Promise<number>
  cleanup(): void
}

function createEngine(adapters: readonly HarnessAdapter[]): Engine {
  const remoteDir = tempDir()
  const remote: FileRemote = createFileRemote({
    dir: remoteDir,
    storeId,
    kdf: kdfParamsToWire(kdf, createdAt),
    now: () => new Date(createdAt),
  })
  const ids = new Ids()
  const fileContext = { storeId, blobType: 'file' as const, protocolVersion: PROTOCOL_VERSION }
  const readManifest = async (): Promise<Manifest> => {
    const list = await remote.listRevisions()
    if (list.head === null) throw new Error('remote has no head revision')
    const text = openText(key, 'manifest', await remote.getManifest(list.head), {
      storeId,
      blobType: 'manifest',
      protocolVersion: PROTOCOL_VERSION,
    })
    return JSON.parse(text) as Manifest
  }
  return {
    remoteDir,
    async run(home, deviceId, policy) {
      const state = SyncState.open({ path: stateDbPath(home.home) })
      try {
        const options: SyncOptions = {
          adapters,
          ctx: home.ctx,
          deviceId,
          storeId,
          key,
          state,
          remote,
          quiescence: { windowMs: 0 },
          now: () => new Date(createdAt),
          createRevisionId: () => ids.revision(),
          ...(policy === undefined ? {} : { policy }),
        }
        return await sync(options)
      } finally {
        state.close()
      }
    },
    headManifest: readManifest,
    async blobFor(storePath) {
      const manifest = await readManifest()
      const entry = manifest.entries.find(
        (candidate) => candidate.path === storePath && candidate.kind === 'file',
      )
      if (entry?.blob === undefined) return null
      return openText(key, 'content', await remote.getBlob(entry.blob.id), fileContext)
    },
    async revisionCount() {
      return (await remote.listRevisions()).revisions.length
    },
    cleanup() {
      fs.rmSync(remoteDir, { recursive: true, force: true })
    },
  }
}

function claudeMemoryPolicy(): DevicePolicy {
  return {
    version: 1,
    harnesses: { claude: { enabled: true, surfaces: { 'claude.memory': 'on' } } },
    ignore: [],
    prune: false,
    cadence: { watch: false, intervalSeconds: 300 },
  }
}

function surfaceById(surfaces: readonly Surface[], id: string): Surface {
  const surface = surfaces.find((candidate) => candidate.id === SurfaceId.parse(id))
  if (surface === undefined) throw new Error(`missing surface ${id}`)
  return surface
}

const CLAUDE_JSON = '$HOME/.claude.json'
const CLAUDE_INSTRUCTIONS = `\${CLAUDE_CONFIG_DIR}/CLAUDE.md`
const CODEX_CONFIG = `\${CODEX_HOME}/config.toml`
const CODEX_INSTRUCTIONS = `\${CODEX_HOME}/AGENTS.md`
const CODEX_INSTRUCTIONS_OVERRIDE = `\${CODEX_HOME}/AGENTS.override.md`
const CODEX_WORK_PROFILE = `\${CODEX_HOME}/work.config.toml`
const OPENCODE_SOURCE_INSTRUCTIONS = '$HOME/.agents-opencode/agents.md'
const OPENCODE_SOURCE_TEXT = '$HOME/.agents-opencode/device.txt'

function claudeGlobalConfig(home: FakeHome, mcpCommand = 'npx'): string {
  return JSON.stringify(
    {
      oauthAccount: { emailAddress: 'person@example.com', organizationName: 'acme' },
      machineID: 'machine-1',
      userID: 'user-1',
      history: [{ display: 'a private prompt' }],
      projects: {
        [`${home.home}/projects/app`]: {
          trust_level: 'trusted',
          history: ['a per-project prompt'],
          mcpServers: { projectOnly: { command: 'project-scoped' } },
        },
      },
      mcpServers: {
        docs: {
          command: mcpCommand,
          args: ['-y', 'docs-server'],
          env: { DOCS_TOKEN: 'sk-ant-api03-abcdefghijklmnopqrstuvwxyz' },
        },
      },
    },
    null,
    2,
  )
}

function buildClaudeFixtureHome(options: { settings?: boolean } = {}): FakeHome {
  const entries: FakeEntry[] = [{ kind: 'dir', path: '.claude' }]
  if (options.settings !== false) {
    entries.push({ kind: 'file', path: '.claude/settings.json', content: '{"model":"opus"}\n' })
  }
  return buildFakeHome({ entries })
}

function codexConfigToml(home: FakeHome): string {
  const bin = `${home.home}/bin`
  const codex = `${home.home}/.codex`
  return `model = "gpt-5.6-codex"
approval_policy = "on-request"
notify = ["${bin}/notify", "turn-ended"]
profile = "fast"

[profiles.fast]
model = "gpt-5.6-codex-mini"

[features]
hooks = true

[hooks]
pre_tool_use = [{ command = "${bin}/check.sh" }]

[hooks.state."${codex}/hooks.json:session_start:0:0"]
trusted_hash = "sha256:1111111111111111111111111111111111111111111111111111111111111111"

[marketplaces.bundled]
source_type = "local"
source = "${codex}/.tmp/bundled-marketplaces/bundled"

[projects."${home.home}/projects/app"]
trust_level = "trusted"

[shell_environment_policy]
inherit = "core"

[shell_environment_policy.set]
PATH_EXTRA = "${home.home}/tools/bin"

[future_thing]
nested = { value = true }
`
}

function buildCodexFixtureHome(): FakeHome {
  const home = buildFakeHome({ entries: [{ kind: 'dir', path: '.codex' }] })
  home.write('.codex/config.toml', codexConfigToml(home))
  home.write('.codex/work.config.toml', 'model = "gpt-5.6-codex-mini"\n')
  home.write('.codex/AGENTS.md', '# global instructions\n')
  home.write('.claude.json', claudeGlobalConfig(home))
  return home
}

function walkFiles(root: string): string[] {
  if (!fs.existsSync(root)) return []
  const found: string[] = []
  for (const name of fs.readdirSync(root)) {
    const full = path.join(root, name)
    if (fs.statSync(full).isDirectory()) found.push(...walkFiles(full))
    else found.push(full)
  }
  return found
}

describe('projection pipeline over real adapters', () => {
  test('claude.mcp uploads mcpServers only and keeps identity, trust, and history local', async () => {
    const engine = createEngine([claudeAdapter])
    const home = buildClaudeFixtureHome()
    home.write('.claude.json', claudeGlobalConfig(home))

    const report = await engine.run(home, deviceA)
    expect(report.blocked).toEqual([])
    const uploaded = must(await engine.blobFor(CLAUDE_JSON), 'claude.mcp blob')

    const parsed = JSON.parse(uploaded) as Record<string, unknown>
    expect(Object.keys(parsed).sort()).toEqual(['mcpServers'])
    expect((parsed.mcpServers as Record<string, unknown>).docs).toMatchObject({
      command: 'npx',
      args: ['-y', 'docs-server'],
    })
    // The stored env value is a harness reference; the literal never leaves the device.
    const env = (parsed.mcpServers as { docs: { env: Record<string, string> } }).docs.env
    expect(env.DOCS_TOKEN).toBe(`\${DOCS_TOKEN}`)

    for (const absent of [
      'oauthAccount',
      'machineID',
      'userID',
      'person@example.com',
      'a private prompt',
      'a per-project prompt',
      'trusted',
      'project-scoped',
      home.home,
    ]) {
      expect([absent, uploaded.includes(absent)]).toEqual([absent, false])
    }
    home.cleanup()
    engine.cleanup()
  })

  test('codex config.toml uploads portable keys only and projection hashes absorb machine rewrites', async () => {
    const engine = createEngine([claudeAdapter, codexAdapter])
    const home = buildCodexFixtureHome()

    const report = await engine.run(home, deviceA)
    expect(report.blocked).toEqual([])
    const uploaded = must(await engine.blobFor(CODEX_CONFIG), 'config.toml blob')

    expect(uploaded).toContain('model = "gpt-5.6-codex"')
    expect(uploaded).toContain('$HOME/bin/check.sh')
    expect(uploaded).toContain('inherit = "core"')
    for (const machine of [
      '[projects',
      'hooks.state',
      'trusted_hash',
      'bundled-marketplaces',
      'PATH_EXTRA',
      'shell_environment_policy.set',
      'notify',
      'future_thing',
      home.home,
    ]) {
      expect([machine, uploaded.includes(machine)]).toEqual([machine, false])
    }

    // The profile override inside the never tree still travels, projected by the tree's transforms.
    const profile = must(await engine.blobFor(CODEX_WORK_PROFILE), 'work profile blob')
    expect(profile).toContain('gpt-5.6-codex-mini')
    expect(profile).not.toContain(home.home)

    const revisions = await engine.revisionCount()
    const head = (await engine.headManifest()).revisionId
    // Machine state rewrites project to the same bytes: no new revision, no upload.
    home.write('.codex/config.toml', codexConfigToml(home).replace('trusted', 'untrusted'))
    const config = JSON.parse(home.read('.claude.json')) as Record<string, unknown>
    config.oauthAccount = { emailAddress: 'someone-else@example.com' }
    config.machineID = 'machine-2'
    home.write('.claude.json', JSON.stringify(config))
    const idle = await engine.run(home, deviceA)
    expect(idle.changed).toEqual([])
    expect(idle.uploaded).toBe(0)
    expect(await engine.revisionCount()).toBe(revisions)
    expect((await engine.headManifest()).revisionId).toBe(head)

    home.cleanup()
    engine.cleanup()
  })

  test('global instruction marker blocks stay local across Claude and Codex', async () => {
    const engine = createEngine([claudeAdapter, codexAdapter])
    const instruction = (shared: string, local: string): string =>
      [
        '# Global instructions',
        shared,
        '<!-- laurencio:local -->',
        local,
        '<!-- /laurencio:local -->',
        '',
      ].join('\n')
    const files = [
      { relative: '.claude/CLAUDE.md', storePath: CLAUDE_INSTRUCTIONS },
      { relative: '.codex/AGENTS.md', storePath: CODEX_INSTRUCTIONS },
      { relative: '.codex/AGENTS.override.md', storePath: CODEX_INSTRUCTIONS_OVERRIDE },
    ] as const
    const entriesFor = (local: string): FakeEntry[] => [
      { kind: 'dir', path: '.claude' },
      { kind: 'dir', path: '.codex' },
      ...files.map(
        ({ relative }): FakeEntry => ({
          kind: 'file',
          path: relative,
          content: instruction('shared v1', local),
        }),
      ),
    ]
    const a = buildFakeHome({ entries: entriesFor('mini-only') })
    const b = buildFakeHome({ entries: entriesFor('laptop-only') })

    await engine.run(a, deviceA)
    await engine.run(b, deviceB)
    for (const { storePath } of files) {
      const stored = must(await engine.blobFor(storePath), `${storePath} blob`)
      expect(stored).toContain('shared v1')
      expect(stored).not.toContain('mini-only')
      expect(stored).not.toContain('laptop-only')
    }

    for (const { relative } of files) {
      a.write(relative, instruction('shared v2', 'mini-only'))
    }
    await engine.run(a, deviceA)
    await engine.run(b, deviceB)

    for (const { relative, storePath } of files) {
      expect(a.read(relative)).toContain('mini-only')
      expect(a.read(relative)).not.toContain('laptop-only')
      expect(b.read(relative)).toContain('shared v2')
      expect(b.read(relative)).toContain('laptop-only')
      expect(b.read(relative)).not.toContain('mini-only')
      const stored = must(await engine.blobFor(storePath), `${storePath} updated blob`)
      expect(stored).toContain('shared v2')
      expect(stored).not.toContain('mini-only')
      expect(stored).not.toContain('laptop-only')
    }

    a.cleanup()
    b.cleanup()
    engine.cleanup()
  })

  test('OpenCode source ownership preserves instruction markers without rewriting text files', async () => {
    const engine = createEngine([opencodeAdapter])
    const instruction = (shared: string, local: string): string =>
      [
        '# OpenCode instructions',
        shared,
        '<!-- laurencio:local -->',
        local,
        '<!-- /laurencio:local -->',
        '',
      ].join('\n')
    const sourceText = [
      'plain text',
      '<!-- laurencio:local -->',
      'this remains shared because the file is not Markdown',
      '<!-- /laurencio:local -->',
      '',
    ].join('\n')
    const entriesFor = (local: string): FakeEntry[] => [
      {
        kind: 'file',
        path: '.agents-opencode/agents.md',
        content: instruction('shared v1', local),
      },
      { kind: 'file', path: '.agents-opencode/device.txt', content: sourceText },
      {
        kind: 'file',
        path: '.config/opencode/AGENTS.md',
        link: '$HOME/.agents-opencode/agents.md',
      },
    ]
    const a = buildFakeHome({ entries: entriesFor('mini-only') })
    const b = buildFakeHome({ entries: entriesFor('laptop-only') })

    await engine.run(a, deviceA)
    const owned = (await engine.headManifest()).entries.find(
      (entry) => entry.path === OPENCODE_SOURCE_INSTRUCTIONS,
    )
    expect(owned?.surfaceId).toBe(SurfaceId.parse('opencode.source'))
    const firstStored = must(
      await engine.blobFor(OPENCODE_SOURCE_INSTRUCTIONS),
      'OpenCode source instructions blob',
    )
    expect(firstStored).toContain('shared v1')
    expect(firstStored).not.toContain('mini-only')
    expect(await engine.blobFor(OPENCODE_SOURCE_TEXT)).toBe(sourceText)

    await engine.run(b, deviceB)
    a.write('.agents-opencode/agents.md', instruction('shared v2', 'mini-only'))
    await engine.run(a, deviceA)
    await engine.run(b, deviceB)

    expect(b.read('.agents-opencode/agents.md')).toContain('shared v2')
    expect(b.read('.agents-opencode/agents.md')).toContain('laptop-only')
    expect(b.read('.agents-opencode/agents.md')).not.toContain('mini-only')
    expect(fs.lstatSync(b.path('.config/opencode/AGENTS.md')).isSymbolicLink()).toBe(true)
    expect(await engine.blobFor(OPENCODE_SOURCE_TEXT)).toBe(sourceText)

    a.cleanup()
    b.cleanup()
    engine.cleanup()
  })

  test('claude memory stays out by default and re-keys into the local slug when enabled', async () => {
    const engine = createEngine([claudeAdapter])
    const a = buildClaudeFixtureHome()
    const b = buildClaudeFixtureHome()
    const slugA = `${claudeSlug(a.home)}-projects-repo`
    const slugB = `${claudeSlug(b.home)}-projects-repo`
    a.write(`.claude/projects/${slugA}/memory/MEMORY.md`, '# shared memory\n')
    a.write(`.claude/projects/${slugA}/memory/topic.md`, '# topic\n')
    b.write(`.claude/projects/${slugB}/memory/topic.md`, '# topic\n')

    await engine.run(a, deviceA)
    await engine.run(b, deviceB)
    expect(
      (await engine.headManifest()).entries.some((entry) => entry.path.includes('/memory/')),
    ).toBe(false)
    expect(fs.existsSync(b.path(`.claude/projects/${slugB}/memory/MEMORY.md`))).toBe(false)

    await engine.run(a, deviceA, claudeMemoryPolicy())
    const memoryEntry = must(
      (await engine.headManifest()).entries.find((entry) => entry.path.endsWith('/MEMORY.md')),
      'memory manifest entry',
    )
    expect(memoryEntry.path).toMatch(
      /^\$\{CLAUDE_CONFIG_DIR\}\/projects\/memory\/path-[0-9a-f]{32}\/MEMORY\.md$/,
    )
    expect(memoryEntry.path).not.toContain(slugA)
    expect(memoryEntry.policy).toBe('opt-in')

    await engine.run(b, deviceB, claudeMemoryPolicy())
    expect(b.read(`.claude/projects/${slugB}/memory/MEMORY.md`)).toBe('# shared memory\n')
    const fallback = walkFiles(b.path('.claude/projects')).filter((file) =>
      file.includes(`${path.sep}memory${path.sep}`),
    )
    expect(fallback.every((file) => file.includes(slugB))).toBe(true)

    a.cleanup()
    b.cleanup()
    engine.cleanup()
  })

  test('a declared secret rule blocks a fixture file and the token never reaches the store', async () => {
    const engine = createEngine([claudeAdapter])
    const home = buildClaudeFixtureHome()
    home.write('.claude.json', claudeGlobalConfig(home, 'ghp_abcdefghijklmnopqrstuvwxyz0123456789'))

    const report = await engine.run(home, deviceA)
    expect(report.blocked).toContain(CLAUDE_JSON)
    expect((await engine.headManifest()).entries.some((entry) => entry.path === CLAUDE_JSON)).toBe(
      false,
    )
    const remoteBytes = walkFiles(engine.remoteDir)
      .map((file) => fs.readFileSync(file, 'latin1'))
      .join('\n')
    expect(remoteBytes).not.toContain('ghp_abcdefghijklmnopqrstuvwxyz0123456789')
    expect(home.read('.claude.json')).toContain('ghp_abc')

    home.cleanup()
    engine.cleanup()
  })

  test('indirect rewrites upload the rewritten bytes and the next run stays idle', async () => {
    const engine = createEngine([claudeAdapter])
    const home = buildClaudeFixtureHome()
    const raw = 'sk-ant-api03-5Kd9QpZx7Lm2Nr8TvB4Wc6Ye1Rf3Hg0J'
    home.write(
      '.claude/settings.json',
      `${JSON.stringify({ model: 'opus', env: { ANTHROPIC_API_KEY: raw } }, null, 2)}\n`,
    )

    const report = await engine.run(home, deviceA)
    expect(report.blocked).toEqual([])
    const uploaded = must(
      await engine.blobFor(`\${CLAUDE_CONFIG_DIR}/settings.json`),
      'settings blob',
    )
    expect(uploaded).not.toContain(raw)
    expect(uploaded).toContain(`\${${envVarName('settings', 'ANTHROPIC_API_KEY')}}`)

    // The manifest hash covers the rewritten bytes, so the literal re-projects to the same id.
    const idle = await engine.run(home, deviceA)
    expect(idle.changed).toEqual([])
    expect(idle.uploaded).toBe(0)

    home.cleanup()
    engine.cleanup()
  })

  test('path tokens round-trip into a second HOME with a different username', async () => {
    const engine = createEngine([claudeAdapter])
    const a = buildClaudeFixtureHome()
    const b = buildClaudeFixtureHome({ settings: false })
    a.write(
      '.claude/settings.json',
      `${JSON.stringify({ model: 'opus', statusLine: { command: `${a.home}/bin/status.sh` } }, null, 2)}\n`,
    )

    await engine.run(a, deviceA)
    const uploaded = must(
      await engine.blobFor(`\${CLAUDE_CONFIG_DIR}/settings.json`),
      'settings blob',
    )
    expect(uploaded).toContain('$HOME/bin/status.sh')
    expect(uploaded).not.toContain(a.home)

    await engine.run(b, deviceB)
    expect(b.read('.claude/settings.json')).toContain(`${b.home}/bin/status.sh`)
    expect(b.read('.claude/settings.json')).not.toContain(a.home)

    a.cleanup()
    b.cleanup()
    engine.cleanup()
  })
})

describe('upload rules over real surface declarations', () => {
  test('indirect rules rewrite env values before the scanner sees them', () => {
    const home = buildFakeHome({ entries: [] })
    const settings = surfaceById(claudeSurfaces(home.ctx), 'claude.settings')
    const raw = 'sk-ant-api03-5Kd9QpZx7Lm2Nr8TvB4Wc6Ye1Rf3Hg0J'
    const outcome = enforceUploadRules(
      settings,
      '$HOME/.claude/settings.json',
      JSON.stringify({ env: { ANTHROPIC_API_KEY: raw } }),
    )
    expect(outcome.blocked).toBeNull()
    const parsed = JSON.parse(outcome.content) as { env: Record<string, string> }
    const reference = envVarName('settings', 'ANTHROPIC_API_KEY')
    expect(parsed.env.ANTHROPIC_API_KEY).toBe(`\${${reference}}`)
    expect(outcome.content).not.toContain(raw)
    home.cleanup()
  })

  test('a deny rule blocks its pattern even on an otherwise enabled surface', () => {
    const home = buildFakeHome({ entries: [] })
    const settings = surfaceById(claudeSurfaces(home.ctx), 'claude.settings')
    const denied: Surface = {
      ...settings,
      secretRules: [...settings.secretRules, { kind: 'deny', patterns: ['**/settings.json'] }],
    }
    const outcome = enforceUploadRules(denied, '$HOME/.claude/settings.json', '{"model":"opus"}')
    expect(outcome.blocked).toContain('denied by secret rule')
    home.cleanup()
  })

  test('an unknown transform kind fails loudly instead of passing content through', () => {
    const home = buildFakeHome({ entries: [] })
    const settings = surfaceById(claudeSurfaces(home.ctx), 'claude.settings')
    const bogus: Surface = {
      ...settings,
      transforms: [{ kind: 'notARealTransform' as TransformKind }],
    }
    expect(() =>
      applyTransforms({
        surface: bogus,
        storePath: '$HOME/.claude/settings.json',
        direction: 'toStore',
        tokenEnv: { home: home.home, platform: 'darwin', env: {} },
        content: '{"model":"opus"}',
      }),
    ).toThrow(TransformError)
    home.cleanup()
  })
})
