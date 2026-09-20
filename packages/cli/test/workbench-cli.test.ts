import { describe, expect, test } from 'bun:test'
import { runCli } from '../src/cli'

describe('portable workbench CLI', () => {
  test('exposes enroll as the full-mode entry point and keeps init as a deprecated alias', async () => {
    const help = await runCli(['--help'])
    const initHelp = await runCli(['init', '--help'])

    expect(help.output).toContain('enroll')
    expect(initHelp.output).toContain('Deprecated')
    expect(initHelp.output).toContain('laurencio enroll')
  })

  test('bare laurencio presents the two lifecycle choices in an interactive terminal', async () => {
    const live: string[] = []
    const output = await runCli([], {
      io: {
        terminal: {
          write: () => {},
          columns: () => 80,
          onInterrupt: () => () => {},
        },
        out: (text) => live.push(text),
        err: () => {},
        readLine: async () => {
          expect(live.join('\n')).toContain('Manage configuration')
          return 'q'
        },
        readSecret: async () => '',
      },
    })

    expect(output.exitCode).toBe(0)
    expect(live.join('\n')).toContain('Temporary workbench')
    expect(live.join('\n')).toContain('Full enrollment')
    expect(output.output).toBe('')
  })
})
