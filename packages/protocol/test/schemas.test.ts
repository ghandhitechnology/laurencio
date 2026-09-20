import { describe, expect, test } from 'bun:test'
import {
  BlobId,
  CommitRequest,
  checkProtocolVersion,
  DeviceId,
  ErrorResponse,
  KdfParams,
  newId,
  PROFILE_VERSION_HEADER,
  ProfileHeadResponse,
  ProfileHeadWriteRequest,
  ProfileVersionWriteRequest,
  RevisionId,
  SurfaceId,
  VaultHeadResponse,
  VaultHeadWriteRequest,
  WorkbenchSession,
  WorkbenchSessionCreateRequest,
  WorkbenchSessionId,
} from '../src/index'

const storeId = newId()
const deviceId = newId()
const blob = 'a'.repeat(64)

describe('ids', () => {
  test('ids are sortable and unique', () => {
    const early = newId(1_700_000_000_000)
    const late = newId(1_700_000_000_001)
    expect(early < late).toBe(true)
    expect(newId()).not.toBe(newId())
    expect(early).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/)
  })

  test('brands reject malformed ids', () => {
    expect(() => DeviceId.parse('not-an-id')).toThrow()
    expect(() => BlobId.parse('XYZ')).toThrow()
    expect(SurfaceId.parse('claude.skills') as string).toBe('claude.skills')
    expect(WorkbenchSessionId.parse(newId())).toHaveLength(26)
  })
})

describe('protocol schemas', () => {
  test('commit requests round-trip', () => {
    const revisionId = RevisionId.parse(newId())
    const payload = {
      protocolVersion: 1,
      revision: {
        id: revisionId,
        storeId,
        deviceId,
        parents: [],
        manifest: { id: blob, size: 1024 },
        createdAt: new Date().toISOString(),
      },
      blobs: [{ id: blob, size: 1024 }],
    }
    const parsed = CommitRequest.parse(payload)
    expect(parsed.revision.id).toBe(revisionId)
    expect(CommitRequest.parse(JSON.parse(JSON.stringify(parsed)))).toEqual(parsed)
  })

  test('kdf params reject non-argon2 and short salts', () => {
    expect(() =>
      KdfParams.parse({
        algo: 'scrypt',
        version: 1,
        salt: 'c2FsdHNhbHRzYWx0',
        m: 1,
        t: 1,
        p: 1,
        calibratedAt: new Date().toISOString(),
      }),
    ).toThrow()
    expect(() =>
      KdfParams.parse({
        algo: 'argon2id',
        version: 1,
        salt: 'short',
        m: 1,
        t: 1,
        p: 1,
        calibratedAt: new Date().toISOString(),
      }),
    ).toThrow()
  })

  test('error responses carry a known code', () => {
    const err = ErrorResponse.parse({ error: { code: 'quota_exceeded', message: 'too big' } })
    expect(err.error.code).toBe('quota_exceeded')
    expect(() => ErrorResponse.parse({ error: { code: 'made_up', message: 'x' } })).toThrow()
  })

  test('revision ids are required where declared', () => {
    expect(() => RevisionId.parse('abc')).toThrow()
  })

  test('workbench sessions carry their temporary actor and lifecycle', () => {
    const session = WorkbenchSession.parse({
      id: newId(),
      deviceId: newId(),
      name: 'review sandbox',
      platform: 'linux',
      createdAt: '2026-09-20T00:00:00.000Z',
      expiresAt: '2026-09-21T00:00:00.000Z',
    })
    expect(session.closedAt).toBeUndefined()
    expect(
      WorkbenchSessionCreateRequest.parse({ name: 'review sandbox', platform: 'linux' }),
    ).toEqual({ name: 'review sandbox', platform: 'linux' })
    expect(
      WorkbenchSessionCreateRequest.parse({
        name: 'review sandbox',
        platform: 'linux',
        expiresInSeconds: 3599,
      }).expiresInSeconds,
    ).toBe(3599)
  })

  test('profile version migrations are an explicit compare-and-set', () => {
    expect(PROFILE_VERSION_HEADER).toBe('x-laurencio-profile-version')
    expect(ProfileVersionWriteRequest.parse({ expectedVersion: 1, profileVersion: 2 })).toEqual({
      expectedVersion: 1,
      profileVersion: 2,
    })
    expect(() =>
      ProfileVersionWriteRequest.parse({ expectedVersion: 2, profileVersion: 3 }),
    ).toThrow()
  })

  test('vault heads expose only an opaque blob reference and generation', () => {
    const blob = { id: BlobId.parse('b'.repeat(64)), size: 128 }
    expect(VaultHeadWriteRequest.parse({ blob, expectedGeneration: null })).toEqual({
      blob,
      expectedGeneration: null,
    })
    const response = VaultHeadResponse.parse({
      protocolVersion: 1,
      head: {
        blob,
        generation: 3,
        updatedAt: '2026-09-20T00:00:00.000Z',
      },
    })
    expect(response.head?.generation).toBe(3)
  })

  test('profile heads expose only an opaque blob reference and generation', () => {
    const blob = { id: BlobId.parse('c'.repeat(64)), size: 256 }
    expect(ProfileHeadWriteRequest.parse({ blob, expectedGeneration: null })).toEqual({
      blob,
      expectedGeneration: null,
    })
    const response = ProfileHeadResponse.parse({
      protocolVersion: 1,
      head: {
        blob,
        generation: 2,
        updatedAt: '2026-09-20T00:00:00.000Z',
      },
    })
    expect(Object.keys(response.head ?? {}).sort()).toEqual(['blob', 'generation', 'updatedAt'])
  })
})

describe('protocol version', () => {
  test('accepts the matching version and explains mismatches', () => {
    expect(checkProtocolVersion(1)).toEqual({ ok: true })
    const ahead = checkProtocolVersion(2)
    expect(ahead.ok).toBe(false)
    if (!ahead.ok) expect(ahead.reason).toContain('Upgrade the client')
    const behind = checkProtocolVersion(0)
    if (!behind.ok) expect(behind.reason).toContain('Upgrade the server')
  })
})
