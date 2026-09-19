/**
 * Snapshot tests for human and JSON output of every command. Volatile values
 * (paths, timestamps, ids, hashes) are normalized before the snapshot so the
 * files stay stable across machines and runs.
 */

import { describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import path from 'node:path'
import {
  CONFLICT_LEDGER_META_KEY,
  ConflictLedger,
  conflictCopyPath,
  createFileRemote,
  SyncState,
} from '@laurencio/core'
import { DeviceId } from '@laurencio/protocol'
import {
  makeScratch,
  memoryKeychain,
  NOW,
  PASSPHRASE,
  type RunOutcome,
  runForTest,
  type Scratch,
  seedStore,
  writeHomeFile,
} from './helpers'

const QUICK = { quiescence: { windowMs: 0 } }

function snapshotText(out: RunOutcome, scratch: Scratch): string {
  const body = [
    `exit: ${out.exitCode}`,
    '--- stdout',
    out.output.trimEnd(),
    '--- stderr',
    out.errorOutput.trimEnd(),
  ].join('\n')
  return normalize(body, scratch)
}

function normalize(text: string, scratch: Scratch): string {
  return text
    .split(scratch.home)
    .join('<HOME>')
    .split(scratch.remoteDir)
    .join('<REMOTE>')
    .replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z/g, '<TIME>')
    .replace(/\b[0-9a-f]{32,64}\b/g, '<HASH>')
    .replace(/\b[0-9A-HJKMNP-TV-Z]{26}\b/g, '<ID>')
}

async function seedAndPush(scratch: Scratch): Promise<void> {
  await seedStore({ home: scratch.home, remoteDir: scratch.remoteDir })
  writeHomeFile(scratch.home, '.claude/CLAUDE.md', '# Instructions\n')
  writeHomeFile(scratch.home, '.codex/AGENTS.md', '# Codex rules\n')
  const init = await runForTest(['init', '--yes'], {
    home: scratch.home,
    remoteDir: scratch.remoteDir,
    deps: QUICK,
  })
  if (init.exitCode !== 0) throw new Error(`seed init failed: ${init.errorOutput}`)
}

describe('snapshots: help and version', () => {
  test('global help human', async () => {
    const scratch = makeScratch()
    try {
      const out = await runForTest(['--help'], { home: scratch.home })
      expect(snapshotText(out, scratch)).toMatchSnapshot()
    } finally {
      scratch.cleanup()
    }
  })

  test('command help human', async () => {
    const scratch = makeScratch()
    try {
      const out = await runForTest(['restore', '--help'], { home: scratch.home })
      expect(snapshotText(out, scratch)).toMatchSnapshot()
    } finally {
      scratch.cleanup()
    }
  })

  test('version human', async () => {
    const scratch = makeScratch()
    try {
      const out = await runForTest(['--version'], { home: scratch.home })
      expect(snapshotText(out, scratch)).toMatchSnapshot()
    } finally {
      scratch.cleanup()
    }
  })
})

describe('snapshots: init', () => {
  test('init offline human', async () => {
    const scratch = makeScratch()
    try {
      const out = await runForTest(
        ['init', '--server', 'http://127.0.0.1:1', '--yes', '--harness', 'codex'],
        { home: scratch.home },
      )
      expect(snapshotText(out, scratch)).toMatchSnapshot()
    } finally {
      scratch.cleanup()
    }
  })

  test('init offline json', async () => {
    const scratch = makeScratch()
    try {
      const out = await runForTest(
        ['init', '--server', 'http://127.0.0.1:1', '--yes', '--json', '--harness', 'codex'],
        { home: scratch.home },
      )
      expect(snapshotText(out, scratch)).toMatchSnapshot()
    } finally {
      scratch.cleanup()
    }
  })

  test('init seeded human', async () => {
    const scratch = makeScratch()
    try {
      await seedStore({ home: scratch.home, remoteDir: scratch.remoteDir })
      writeHomeFile(scratch.home, '.codex/AGENTS.md', '# Codex rules\n')
      const out = await runForTest(['init', '--yes', '--harness', 'codex'], {
        home: scratch.home,
        remoteDir: scratch.remoteDir,
        deps: QUICK,
      })
      expect(snapshotText(out, scratch)).toMatchSnapshot()
    } finally {
      scratch.cleanup()
    }
  })

  test('init seeded json', async () => {
    const scratch = makeScratch()
    try {
      await seedStore({ home: scratch.home, remoteDir: scratch.remoteDir })
      writeHomeFile(scratch.home, '.codex/AGENTS.md', '# Codex rules\n')
      const out = await runForTest(['init', '--yes', '--json', '--harness', 'codex'], {
        home: scratch.home,
        remoteDir: scratch.remoteDir,
        deps: QUICK,
      })
      expect(snapshotText(out, scratch)).toMatchSnapshot()
    } finally {
      scratch.cleanup()
    }
  })
})

describe('snapshots: status and sync', () => {
  test('status clean human', async () => {
    const scratch = makeScratch()
    try {
      await seedAndPush(scratch)
      const out = await runForTest(['status'], {
        home: scratch.home,
        remoteDir: scratch.remoteDir,
        deps: QUICK,
      })
      expect(snapshotText(out, scratch)).toMatchSnapshot()
    } finally {
      scratch.cleanup()
    }
  })

  test('status with drift and a conflict json', async () => {
    const scratch = makeScratch()
    try {
      await seedAndPush(scratch)
      writeHomeFile(scratch.home, '.claude/CLAUDE.md', '# Edited\n')
      const source = path.join(scratch.home, '.claude/CLAUDE.md')
      const copy = conflictCopyPath(source, 'other-device', NOW)
      fs.writeFileSync(copy, 'remote\n')
      const state = SyncState.open({ home: scratch.home })
      state.setMeta(
        CONFLICT_LEDGER_META_KEY,
        new ConflictLedger([
          { path: copy, sourcePath: source, device: 'other-device', createdAt: NOW },
        ]).toJSON(),
      )
      state.close()
      const out = await runForTest(['status', '--json'], {
        home: scratch.home,
        remoteDir: scratch.remoteDir,
        deps: QUICK,
      })
      expect(snapshotText(out, scratch)).toMatchSnapshot()
    } finally {
      scratch.cleanup()
    }
  })

  test('sync dry run human', async () => {
    const scratch = makeScratch()
    try {
      await seedAndPush(scratch)
      writeHomeFile(scratch.home, '.claude/CLAUDE.md', '# Instructions\n\nMore.\n')
      const out = await runForTest(['sync', '--dry-run'], {
        home: scratch.home,
        remoteDir: scratch.remoteDir,
        deps: QUICK,
      })
      expect(snapshotText(out, scratch)).toMatchSnapshot()
    } finally {
      scratch.cleanup()
    }
  })

  test('sync dry run json', async () => {
    const scratch = makeScratch()
    try {
      await seedAndPush(scratch)
      writeHomeFile(scratch.home, '.claude/CLAUDE.md', '# Instructions\n\nMore.\n')
      const out = await runForTest(['sync', '--dry-run', '--json'], {
        home: scratch.home,
        remoteDir: scratch.remoteDir,
        deps: QUICK,
      })
      expect(snapshotText(out, scratch)).toMatchSnapshot()
    } finally {
      scratch.cleanup()
    }
  })

  test('sync human', async () => {
    const scratch = makeScratch()
    try {
      await seedAndPush(scratch)
      writeHomeFile(scratch.home, '.codex/AGENTS.md', '# Codex rules\n\nExtra.\n')
      const out = await runForTest(['sync'], {
        home: scratch.home,
        remoteDir: scratch.remoteDir,
        deps: QUICK,
      })
      expect(snapshotText(out, scratch)).toMatchSnapshot()
    } finally {
      scratch.cleanup()
    }
  })

  test('sync json', async () => {
    const scratch = makeScratch()
    try {
      await seedAndPush(scratch)
      writeHomeFile(scratch.home, '.codex/AGENTS.md', '# Codex rules\n\nExtra.\n')
      const out = await runForTest(['sync', '--json'], {
        home: scratch.home,
        remoteDir: scratch.remoteDir,
        deps: QUICK,
      })
      expect(snapshotText(out, scratch)).toMatchSnapshot()
    } finally {
      scratch.cleanup()
    }
  })

  test('pause and resume human', async () => {
    const scratch = makeScratch()
    try {
      const pause = await runForTest(['pause'], { home: scratch.home })
      const resume = await runForTest(['resume'], { home: scratch.home })
      expect(snapshotText(pause, scratch)).toMatchSnapshot()
      expect(snapshotText(resume, scratch)).toMatchSnapshot()
    } finally {
      scratch.cleanup()
    }
  })

  test('pause and resume json', async () => {
    const scratch = makeScratch()
    try {
      const pause = await runForTest(['pause', '--json'], { home: scratch.home })
      const resume = await runForTest(['resume', '--json'], { home: scratch.home })
      expect(snapshotText(pause, scratch)).toMatchSnapshot()
      expect(snapshotText(resume, scratch)).toMatchSnapshot()
    } finally {
      scratch.cleanup()
    }
  })
})

describe('snapshots: diff, log, restore', () => {
  test('diff human', async () => {
    const scratch = makeScratch()
    try {
      await seedAndPush(scratch)
      writeHomeFile(scratch.home, '.claude/CLAUDE.md', '# Instructions\n\nChanged.\n')
      const out = await runForTest(['diff', 'claude.instructions'], {
        home: scratch.home,
        remoteDir: scratch.remoteDir,
        deps: QUICK,
      })
      expect(snapshotText(out, scratch)).toMatchSnapshot()
    } finally {
      scratch.cleanup()
    }
  })

  test('diff json', async () => {
    const scratch = makeScratch()
    try {
      await seedAndPush(scratch)
      writeHomeFile(scratch.home, '.claude/CLAUDE.md', '# Instructions\n\nChanged.\n')
      const out = await runForTest(['diff', '--json'], {
        home: scratch.home,
        remoteDir: scratch.remoteDir,
        deps: QUICK,
      })
      expect(snapshotText(out, scratch)).toMatchSnapshot()
    } finally {
      scratch.cleanup()
    }
  })

  test('log human and json', async () => {
    const scratch = makeScratch()
    try {
      await seedAndPush(scratch)
      writeHomeFile(scratch.home, '.claude/CLAUDE.md', '# Instructions\n\nSecond.\n')
      await runForTest(['sync'], {
        home: scratch.home,
        remoteDir: scratch.remoteDir,
        deps: QUICK,
      })
      const human = await runForTest(['log'], {
        home: scratch.home,
        remoteDir: scratch.remoteDir,
        deps: QUICK,
      })
      const json = await runForTest(['log', '--json'], {
        home: scratch.home,
        remoteDir: scratch.remoteDir,
        deps: QUICK,
      })
      expect(snapshotText(human, scratch)).toMatchSnapshot()
      expect(snapshotText(json, scratch)).toMatchSnapshot()
    } finally {
      scratch.cleanup()
    }
  })

  test('restore human and json', async () => {
    const scratch = makeScratch()
    try {
      await seedAndPush(scratch)
      writeHomeFile(scratch.home, '.claude/CLAUDE.md', '# Instructions\n\nSecond.\n')
      await runForTest(['sync'], {
        home: scratch.home,
        remoteDir: scratch.remoteDir,
        deps: QUICK,
      })
      const log = await runForTest(['log', '--json'], {
        home: scratch.home,
        remoteDir: scratch.remoteDir,
        deps: QUICK,
      })
      const first = (JSON.parse(log.output) as { revisions: { id: string }[] }).revisions[0]
      if (first === undefined) throw new Error('no first revision')
      const human = await runForTest(['restore', first.id, 'claude.instructions', '--yes'], {
        home: scratch.home,
        remoteDir: scratch.remoteDir,
        deps: QUICK,
      })
      const json = await runForTest(
        ['restore', first.id, 'claude.instructions', '--yes', '--json'],
        { home: scratch.home, remoteDir: scratch.remoteDir, deps: QUICK },
      )
      expect(snapshotText(human, scratch)).toMatchSnapshot()
      expect(snapshotText(json, scratch)).toMatchSnapshot()
    } finally {
      scratch.cleanup()
    }
  })
})

describe('snapshots: devices, resolve, export, doctor, surfaces, unlock', () => {
  test('devices human and json', async () => {
    const scratch = makeScratch()
    try {
      await seedStore({ home: scratch.home, remoteDir: scratch.remoteDir })
      const remote = createFileRemote({ dir: scratch.remoteDir })
      remote.upsertDevice({
        id: DeviceId.parse('00000000000000000000000003'),
        name: 'old-laptop',
        platform: 'darwin',
        createdAt: NOW,
      })
      const human = await runForTest(['devices'], {
        home: scratch.home,
        remoteDir: scratch.remoteDir,
      })
      const json = await runForTest(['devices', '--json'], {
        home: scratch.home,
        remoteDir: scratch.remoteDir,
      })
      const rename = await runForTest(['devices', 'rename', 'old-laptop', '--name', 'mac-mini'], {
        home: scratch.home,
        remoteDir: scratch.remoteDir,
      })
      const revoke = await runForTest(['devices', 'revoke', 'mac-mini', '--yes'], {
        home: scratch.home,
        remoteDir: scratch.remoteDir,
      })
      expect(snapshotText(human, scratch)).toMatchSnapshot()
      expect(snapshotText(json, scratch)).toMatchSnapshot()
      expect(snapshotText(rename, scratch)).toMatchSnapshot()
      expect(snapshotText(revoke, scratch)).toMatchSnapshot()
    } finally {
      scratch.cleanup()
    }
  })

  test('resolve human and json', async () => {
    const scratch = makeScratch()
    try {
      await seedStore({ home: scratch.home, remoteDir: scratch.remoteDir })
      writeHomeFile(scratch.home, '.claude/CLAUDE.md', 'local\n')
      const source = path.join(scratch.home, '.claude/CLAUDE.md')
      const plant = (): void => {
        const copy = conflictCopyPath(source, 'other-device', NOW)
        fs.writeFileSync(copy, 'remote\n')
        const state = SyncState.open({ home: scratch.home })
        state.setMeta(
          CONFLICT_LEDGER_META_KEY,
          new ConflictLedger([
            { path: copy, sourcePath: source, device: 'other-device', createdAt: NOW },
          ]).toJSON(),
        )
        state.close()
      }
      plant()
      const human = await runForTest(['resolve', '--keep-remote'], {
        home: scratch.home,
        remoteDir: scratch.remoteDir,
      })
      plant()
      const json = await runForTest(['resolve', '--keep-local', '--json'], {
        home: scratch.home,
        remoteDir: scratch.remoteDir,
      })
      expect(snapshotText(human, scratch)).toMatchSnapshot()
      expect(snapshotText(json, scratch)).toMatchSnapshot()
    } finally {
      scratch.cleanup()
    }
  })

  test('export human and json', async () => {
    const scratch = makeScratch()
    try {
      await seedAndPush(scratch)
      const out = path.join(scratch.home, 'bundle.json')
      const human = await runForTest(['export', '--out', out], {
        home: scratch.home,
        remoteDir: scratch.remoteDir,
        deps: QUICK,
      })
      const json = await runForTest(['export', '--out', out, '--yes', '--json'], {
        home: scratch.home,
        remoteDir: scratch.remoteDir,
        deps: QUICK,
      })
      expect(snapshotText(human, scratch)).toMatchSnapshot()
      expect(snapshotText(json, scratch)).toMatchSnapshot()
    } finally {
      scratch.cleanup()
    }
  })

  test('doctor human and json', async () => {
    const scratch = makeScratch()
    try {
      await seedStore({ home: scratch.home, remoteDir: scratch.remoteDir })
      writeHomeFile(scratch.home, '.claude/CLAUDE.md', 'clean\n')
      const human = await runForTest(['doctor', '--harness', 'codex'], {
        home: scratch.home,
        remoteDir: scratch.remoteDir,
      })
      const json = await runForTest(['doctor', '--json', '--harness', 'codex'], {
        home: scratch.home,
        remoteDir: scratch.remoteDir,
      })
      expect(snapshotText(human, scratch)).toMatchSnapshot()
      expect(snapshotText(json, scratch)).toMatchSnapshot()
    } finally {
      scratch.cleanup()
    }
  })

  test('surfaces human and json', async () => {
    const scratch = makeScratch()
    try {
      const human = await runForTest(['surfaces', '--harness', 'codex'], { home: scratch.home })
      const json = await runForTest(['surfaces', '--json', '--harness', 'codex'], {
        home: scratch.home,
      })
      expect(snapshotText(human, scratch)).toMatchSnapshot()
      expect(snapshotText(json, scratch)).toMatchSnapshot()
    } finally {
      scratch.cleanup()
    }
  })

  test('unlock human and json', async () => {
    const scratch = makeScratch()
    try {
      const keychain = memoryKeychain()
      await seedStore({ home: scratch.home, remoteDir: scratch.remoteDir, keychain })
      const passFile = path.join(scratch.home, 'pass.txt')
      fs.writeFileSync(passFile, `${PASSPHRASE}\n`)
      const human = await runForTest(['unlock', '--passphrase-file', passFile], {
        home: scratch.home,
        remoteDir: scratch.remoteDir,
        keychain,
      })
      const json = await runForTest(['unlock', '--passphrase-file', passFile, '--json'], {
        home: scratch.home,
        remoteDir: scratch.remoteDir,
        keychain,
      })
      expect(snapshotText(human, scratch)).toMatchSnapshot()
      expect(snapshotText(json, scratch)).toMatchSnapshot()
    } finally {
      scratch.cleanup()
    }
  })

  test('login offline human', async () => {
    const scratch = makeScratch()
    try {
      const out = await runForTest(['login', '--server', 'http://127.0.0.1:1'], {
        home: scratch.home,
      })
      expect(snapshotText(out, scratch)).toMatchSnapshot()
    } finally {
      scratch.cleanup()
    }
  })

  test('unknown command human and json', async () => {
    const scratch = makeScratch()
    try {
      const human = await runForTest(['frobnicate'], { home: scratch.home })
      const json = await runForTest(['frobnicate', '--json'], { home: scratch.home })
      expect(snapshotText(human, scratch)).toMatchSnapshot()
      expect(snapshotText(json, scratch)).toMatchSnapshot()
    } finally {
      scratch.cleanup()
    }
  })
})
