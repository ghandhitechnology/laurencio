import { expect, test } from 'bun:test'
import { name, version } from '../src/index'

test('protocol package exposes its identity', () => {
  expect(name).toBe('@laurencio/protocol')
  expect(version).toMatch(/^\d+\.\d+\.\d+/)
})
