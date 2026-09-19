import { z } from 'zod'

/**
 * Sortable identifiers: 48-bit millisecond timestamp plus 80 bits of entropy,
 * Crockford base32, 26 characters, lexicographic order matches creation order.
 */

const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'

export function newId(
  now: number = Date.now(),
  random: Uint8Array = crypto.getRandomValues(new Uint8Array(10)),
): string {
  let timePart = ''
  let t = now
  for (let i = 0; i < 10; i += 1) {
    timePart = ALPHABET[t % 32]! + timePart
    t = Math.floor(t / 32)
  }
  let randomPart = ''
  let bits = 0
  let value = 0
  for (const byte of random) {
    value = (value << 8) | byte
    bits += 8
    while (bits >= 5) {
      bits -= 5
      randomPart += ALPHABET[(value >>> bits) & 31]!
    }
  }
  return timePart + randomPart.slice(0, 16)
}

const idPattern = /^[0-9A-HJKMNP-TV-Z]{26}$/

export const UserId = z.string().regex(idPattern, 'not a laurencio id').brand<'UserId'>()
export const DeviceId = z.string().regex(idPattern, 'not a laurencio id').brand<'DeviceId'>()
export const StoreId = z.string().regex(idPattern, 'not a laurencio id').brand<'StoreId'>()
export const RevisionId = z.string().regex(idPattern, 'not a laurencio id').brand<'RevisionId'>()
export const BlobId = z
  .string()
  .regex(/^[0-9a-f]{64}$/, 'blob ids are lowercase sha256 hex')
  .brand<'BlobId'>()
export const SurfaceId = z
  .string()
  .regex(/^[a-z0-9-]+\.[a-z0-9-]+$/, 'surface ids look like harness.surface')
  .brand<'SurfaceId'>()

export type UserId = z.infer<typeof UserId>
export type DeviceId = z.infer<typeof DeviceId>
export type StoreId = z.infer<typeof StoreId>
export type RevisionId = z.infer<typeof RevisionId>
export type BlobId = z.infer<typeof BlobId>
export type SurfaceId = z.infer<typeof SurfaceId>

export { idPattern }
