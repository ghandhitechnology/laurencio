import { describe, expect, test } from 'bun:test'
import { isQuiescent, QuiescenceGate } from '../src/quiescence'

describe('quiescence', () => {
  test('the pure rule compares mtime age against the window', () => {
    expect(isQuiescent(1000, 3000, 1500)).toBe(true)
    expect(isQuiescent(1000, 2000, 1500)).toBe(false)
    expect(isQuiescent(1000, 1000, 0)).toBe(true)
  })

  test('a single read is never quiescent, an unchanged old file is', () => {
    let now = 10_000
    const gate = new QuiescenceGate({ windowMs: 1000, now: () => now })
    expect(gate.observe('a', 5000)).toBe('pending')
    now = 10_001
    expect(gate.observe('a', 5000)).toBe('quiescent')
    now = 10_500
    expect(gate.observe('a', 10_000)).toBe('pending')
    now = 10_600
    expect(gate.observe('a', 10_000)).toBe('deferred')
    now = 12_000
    expect(gate.observe('a', 10_000)).toBe('quiescent')
  })

  test('prime records the plan read so apply time is the second read', () => {
    const now = 10_000
    const gate = new QuiescenceGate({ windowMs: 500, now: () => now })
    gate.prime('b', 9000)
    expect(gate.observe('b', 9000)).toBe('quiescent')
    gate.forget('b')
    expect(gate.observe('b', 9000)).toBe('pending')
  })

  test('a zero window still requires two matching reads', () => {
    const gate = new QuiescenceGate({ windowMs: 0, now: () => 5000 })
    expect(gate.observe('c', 5000)).toBe('pending')
    expect(gate.observe('c', 5000)).toBe('quiescent')
  })

  test('a future mtime settles once two reads agree instead of deferring forever', () => {
    let now = 10_000
    const gate = new QuiescenceGate({ windowMs: 1000, now: () => now })
    expect(gate.observe('d', 20_000)).toBe('pending')
    expect(gate.observe('d', 20_000)).toBe('quiescent')
    now = 10_010
    expect(gate.observe('d', 20_000)).toBe('quiescent')
  })
})
