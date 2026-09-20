import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import type { AtomicToolFilesystem, ToolManagerDependencies, ToolUnpacker } from '@laurencio/core'

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308])
const MAX_REDIRECTS = 5
const TOOL_RECEIPT = '.laurencio-tool.json'

export interface ToolProcessResult {
  status: number
  stdout: string
  stderr: string
}

export type ToolProcess = (program: string, args: readonly string[]) => Promise<ToolProcessResult>

export interface SystemToolOptions {
  fetch?: typeof fetch
  exec?: ToolProcess
}

export function toolArchitecture(value: string = process.arch): 'arm64' | 'x64' {
  if (value === 'arm64' || value === 'x64') return value
  throw new Error(`unsupported client architecture: ${value}`)
}

export function assertSafeArchiveEntries(entries: readonly string[]): void {
  for (const raw of entries) {
    const entry = raw.trim()
    if (entry === '') continue
    const normalized = entry.replaceAll('\\', '/')
    const parts = normalized.split('/')
    if (
      normalized.startsWith('/') ||
      normalized.includes(':') ||
      Array.from(normalized).some((character) => character.charCodeAt(0) < 32) ||
      parts.some((part) => part === '..')
    ) {
      throw new Error(`unsafe archive entry: ${raw}`)
    }
  }
}

export function assertSafeArchiveTypes(listing: string): void {
  for (const line of listing.split(/\r?\n/)) {
    if (line === '') continue
    // Both bsdtar (macOS/Windows) and GNU tar expose the entry type first.
    // Only ordinary files and directories are executable-tool payloads.
    if (!/^[-d][rwxStTs-]{9}\s/.test(line)) {
      throw new Error('tool archive contains a link or unsupported entry type')
    }
  }
}

function assertSafeExtractedTree(directory: string): void {
  const stat = fs.lstatSync(directory)
  if (stat.isSymbolicLink() || (!stat.isDirectory() && (!stat.isFile() || stat.nlink !== 1))) {
    throw new Error('tool archive contains a link or unsupported filesystem entry')
  }
  if (stat.isDirectory()) {
    for (const name of fs.readdirSync(directory)) {
      assertSafeExtractedTree(path.join(directory, name))
    }
  }
}

const defaultProcess: ToolProcess = (program, args) =>
  new Promise((resolve, reject) => {
    const child = spawn(program, [...args], { stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (chunk) => {
      stdout += String(chunk)
    })
    child.stderr.on('data', (chunk) => {
      stderr += String(chunk)
    })
    child.on('error', reject)
    child.on('close', (code) => resolve({ status: code ?? 1, stdout, stderr }))
  })

function systemFiles(): AtomicToolFilesystem {
  return {
    async stage(destination) {
      const parent = path.dirname(destination)
      fs.mkdirSync(parent, { recursive: true, mode: 0o700 })
      const staging = path.join(parent, `.${path.basename(destination)}.${randomUUID()}.partial`)
      fs.mkdirSync(staging, { mode: 0o700 })
      return staging
    },

    async commit(staging, destination) {
      const backup = `${destination}.backup-${randomUUID()}`
      const hadDestination = fs.existsSync(destination)
      if (hadDestination) fs.renameSync(destination, backup)
      try {
        fs.renameSync(staging, destination)
      } catch (error) {
        if (hadDestination && !fs.existsSync(destination)) fs.renameSync(backup, destination)
        throw error
      }
      if (hadDestination) fs.rmSync(backup, { recursive: true, force: true })
    },

    async discard(staging) {
      fs.rmSync(staging, { recursive: true, force: true })
    },

    async readReceipt(destination) {
      try {
        const parsed: unknown = JSON.parse(
          fs.readFileSync(path.join(destination, TOOL_RECEIPT), 'utf8'),
        )
        if (
          typeof parsed !== 'object' ||
          parsed === null ||
          typeof (parsed as Record<string, unknown>).sha256 !== 'string' ||
          typeof (parsed as Record<string, unknown>).sourceHost !== 'string'
        ) {
          return null
        }
        return {
          sha256: (parsed as { sha256: string }).sha256,
          sourceHost: (parsed as { sourceHost: string }).sourceHost,
        }
      } catch {
        return null
      }
    },

    async writeReceipt(staging, receipt) {
      fs.writeFileSync(path.join(staging, TOOL_RECEIPT), `${JSON.stringify(receipt)}\n`, {
        mode: 0o600,
      })
    },
  }
}

function systemUnpacker(exec: ToolProcess): ToolUnpacker {
  return {
    async unpack(input) {
      if (
        !fs.lstatSync(input.destination).isDirectory() ||
        fs.readdirSync(input.destination).length
      ) {
        throw new Error('tool extraction requires an empty staging directory')
      }
      const lower = input.sourceName.toLowerCase()
      const archive =
        lower.endsWith('.zip') ||
        lower.endsWith('.tar.gz') ||
        lower.endsWith('.tgz') ||
        lower.endsWith('.tar.xz') ||
        lower.endsWith('.tar.zst')
      if (!archive) {
        const executable = path.join(input.destination, path.basename(input.sourceName))
        fs.writeFileSync(executable, input.bytes, { mode: 0o755 })
        if (process.platform !== 'win32') fs.chmodSync(executable, 0o755)
        return
      }

      const artifact = path.join(input.destination, `.artifact-${randomUUID()}`)
      fs.writeFileSync(artifact, input.bytes, { mode: 0o600 })
      try {
        const listing = await exec('tar', ['-tf', artifact])
        if (listing.status !== 0) {
          throw new Error(`could not inspect tool archive: ${listing.stderr.trim()}`)
        }
        assertSafeArchiveEntries(listing.stdout.split(/\r?\n/))
        const types = await exec('tar', ['-tvf', artifact])
        if (types.status !== 0) throw new Error('could not inspect tool archive entry types')
        assertSafeArchiveTypes(types.stdout)
        const extracted = await exec('tar', ['-xf', artifact, '-C', input.destination])
        if (extracted.status !== 0) {
          throw new Error(`could not unpack tool archive: ${extracted.stderr.trim()}`)
        }
        assertSafeExtractedTree(input.destination)
        const artifactName = path.basename(artifact)
        const entries = fs.readdirSync(input.destination).filter((entry) => entry !== artifactName)
        if (entries.length === 1) {
          const only = path.join(input.destination, entries[0] ?? '')
          if (fs.statSync(only).isDirectory()) {
            for (const child of fs.readdirSync(only)) {
              fs.renameSync(path.join(only, child), path.join(input.destination, child))
            }
            fs.rmdirSync(only)
          }
        }
      } finally {
        fs.rmSync(artifact, { force: true })
      }
    },
  }
}

export function createSystemToolDependencies(
  options: SystemToolOptions = {},
): ToolManagerDependencies {
  const fetchImpl = options.fetch ?? globalThis.fetch
  const exec = options.exec ?? defaultProcess
  return {
    artifacts: {
      async download(source) {
        let current = new URL(source)
        const redirects: string[] = []
        for (let count = 0; count <= MAX_REDIRECTS; count += 1) {
          if (current.protocol !== 'https:' || current.username !== '' || current.password !== '') {
            throw new Error('tool downloads require HTTPS URLs without embedded credentials')
          }
          const response = await fetchImpl(current, { redirect: 'manual' })
          if (REDIRECT_STATUSES.has(response.status)) {
            const location = response.headers.get('location')
            if (location === null) throw new Error('tool download redirect has no location')
            if (count === MAX_REDIRECTS) throw new Error('tool download exceeded redirect limit')
            current = new URL(location, current)
            redirects.push(current.toString())
            continue
          }
          if (!response.ok) {
            throw new Error(`tool download failed with HTTP ${response.status}`)
          }
          return {
            bytes: new Uint8Array(await response.arrayBuffer()),
            finalUrl: current.toString(),
            redirects,
          }
        }
        throw new Error('tool download exceeded redirect limit')
      },
    },
    files: systemFiles(),
    unpacker: systemUnpacker(exec),
  }
}
