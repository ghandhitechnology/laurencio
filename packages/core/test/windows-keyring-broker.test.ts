import { expect, test } from 'bun:test'
import { spawn, spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { createWindowsCredentialBroker } from '../src/crypto/windows-keyring-broker'

const helper = `
const readline = require('node:readline');
readline.createInterface({ input: process.stdin }).on('line', (line) => {
  const request = JSON.parse(line);
  if (request.operation === 'hang') return;
  if (request.operation === 'bad') { console.log('secret-bearing malformed output'); return; }
  console.log(JSON.stringify({ id: request.id, ok: true, secret: null, pid: process.pid }));
});
`

test('credential broker reuses one child and serializes concurrent requests', async () => {
  let launches = 0
  const broker = createWindowsCredentialBroker({
    launch: () => {
      launches++
      return spawn(process.execPath, ['-e', helper], { stdio: 'pipe' })
    },
  })
  try {
    const results = await Promise.all(
      Array.from({ length: 4 }, () => broker.run('unused', [], '{"operation":"get"}')),
    )
    expect(launches).toBe(1)
    expect(results.map((value) => JSON.parse(value).id)).toEqual([1, 2, 3, 4])
    expect(new Set(results.map((value) => JSON.parse(value).pid)).size).toBe(1)
  } finally {
    broker.close()
  }
})

test('credential broker kills a timed-out child and recovers for the next request', async () => {
  let launches = 0
  const broker = createWindowsCredentialBroker({
    timeoutMs: 200,
    launch: () => {
      launches++
      return spawn(process.execPath, ['-e', helper], { stdio: 'pipe' })
    },
  })
  try {
    await expect(broker.run('unused', [], '{"operation":"hang"}')).rejects.toThrow('timed out')
    expect(JSON.parse(await broker.run('unused', [], '{"operation":"get"}')).ok).toBe(true)
    expect(launches).toBe(2)
    await expect(broker.run('unused', [], '{"operation":"bad"}')).rejects.toThrow(
      'invalid response',
    )
  } finally {
    broker.close()
  }
})

test('an idle credential broker does not prevent its parent CLI from exiting', () => {
  const modulePath = fileURLToPath(
    new URL('../src/crypto/windows-keyring-broker.ts', import.meta.url),
  )
  const source = `
import { createWindowsCredentialBroker } from ${JSON.stringify(modulePath)};
import { spawn } from 'node:child_process';
const broker = createWindowsCredentialBroker({ launch: () => spawn(process.execPath, ['-e', ${JSON.stringify(helper)}], { stdio: 'pipe' }) });
await broker.run('unused', [], '{"operation":"get"}');
console.log('completed');
`
  const result = spawnSync(process.execPath, ['-e', source], { encoding: 'utf8', timeout: 5000 })
  expect(result.error).toBeUndefined()
  expect(result.status).toBe(0)
  expect(result.stdout.trim()).toBe('completed')
})
