import { clearCredentials, crypto, writeDeviceIdentity } from '@laurencio/core'
import type { DeviceRecord } from '@laurencio/protocol'
import type { CommandContext } from '../context'
import { cliError } from '../errors'
import { askYesNo } from '../prompt'
import { ok } from '../result'
import { deviceAdmin, identityFor, keychainOptions, openSession } from '../session'
import { shortId, table } from '../ui'
import type { CommandSpec } from './command'

export interface DeviceRow {
  id: string
  name: string
  platform: string
  createdAt: string
  lastSeenAt: string | null
  revokedAt: string | null
  current: boolean
}

export interface DevicesData {
  currentDeviceId: string
  devices: DeviceRow[]
}

function toRow(record: DeviceRecord, currentId: string): DeviceRow {
  return {
    id: record.id,
    name: record.name,
    platform: record.platform,
    createdAt: record.createdAt,
    lastSeenAt: record.lastSeenAt ?? null,
    revokedAt: record.revokedAt ?? null,
    current: record.id === currentId,
  }
}

function humanDevices(data: DevicesData): string {
  const rows = data.devices.map((device) => [
    device.id === data.currentDeviceId ? `${shortId(device.id)}*` : shortId(device.id),
    device.name,
    device.platform,
    device.revokedAt === null ? (device.lastSeenAt ?? 'never seen') : `revoked ${device.revokedAt}`,
  ])
  return table(rows, { header: ['DEVICE', 'NAME', 'PLATFORM', 'LAST SEEN'] })
}

function resolveTarget(
  target: string | undefined,
  currentId: string,
  devices: readonly DeviceRow[],
): string {
  if (target === undefined || target === '' || target === 'self') return currentId
  const byName = devices.filter((device) => device.name === target)
  if (byName.length === 1) {
    const match = byName[0]
    if (match !== undefined) return match.id
  }
  const byPrefix = devices.filter((device) => device.id.startsWith(target))
  if (byPrefix.length === 1) {
    const match = byPrefix[0]
    if (match !== undefined) return match.id
  }
  if (byPrefix.length > 1 || byName.length > 1) {
    throw cliError('ambiguous-device', `${target} matches more than one device`)
  }
  throw cliError('unknown-device', `no device matches ${target}`)
}

async function listDevices(ctx: CommandContext): Promise<DevicesData> {
  const identity = identityFor(ctx)
  if (identity === null) {
    throw cliError('not-enrolled', 'this device is not enrolled', {
      hint: 'Run `laurencio enroll` to sign in.',
    })
  }
  const session = await openSession(ctx)
  const devices = (await session.remote.listDevices()).map((record) =>
    toRow(record, identity.deviceId),
  )
  devices.sort((a, b) => Number(b.current) - Number(a.current) || a.id.localeCompare(b.id))
  return { currentDeviceId: identity.deviceId, devices }
}

async function renameDevice(ctx: CommandContext) {
  const name = ctx.flags.name
  if (name === undefined || name.trim() === '') {
    throw cliError('missing-argument', 'rename needs --name <name>', {
      hint: 'Usage: laurencio devices rename <id|self> --name <name>',
    })
  }
  const identity = identityFor(ctx)
  if (identity === null) {
    throw cliError('not-enrolled', 'this device is not enrolled')
  }
  const session = await openSession(ctx)
  const devices = (await session.remote.listDevices()).map((record) =>
    toRow(record, identity.deviceId),
  )
  const deviceId = resolveTarget(ctx.positionals[1], identity.deviceId, devices)
  const updated = await deviceAdmin(ctx, session).rename(deviceId, name.trim())
  let localRenamed = false
  if (deviceId === identity.deviceId) {
    writeDeviceIdentity(ctx.home, { ...identity, name: updated.name })
    localRenamed = true
  }
  const data = {
    device: toRow(updated, identity.deviceId),
    localRenamed,
  }
  return ok(
    data,
    () =>
      `Renamed ${shortId(deviceId)} to ${updated.name}.${localRenamed ? ' Local device name updated.' : ''}`,
  )
}

async function revokeDevice(ctx: CommandContext) {
  const identity = identityFor(ctx)
  if (identity === null) {
    throw cliError('not-enrolled', 'this device is not enrolled')
  }
  const session = await openSession(ctx)
  const devices = (await session.remote.listDevices()).map((record) =>
    toRow(record, identity.deviceId),
  )
  const deviceId = resolveTarget(ctx.positionals[1], identity.deviceId, devices)
  const target = devices.find((device) => device.id === deviceId)
  if (target?.revokedAt != null) {
    const data = { device: target, localSignOut: false }
    return ok(data, () => `${target.name} is already revoked.`)
  }
  const self = deviceId === identity.deviceId
  if (!ctx.flags.yes) {
    if (ctx.flags.json) {
      throw cliError('confirmation-required', 'revoke needs --yes in JSON mode')
    }
    const question = self
      ? `Revoke this device (${identity.name})? This machine must sign in again.`
      : `Revoke ${target?.name ?? shortId(deviceId)}?`
    const confirmed = await askYesNo(ctx, question, false)
    if (!confirmed) {
      const data = { device: target ?? null, localSignOut: false, cancelled: true }
      return ok(data, () => 'Revoke cancelled.')
    }
  }
  const updated = await deviceAdmin(ctx, session).revoke(deviceId)
  let localSignOut = false
  if (self) {
    const cache = await crypto.openKeyCache(keychainOptions(ctx))
    await cache.forget(identity.storeId)
    await clearCredentials({ ...keychainOptions(ctx), deviceId: identity.deviceId })
    localSignOut = true
  }
  const data = { device: toRow(updated, identity.deviceId), localSignOut }
  return ok(
    data,
    () =>
      `Revoked ${updated.name} (${shortId(updated.id)}).${localSignOut ? ' This device signed out.' : ''}`,
  )
}

export const devicesCommand: CommandSpec = {
  name: 'devices',
  summary: 'List, rename, or revoke devices',
  usage: 'laurencio devices [list|rename <id> --name <name>|revoke <id>] [--json]',
  async run(ctx) {
    switch (ctx.subcommand) {
      case null:
      case 'list': {
        const data = await listDevices(ctx)
        return ok(data, () => humanDevices(data))
      }
      case 'rename':
        return await renameDevice(ctx)
      case 'revoke':
        return await revokeDevice(ctx)
      default:
        throw cliError('unknown-subcommand', `unknown devices subcommand: ${ctx.subcommand}`, {
          hint: 'Known: list, rename, revoke',
        })
    }
  },
}
