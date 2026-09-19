import { EnvError, loadEnv } from '../env'
import { openDatabase } from './client'

export async function migrate(): Promise<void> {
  const env = loadEnv()
  const handle = openDatabase(env)
  try {
    await handle.migrate()
    process.stdout.write(
      `${JSON.stringify({ level: 'info', msg: 'migrations applied', dialect: handle.dialect })}\n`,
    )
  } finally {
    await handle.close()
  }
}

if (import.meta.main) {
  try {
    await migrate()
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    process.stderr.write(
      `${JSON.stringify({ level: 'error', msg: 'migration failed', message })}\n`,
    )
    if (error instanceof EnvError) process.stderr.write(`${JSON.stringify({ env: true })}\n`)
    process.exit(1)
  }
}
