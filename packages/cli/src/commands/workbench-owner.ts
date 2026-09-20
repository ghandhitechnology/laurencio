import fs from 'node:fs'
import path from 'node:path'
import { WorkbenchSessionId } from '@laurencio/protocol'
import { requirePositional } from '../args'
import { ok } from '../result'
import { controllerFor } from '../workbench/context'
import { workbenchOwnerPath, workbenchRegistryDirectory } from '../workbench/registry'
import type { CommandSpec } from './command'

export const workbenchOwnerCommand: CommandSpec = {
  name: 'workbench-owner',
  summary: 'Own cleanup for a detached temporary workbench',
  usage: 'laurencio workbench-owner <session-id>',
  async run(ctx) {
    const id = WorkbenchSessionId.parse(
      requirePositional(ctx.positionals, 0, 'session id', 'laurencio workbench-owner <session-id>'),
    )
    const controller = controllerFor(ctx)
    const marker = workbenchOwnerPath(ctx.home, id)
    fs.mkdirSync(workbenchRegistryDirectory(ctx.home), { recursive: true, mode: 0o700 })
    let owned = false
    try {
      try {
        const descriptor = fs.openSync(marker, 'wx', 0o600)
        try {
          fs.writeFileSync(descriptor, `${process.pid}\n`)
        } finally {
          fs.closeSync(descriptor)
        }
        owned = true
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
          return ok({ id, cleaned: false }, () => '')
        }
        throw error
      }

      while (true) {
        try {
          const status = await controller.status(id)
          if (status === null) return ok({ id, cleaned: true }, () => '')
          if (status.state === 'stopped') {
            await controller.close(id)
            return ok({ id, cleaned: true }, () => '')
          }
        } catch {
          // Filesystem and process inspection can fail transiently. Ownership
          // stays with this process until the target is confirmed gone.
        }
        await (ctx.deps.sleep ?? Bun.sleep)(500)
      }
    } finally {
      if (owned) {
        try {
          if (fs.readFileSync(marker, 'utf8').trim() === String(process.pid)) {
            fs.rmSync(marker, { force: true })
          }
        } catch {
          // Cleanup ownership was already released by process exit.
        }
        try {
          fs.rmdirSync(path.dirname(marker))
        } catch {
          // Registry files normally keep the directory present.
        }
      }
    }
  },
}
