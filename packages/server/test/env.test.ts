import { describe, expect, test } from 'bun:test'
import { EnvError, loadEnv } from '../src/env'

const productionBase = {
  NODE_ENV: 'production',
  BETTER_AUTH_SECRET: 'prod-secret',
  DATABASE_URL: 'postgres://db/laurencio',
  GITHUB_CLIENT_ID: 'client-id',
  GITHUB_CLIENT_SECRET: 'client-secret',
  S3_BUCKET: 'laurencio',
  ACCESS_KEY_ID: 'key-id',
  SECRET_ACCESS_KEY: 'key-secret',
}

describe('development defaults', () => {
  test('bind loopback unless HOST is set', () => {
    expect(loadEnv({ NODE_ENV: 'development' }).host).toBe('127.0.0.1')
    expect(loadEnv({ NODE_ENV: 'test' }).host).toBe('127.0.0.1')
    expect(loadEnv({ NODE_ENV: 'test', HOST: '0.0.0.0' }).host).toBe('0.0.0.0')
  })

  test('never reuse a fixed fallback secret outside production', () => {
    const first = loadEnv({ NODE_ENV: 'development' })
    const second = loadEnv({ NODE_ENV: 'development' })
    expect(first.generatedSecret).toBe(true)
    expect(first.secret).not.toBe('laurencio-development-secret')
    expect(first.secret).not.toBe(second.secret)
    expect(first.storage.kind).toBe('fs')
    expect(second.storage.kind).toBe('fs')
    if (first.storage.kind !== 'fs' || second.storage.kind !== 'fs') return
    expect(first.storage.secret).not.toBe('laurencio-development-secret')
    expect(first.storage.secret).not.toBe(second.storage.secret)
  })

  test('an explicit secret is used verbatim and a bare auth secret seeds storage', () => {
    const explicit = loadEnv({
      NODE_ENV: 'development',
      BETTER_AUTH_SECRET: 'fixed-auth',
      FS_STORAGE_SECRET: 'fixed-fs',
    })
    expect(explicit.generatedSecret).toBe(false)
    expect(explicit.secret).toBe('fixed-auth')
    if (explicit.storage.kind === 'fs') expect(explicit.storage.secret).toBe('fixed-fs')

    const fallback = loadEnv({ NODE_ENV: 'development', BETTER_AUTH_SECRET: 'fixed-auth' })
    expect(fallback.generatedSecret).toBe(false)
    if (fallback.storage.kind === 'fs') expect(fallback.storage.secret).toBe('fixed-auth')
  })

  test('production refuses a missing secret, dev sign-in, and filesystem storage', () => {
    expect(() => loadEnv({ NODE_ENV: 'production' })).toThrow(EnvError)
    expect(() => loadEnv({ ...productionBase, ALLOW_DEV_SIGNIN: '1' })).toThrow(EnvError)
    const withoutBucket = { ...productionBase, S3_BUCKET: undefined, STORAGE_DRIVER: 'fs' }
    expect(() => loadEnv(withoutBucket)).toThrow(/filesystem storage/)
  })

  test('a valid production env still listens on loopback and disables generation', () => {
    const env = loadEnv(productionBase)
    expect(env.storage.kind).toBe('s3')
    expect(env.generatedSecret).toBe(false)
    expect(env.host).toBe('127.0.0.1')
  })
})
