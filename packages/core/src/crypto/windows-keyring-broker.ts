import { type ChildProcessWithoutNullStreams, spawn } from 'node:child_process'

export class WindowsCredentialError extends Error {}

export type WindowsCredentialRunner = (
  executable: string,
  args: string[],
  input: string,
) => Promise<string>

interface BrokerOptions {
  launch?: (executable: string, args: string[]) => ChildProcessWithoutNullStreams
  timeoutMs?: number
}

/** Private process pipes carry credentials; only one request is in flight. */
export function createWindowsCredentialBroker(options: BrokerOptions = {}) {
  const timeoutMs = options.timeoutMs ?? 120_000
  const launch =
    options.launch ??
    ((executable, args) =>
      spawn(executable, args, {
        windowsHide: true,
        stdio: 'pipe',
      }))
  let child: ChildProcessWithoutNullStreams | undefined
  let sequence = 0
  let tail = Promise.resolve()
  let output = ''
  let stage = 'starting Windows PowerShell'
  let pending:
    | {
        id: number
        resolve: (raw: string) => void
        reject: (error: Error) => void
        timer: ReturnType<typeof setTimeout>
      }
    | undefined

  function reference(active: boolean) {
    if (!child) return
    if (active) child.ref()
    else child.unref()
    for (const stream of [child.stdin, child.stdout, child.stderr]) {
      const handle = stream as typeof stream & { ref?: () => void; unref?: () => void }
      if (active) handle.ref?.()
      else handle.unref?.()
    }
  }

  function teardown() {
    const previous = child
    child = undefined
    output = ''
    process.removeListener('exit', onExit)
    previous?.stdin.destroy()
    previous?.stdout.destroy()
    previous?.stderr.destroy()
    previous?.kill()
  }

  function fail(error: Error) {
    const request = pending
    pending = undefined
    if (request) clearTimeout(request.timer)
    teardown()
    request?.reject(error)
  }

  function onExit() {
    teardown()
  }

  function start(executable: string, args: string[]) {
    stage = 'starting Windows PowerShell'
    const started = launch(executable, args)
    child = started
    process.once('exit', onExit)
    started.stdout.setEncoding('utf8')
    started.stderr.setEncoding('utf8')
    started.stdout.on('data', (chunk: string) => {
      if (child !== started) return
      output += chunk
      if (output.length > 64 * 1024) {
        fail(
          new WindowsCredentialError(
            'Windows Credential Manager helper exceeded its response limit.',
          ),
        )
        return
      }
      let newline = output.indexOf('\n')
      while (newline !== -1) {
        const line = output.slice(0, newline)
        output = output.slice(newline + 1)
        let id: unknown
        try {
          id = (JSON.parse(line) as { id: unknown }).id
        } catch {}
        const request = pending
        if (!request || id !== request.id) {
          fail(
            new WindowsCredentialError(
              'Windows Credential Manager helper returned an invalid response.',
            ),
          )
          return
        }
        pending = undefined
        clearTimeout(request.timer)
        reference(false)
        request.resolve(line)
        newline = output.indexOf('\n')
      }
    })
    started.stderr.on('data', (chunk: string) => {
      if (child !== started) return
      // Only fixed markers are eligible for diagnostics; never retain stderr.
      for (const value of [
        'initializing Win32 bindings',
        'reading request',
        'calling Credential Manager',
      ]) {
        if (chunk.includes(`LAURENCIO_CREDENTIAL_STAGE:${value}`)) stage = value
      }
    })
    const unavailable = () => {
      if (child === started)
        fail(new WindowsCredentialError('Windows Credential Manager helper stopped unexpectedly.'))
    }
    started.on('error', unavailable)
    started.on('exit', unavailable)
    started.stdin.on('error', unavailable)
    // Bun's pipe ref()/unref() calls are counted, so balance the initial
    // reference before each request starts its own active reference.
    reference(false)
  }

  const run: WindowsCredentialRunner = (executable, args, input) => {
    const result = tail.then(
      () =>
        new Promise<string>((resolve, reject) => {
          try {
            if (!child) start(executable, args)
            const id = ++sequence
            reference(true)
            const timer = setTimeout(
              () =>
                fail(
                  new WindowsCredentialError(
                    `Windows Credential Manager helper timed out after ${timeoutMs / 1000} seconds while ${stage}.`,
                  ),
                ),
              timeoutMs,
            )
            pending = { id, resolve, reject, timer }
            child?.stdin.write(`${JSON.stringify({ ...JSON.parse(input), id })}\n`)
          } catch {
            const error = new WindowsCredentialError(
              'Windows Credential Manager helper could not run.',
            )
            fail(error)
            reject(error)
          }
        }),
    )
    tail = result.then(
      () => {},
      () => {},
    )
    return result
  }
  return {
    run,
    close: () => fail(new WindowsCredentialError('Windows Credential Manager helper closed.')),
  }
}
