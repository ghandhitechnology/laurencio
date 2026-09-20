/** Immutable local preimages. A mutation fails if its recoverable copy cannot be saved. */
import { createHash, randomUUID } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

function digest(value: string | Uint8Array): string {
  return createHash('sha256').update(value).digest('hex')
}

function durableCreate(filePath: string, content: string | Uint8Array): void {
  if (fs.existsSync(filePath)) {
    if (!fs.readFileSync(filePath).equals(Buffer.from(content))) {
      throw new Error(`backup integrity check failed: ${filePath}`)
    }
    return
  }
  const temporary = `${filePath}.${randomUUID()}.tmp`
  try {
    const fd = fs.openSync(temporary, 'wx', 0o600)
    try {
      fs.writeFileSync(fd, content)
      fs.fsyncSync(fd)
    } finally {
      fs.closeSync(fd)
    }
    fs.renameSync(temporary, filePath)
  } finally {
    fs.rmSync(temporary, { force: true })
  }
}

/** Keeps every distinct version, including the first. Paths and bytes stay local. */
export function backupFile(
  backupRoot: string,
  targetPath: string,
  declaredPath: string = targetPath,
): void {
  let stat: fs.Stats
  try {
    stat = fs.lstatSync(targetPath)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
    throw error
  }
  if (!stat.isFile()) throw new Error(`refusing to replace a non-file: ${targetPath}`)
  const content = fs.readFileSync(targetPath)
  const hash = digest(content)
  const dir = path.join(backupRoot, digest(targetPath))
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
  durableCreate(path.join(dir, `${hash}.content`), content)
  const metadata = JSON.stringify(
    {
      targetPath,
      declaredPath,
      hash,
      mode: stat.mode & 0o777,
      size: content.byteLength,
    },
    null,
    2,
  )
  durableCreate(path.join(dir, `${hash}-${digest(metadata).slice(0, 16)}.json`), `${metadata}\n`)
  // Persist the new directory entries before the caller changes the source.
  if (process.platform !== 'win32') {
    for (const directory of [dir, backupRoot, path.dirname(backupRoot)]) {
      const fd = fs.openSync(directory, 'r')
      try {
        fs.fsyncSync(fd)
      } finally {
        fs.closeSync(fd)
      }
    }
  }
}
