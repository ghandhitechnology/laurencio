import { randomUUID } from 'node:crypto'
import { resolveKeychainStore } from '../packages/core/src/crypto/keyring'

if (process.platform !== 'win32') throw new Error('Run this acceptance check on Windows.')
const store = await resolveKeychainStore()
const service = 'laurencio-release-check'
const account = randomUUID()
const secret = crypto.getRandomValues(new Uint8Array(32))
let failure: unknown
try {
  console.log('Writing Windows Credential Manager probe.')
  await store.set(service, account, secret)
  console.log('Reading Windows Credential Manager probe.')
  const loaded = await store.get(service, account)
  if (loaded === null || !Buffer.from(loaded).equals(Buffer.from(secret))) {
    throw new Error('Windows Credential Manager did not return the stored credential.')
  }
  loaded.fill(0)
} catch (error) {
  failure = error
} finally {
  secret.fill(0)
  console.log('Deleting Windows Credential Manager probe.')
  try {
    await store.delete(service, account)
  } catch (error) {
    failure ??= error
  }
}
if (failure !== undefined) throw failure
console.log('Verifying Windows Credential Manager probe cleanup.')
if ((await store.get(service, account)) !== null) throw new Error('Credential cleanup failed.')
console.log('Windows Credential Manager round trip passed.')
