import { sql } from 'drizzle-orm'
import {
  bigint,
  boolean,
  check,
  foreignKey,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
} from 'drizzle-orm/pg-core'

/**
 * Tables prefixed with `ba` comments are owned by Better Auth: every JS key
 * must keep the name Better Auth's adapter looks up (camelCase fields), and
 * the SQL names are snake_case like the rest of the database.
 */

export const users = pgTable('users', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  email: text('email').notNull().unique(),
  emailVerified: boolean('email_verified').notNull().default(false),
  image: text('image'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
})

export const sessions = pgTable('sessions', {
  id: text('id').primaryKey(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  token: text('token').notNull().unique(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  ipAddress: text('ip_address'),
  userAgent: text('user_agent'),
  userId: text('user_id')
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
})

export const accounts = pgTable('accounts', {
  id: text('id').primaryKey(),
  accountId: text('account_id').notNull(),
  providerId: text('provider_id').notNull(),
  userId: text('user_id')
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  accessToken: text('access_token'),
  refreshToken: text('refresh_token'),
  idToken: text('id_token'),
  accessTokenExpiresAt: timestamp('access_token_expires_at', { withTimezone: true }),
  refreshTokenExpiresAt: timestamp('refresh_token_expires_at', { withTimezone: true }),
  scope: text('scope'),
  password: text('password'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
})

export const verifications = pgTable('verifications', {
  id: text('id').primaryKey(),
  identifier: text('identifier').notNull(),
  value: text('value').notNull(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
})

export const deviceCodes = pgTable(
  'device_codes',
  {
    id: text('id').primaryKey(),
    deviceCode: text('device_code').notNull().unique(),
    userCode: text('user_code').notNull().unique(),
    userId: text('user_id').references(() => users.id, { onDelete: 'cascade' }),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    status: text('status').notNull(),
    lastPolledAt: timestamp('last_polled_at', { withTimezone: true }),
    pollingInterval: integer('polling_interval'),
    clientId: text('client_id'),
    scope: text('scope'),
  },
  (table) => [index('device_codes_user_idx').on(table.userId)],
)

/** One encrypted object store per user. */
export const stores = pgTable(
  'stores',
  {
    id: text('id').primaryKey(),
    userId: text('user_id')
      .notNull()
      .unique()
      .references(() => users.id, { onDelete: 'cascade' }),
    maxBytes: bigint('max_bytes', { mode: 'number' }),
    maxBlobs: bigint('max_blobs', { mode: 'number' }),
    profileVersion: integer('profile_version').notNull().default(1),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [check('stores_profile_version_check', sql`${table.profileVersion} in (1, 2)`)],
)

export const devices = pgTable(
  'devices',
  {
    id: text('id').primaryKey(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    platform: text('platform').notNull(),
    kind: text('kind').notNull().default('full'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    lastSeenAt: timestamp('last_seen_at', { withTimezone: true }),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
  },
  (table) => [
    index('devices_user_idx').on(table.userId),
    check('devices_kind_check', sql`${table.kind} in ('full', 'temporary')`),
  ],
)

/** A bounded workbench actor backed by a temporary device. */
export const workbenchSessions = pgTable(
  'workbench_sessions',
  {
    id: text('id').primaryKey(),
    deviceId: text('device_id')
      .notNull()
      .references(() => devices.id, { onDelete: 'cascade' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    closedAt: timestamp('closed_at', { withTimezone: true }),
  },
  (table) => [
    uniqueIndex('workbench_sessions_device_idx').on(table.deviceId),
    index('workbench_sessions_expires_idx').on(table.expiresAt),
  ],
)

export const deviceTokens = pgTable(
  'device_tokens',
  {
    id: text('id').primaryKey(),
    deviceId: text('device_id')
      .notNull()
      .references(() => devices.id, { onDelete: 'cascade' }),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    tokenHash: text('token_hash').notNull().unique(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    lastUsedAt: timestamp('last_used_at', { withTimezone: true }),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    expiresAt: timestamp('expires_at', { withTimezone: true }),
  },
  (table) => [index('device_tokens_device_idx').on(table.deviceId)],
)

/** Public KDF parameters. The row always holds the latest generation. */
export const kdfParams = pgTable('kdf_params', {
  storeId: text('store_id')
    .primaryKey()
    .references(() => stores.id, { onDelete: 'cascade' }),
  algo: text('algo').notNull(),
  version: integer('version').notNull(),
  salt: text('salt').notNull(),
  m: integer('m').notNull(),
  t: integer('t').notNull(),
  p: integer('p').notNull(),
  calibratedAt: timestamp('calibrated_at', { withTimezone: true }).notNull(),
  setAt: timestamp('set_at', { withTimezone: true }).notNull().defaultNow(),
  /** Rotation counter: the first write is generation 1, every rotation adds one. */
  generation: integer('generation').notNull().default(1),
})

/** Superseded generations kept for audit; the first write is copied here on rotation. */
export const kdfParamVersions = pgTable(
  'kdf_param_versions',
  {
    storeId: text('store_id')
      .notNull()
      .references(() => stores.id, { onDelete: 'cascade' }),
    generation: integer('generation').notNull(),
    algo: text('algo').notNull(),
    version: integer('version').notNull(),
    salt: text('salt').notNull(),
    m: integer('m').notNull(),
    t: integer('t').notNull(),
    p: integer('p').notNull(),
    calibratedAt: timestamp('calibrated_at', { withTimezone: true }).notNull(),
    rotatedAt: timestamp('rotated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [primaryKey({ columns: [table.storeId, table.generation] })],
)

export const auditLog = pgTable(
  'audit_log',
  {
    id: text('id').primaryKey(),
    actorUserId: text('actor_user_id').references(() => users.id, { onDelete: 'set null' }),
    deviceId: text('device_id').references(() => devices.id, { onDelete: 'set null' }),
    action: text('action').notNull(),
    subject: text('subject'),
    at: timestamp('at', { withTimezone: true }).notNull().defaultNow(),
    meta: jsonb('meta'),
  },
  (table) => [index('audit_log_actor_idx').on(table.actorUserId, table.at)],
)

/**
 * Blob ids are the sha256 of the ciphertext, so the row id alone is enough to
 * address storage; the primary key is per store because two stores may hold
 * identical ciphertext.
 */
export const blobs = pgTable(
  'blobs',
  {
    id: text('id').notNull(),
    storeId: text('store_id')
      .notNull()
      .references(() => stores.id, { onDelete: 'cascade' }),
    size: bigint('size', { mode: 'number' }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    verifiedAt: timestamp('verified_at', { withTimezone: true }),
  },
  (table) => [
    primaryKey({ columns: [table.storeId, table.id] }),
    index('blobs_store_created_idx').on(table.storeId, table.createdAt),
  ],
)

/** Current opaque encrypted-vault snapshot for a store. */
export const vaultHeads = pgTable(
  'vault_heads',
  {
    storeId: text('store_id')
      .primaryKey()
      .references(() => stores.id, { onDelete: 'cascade' }),
    blobId: text('blob_id').notNull(),
    blobSize: bigint('blob_size', { mode: 'number' }).notNull(),
    generation: integer('generation').notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    foreignKey({
      name: 'vault_heads_store_blob_fk',
      columns: [table.storeId, table.blobId],
      foreignColumns: [blobs.storeId, blobs.id],
    }),
  ],
)

/** Current opaque encrypted profile snapshot for a store. */
export const profileHeads = pgTable(
  'profile_heads',
  {
    storeId: text('store_id')
      .primaryKey()
      .references(() => stores.id, { onDelete: 'cascade' }),
    blobId: text('blob_id').notNull(),
    blobSize: bigint('blob_size', { mode: 'number' }).notNull(),
    generation: integer('generation').notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    foreignKey({
      name: 'profile_heads_store_blob_fk',
      columns: [table.storeId, table.blobId],
      foreignColumns: [blobs.storeId, blobs.id],
    }),
  ],
)

export const revisions = pgTable(
  'revisions',
  {
    id: text('id').primaryKey(),
    storeId: text('store_id')
      .notNull()
      .references(() => stores.id, { onDelete: 'cascade' }),
    deviceId: text('device_id')
      .notNull()
      .references(() => devices.id, { onDelete: 'cascade' }),
    parents: jsonb('parents').$type<string[]>().notNull(),
    manifestBlobId: text('manifest_blob_id').notNull(),
    manifestSize: bigint('manifest_size', { mode: 'number' }).notNull(),
    note: text('note'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('revisions_store_created_idx').on(table.storeId, table.createdAt),
    index('revisions_store_device_idx').on(table.storeId, table.deviceId),
  ],
)

/** Fan-out rows: one per blob a revision references. GC deletes only unreferenced blobs. */
export const revisionBlobs = pgTable(
  'revision_blobs',
  {
    revisionId: text('revision_id')
      .notNull()
      .references(() => revisions.id, { onDelete: 'cascade' }),
    storeId: text('store_id').notNull(),
    blobId: text('blob_id').notNull(),
    size: bigint('size', { mode: 'number' }).notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.revisionId, table.blobId] }),
    index('revision_blobs_store_blob_idx').on(table.storeId, table.blobId),
    index('revision_blobs_store_revision_idx').on(table.storeId, table.revisionId),
  ],
)

export const authSchema = { users, sessions, accounts, verifications, deviceCodes }
