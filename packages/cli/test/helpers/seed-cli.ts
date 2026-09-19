/**
 * Seeds a scratch HOME and a FileRemote store for `scripts/cli-tests.sh`.
 * Everything lands in files (no OS keychain), so the CLI subprocess finds it
 * with LAURENCIO_KEYCHAIN=file.
 *
 * Usage:
 *   bun packages/cli/test/helpers/seed-cli.ts --home <dir> --remote <dir> \
 *     [--file '<home-relative>=<content>'] [--conflict '<home-relative>']
 */

import fs from 'node:fs'
import path from 'node:path'
import { parseArgs } from 'node:util'
import {
  CONFLICT_LEDGER_META_KEY,
  ConflictLedger,
  conflictCopyPath,
  SyncState,
} from '@laurencio/core'
import { NOW, seedStore, writeHomeFile } from '../helpers'

const { values } = parseArgs({
  options: {
    home: { type: 'string' },
    remote: { type: 'string' },
    file: { type: 'string', multiple: true },
    conflict: { type: 'string', multiple: true },
  },
  strict: true,
  allowPositionals: false,
})

const home = values.home
const remote = values.remote
if (home === undefined || remote === undefined) {
  console.error('usage: seed-cli.ts --home <dir> --remote <dir>')
  process.exit(1)
}
fs.mkdirSync(home, { recursive: true })
await seedStore({ home, remoteDir: remote })

for (const spec of values.file ?? []) {
  const index = spec.indexOf('=')
  if (index === -1) throw new Error(`--file needs '<path>=<content>': ${spec}`)
  writeHomeFile(home, spec.slice(0, index), `${spec.slice(index + 1)}\n`)
}

const conflicts = values.conflict ?? []
if (conflicts.length > 0) {
  const state = SyncState.open({ home })
  try {
    const ledger = new ConflictLedger()
    for (const relative of conflicts) {
      const source = path.join(home, relative)
      const copy = conflictCopyPath(source, 'other-device', NOW)
      fs.writeFileSync(copy, 'remote content\n')
      ledger.add({ path: copy, sourcePath: source, device: 'other-device', createdAt: NOW })
    }
    state.setMeta(CONFLICT_LEDGER_META_KEY, ledger.toJSON())
  } finally {
    state.close()
  }
}

console.log(home)
