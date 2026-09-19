import fs from 'node:fs'
import path from 'node:path'
import { crypto } from '@laurencio/core'
import { PROTOCOL_VERSION } from '@laurencio/protocol'
import { cliError } from '../errors'
import { fetchManifestAt } from '../history'
import { askYesNo } from '../prompt'
import { ok } from '../result'
import { openSession } from '../session'
import { displayPath, plural } from '../ui'
import type { CommandSpec } from './command'

export interface ExportFile {
  path: string
  hash: string
  size: number
  mode: number
  blob?: string
  content?: string
}

export interface ExportData {
  out: string
  mode: 'encrypted' | 'plaintext'
  revision: string
  files: number
  bytes: number
}

export const exportCommand: CommandSpec = {
  name: 'export',
  summary: 'Write an encrypted bundle of the current revision',
  usage: 'laurencio export --out <file> [--plaintext] [--json]',
  async run(ctx) {
    const out = ctx.flags.out
    if (out === undefined || out === '') {
      throw cliError('missing-argument', 'export needs --out <file>', {
        hint: 'Usage: laurencio export --out <file>',
      })
    }
    const target = path.resolve(out)
    if (fs.existsSync(target) && !ctx.flags.yes) {
      if (ctx.flags.json) {
        throw cliError('file-exists', `${target} already exists; pass --yes to overwrite`)
      }
      const confirmed = await askYesNo(ctx, `${target} exists. Overwrite it?`, false)
      if (!confirmed) {
        throw cliError('file-exists', 'export cancelled')
      }
    }

    const session = await openSession(ctx)
    const page = await session.remote.listRevisions()
    if (page.head === null) {
      throw cliError('nothing-to-export', 'the store has no revisions yet', {
        hint: 'Run `laurencio sync` first.',
      })
    }
    const manifest = await fetchManifestAt(session, page.head)
    const published = await session.remote.getKdfParams()
    const plaintext = ctx.flags.plaintext
    const files: ExportFile[] = []
    for (const entry of manifest.entries) {
      if (entry.kind !== 'file' || entry.blob === undefined) continue
      const bytes = await session.remote.getBlob(entry.blob.id)
      if (plaintext) {
        files.push({
          path: entry.path,
          hash: entry.hash,
          size: entry.size,
          mode: entry.mode,
          content: crypto.openText(session.credentials.key, 'content', bytes, {
            storeId: session.credentials.storeId,
            blobType: 'file',
            protocolVersion: PROTOCOL_VERSION,
          }),
        })
      } else {
        files.push({
          path: entry.path,
          hash: entry.hash,
          size: entry.size,
          mode: entry.mode,
          blob: Buffer.from(bytes).toString('base64'),
        })
      }
    }

    const bundle = {
      version: 1,
      kind: 'laurencio-bundle',
      createdAt: ctx.now().toISOString(),
      storeId: session.credentials.storeId,
      deviceId: session.identity.deviceId,
      protocolVersion: PROTOCOL_VERSION,
      mode: plaintext ? 'plaintext' : 'encrypted',
      kdf:
        published === null ? null : crypto.kdfParamsToWire(published.kdf, ctx.now().toISOString()),
      revision: { id: manifest.revisionId, createdAt: manifest.createdAt },
      files,
    }
    fs.mkdirSync(path.dirname(target), { recursive: true })
    fs.writeFileSync(target, `${JSON.stringify(bundle, null, 2)}\n`, { mode: 0o600 })
    const stat = fs.statSync(target)

    const data: ExportData = {
      out: target,
      mode: plaintext ? 'plaintext' : 'encrypted',
      revision: manifest.revisionId,
      files: files.length,
      bytes: stat.size,
    }
    const human = (): string => {
      const lines = [
        `Exported ${plural(files.length, 'file')} from revision ${manifest.revisionId.slice(0, 10)} to ${displayPath(ctx.home, target)}`,
        `Bundle: ${stat.size} bytes, ${plaintext ? 'plaintext' : 'encrypted'}`,
      ]
      if (plaintext) {
        lines.push('Plaintext bundle: config contents are readable in this file. Keep it private.')
      } else {
        lines.push('The bundle opens with the store passphrase.')
      }
      return lines.join('\n')
    }
    return ok(data, human)
  },
}
