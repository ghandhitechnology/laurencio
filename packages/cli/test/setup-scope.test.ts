import { describe, expect, test } from 'bun:test'
import { defaultPolicy } from '@laurencio/core'
import { parseCliArgs } from '../src/args'
import { createContext } from '../src/context'
import { chooseSetupScope } from '../src/setup-scope'
import { makeScratch, scriptedIo } from './helpers'

const surfaces = [
  {
    id: 'claude.skills',
    harness: 'claude',
    policy: 'sync',
    description: 'skills',
  },
  {
    id: 'claude.instructions',
    harness: 'claude',
    policy: 'sync',
    description: 'instructions',
  },
  {
    id: 'claude.rules',
    harness: 'claude',
    policy: 'sync',
    description: 'rules',
  },
  {
    id: 'claude.settings',
    harness: 'claude',
    policy: 'sync',
    description: 'settings',
  },
  {
    id: 'claude.memory',
    harness: 'claude',
    policy: 'opt-in',
    description: 'memory',
  },
]

describe('setup scope', () => {
  test('skills-only keeps machine instructions and opt-in memory local', async () => {
    const scratch = makeScratch()
    try {
      const parsed = parseCliArgs(['init'])
      const ctx = createContext('init', null, [], parsed.flags, {
        home: scratch.home,
        io: scriptedIo(['s']),
      })
      const result = await chooseSetupScope(ctx, defaultPolicy(), surfaces)
      expect(result.scope).toBe('skills')
      expect(result.policy.harnesses.claude?.surfaces).toEqual({
        'claude.skills': 'on',
        'claude.instructions': 'off',
        'claude.rules': 'off',
        'claude.settings': 'off',
        'claude.memory': 'off',
      })
    } finally {
      scratch.cleanup()
    }
  })

  test('portable preset still leaves machine instructions and memory local', async () => {
    const scratch = makeScratch()
    try {
      const parsed = parseCliArgs(['init'])
      const ctx = createContext('init', null, [], parsed.flags, {
        home: scratch.home,
        io: scriptedIo(['p']),
      })
      const result = await chooseSetupScope(ctx, defaultPolicy(), surfaces)
      expect(result.scope).toBe('portable')
      expect(result.policy.harnesses.claude?.surfaces).toEqual({
        'claude.skills': 'on',
        'claude.instructions': 'off',
        'claude.rules': 'off',
        'claude.settings': 'on',
        'claude.memory': 'off',
      })
    } finally {
      scratch.cleanup()
    }
  })

  test('fresh scripted setup defaults to the safe skills-only scope', async () => {
    const scratch = makeScratch()
    try {
      const parsed = parseCliArgs(['init', '--yes'])
      const ctx = createContext('init', null, [], parsed.flags, {
        home: scratch.home,
        io: scriptedIo(),
      })
      const result = await chooseSetupScope(ctx, defaultPolicy(), surfaces)
      expect(result.scope).toBe('skills')
      expect(result.policy.harnesses.claude?.surfaces).toEqual({
        'claude.skills': 'on',
        'claude.instructions': 'off',
        'claude.rules': 'off',
        'claude.settings': 'off',
        'claude.memory': 'off',
      })
    } finally {
      scratch.cleanup()
    }
  })

  test('scripted setup preserves an existing enrollment with legacy implicit choices', async () => {
    const scratch = makeScratch()
    try {
      const parsed = parseCliArgs(['init', '--yes'])
      const ctx = createContext('init', null, [], parsed.flags, {
        home: scratch.home,
        io: scriptedIo(),
      })
      const result = await chooseSetupScope(ctx, defaultPolicy(), surfaces, true)
      expect(result.scope).toBe('existing')
      expect(result.policy.harnesses).toEqual({})
    } finally {
      scratch.cleanup()
    }
  })
})
