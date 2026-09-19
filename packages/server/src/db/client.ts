import { mkdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { PGlite } from '@electric-sql/pglite'
import type { PgDatabase, PgQueryResultHKT } from 'drizzle-orm/pg-core'
import { drizzle as drizzlePglite } from 'drizzle-orm/pglite'
import { migrate as migratePglite } from 'drizzle-orm/pglite/migrator'
import { drizzle as drizzlePostgres } from 'drizzle-orm/postgres-js'
import { migrate as migratePostgres } from 'drizzle-orm/postgres-js/migrator'
import postgres from 'postgres'
import type { ServerEnv } from '../env'
import * as schema from './schema'

/**
 * Both drivers are used through this one shape: the query result HKT parameter
 * only describes driver metadata, and app code never touches it.
 */
export type Database = PgDatabase<PgQueryResultHKT, typeof schema>

export interface DatabaseHandle {
  db: Database
  dialect: 'postgres' | 'pglite'
  migrate(): Promise<void>
  close(): Promise<void>
}

export const migrationsFolder = fileURLToPath(new URL('../../drizzle/', import.meta.url))

export function openPostgresDatabase(url: string): DatabaseHandle {
  const client = postgres(url, { max: 10, onnotice: () => {} })
  const db = drizzlePostgres(client, { schema })
  return {
    db,
    dialect: 'postgres',
    migrate: () => migratePostgres(db, { migrationsFolder }),
    close: async () => {
      await client.end()
    },
  }
}

export function openPgliteDatabase(dataDir?: string | null): DatabaseHandle {
  // PGlite's node filesystem only creates the leaf directory, not its parents.
  if (dataDir) mkdirSync(dataDir, { recursive: true })
  const client = dataDir ? new PGlite(dataDir) : new PGlite()
  const db = drizzlePglite(client, { schema })
  return {
    db,
    dialect: 'pglite',
    migrate: () => migratePglite(db, { migrationsFolder }),
    close: () => client.close(),
  }
}

export function openDatabase(env: ServerEnv): DatabaseHandle {
  if (env.database.url) return openPostgresDatabase(env.database.url)
  return openPgliteDatabase(env.database.pgliteDir)
}
