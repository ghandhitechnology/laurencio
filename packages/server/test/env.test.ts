import { describe, expect, test } from 'bun:test'
import { EnvError, loadEnv } from '../src/env'

const productionBase = {
  NODE_ENV: 'production',
  BETTER_AUTH_SECRET: 'prod-secret',
  DATABASE_URL: 'postgres://db/laurencio',
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

  test('a valid production env binds for a container and disables generation', () => {
    const env = loadEnv(productionBase)
    expect(env.storage.kind).toBe('s3')
    expect(env.generatedSecret).toBe(false)
    expect(env.host).toBe('0.0.0.0')
  })

  test('staging binds for a container and keeps development affordances', () => {
    const env = loadEnv({
      ...productionBase,
      NODE_ENV: 'staging',
      ALLOW_DEV_SIGNIN: 'true',
      STAGING_EMAIL_ALLOWLIST: ' Andy@Example.com , other@example.com ',
    })
    expect(env.nodeEnv).toBe('staging')
    expect(env.host).toBe('0.0.0.0')
    expect(env.auth.allowDevSignin).toBe(true)
    expect(env.auth.stagingEmailAllowlist).toEqual(['andy@example.com', 'other@example.com'])
  })

  test('staging email access requires an explicit allowlist', () => {
    expect(() => loadEnv({ NODE_ENV: 'staging' })).toThrow(/STAGING_EMAIL_ALLOWLIST/)
    expect(() => loadEnv({ NODE_ENV: 'staging', STAGING_EMAIL_ALLOWLIST: ' , ' })).toThrow(
      /STAGING_EMAIL_ALLOWLIST/,
    )
    expect(loadEnv({ NODE_ENV: 'staging', ALLOW_DEV_SIGNIN: '0' }).auth.allowDevSignin).toBe(false)
  })

  test('development stays on loopback and an explicit host wins', () => {
    expect(loadEnv({}).host).toBe('127.0.0.1')
    expect(loadEnv({ HOST: '0.0.0.0' }).host).toBe('0.0.0.0')
  })
})
