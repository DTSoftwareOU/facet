import { createRequire } from 'node:module';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import type { DatabaseSync } from 'node:sqlite';

// Loaded lazily so the ExperimentalWarning filter in index.ts is installed first.
const require = createRequire(import.meta.url);

export type Db = DatabaseSync;

const MIGRATIONS: string[] = [
  // v1: initial schema
  `
  CREATE TABLE users (
    id TEXT PRIMARY KEY,
    email TEXT NOT NULL UNIQUE,
    display_name TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    kdf_algorithm TEXT NOT NULL,
    kdf_iterations INTEGER NOT NULL,
    kdf_salt BLOB NOT NULL,
    auth_verifier BLOB NOT NULL,
    auth_salt BLOB NOT NULL,
    wrapped_vault_key BLOB NOT NULL,
    recovery_verifier BLOB NOT NULL,
    recovery_salt BLOB NOT NULL,
    recovery_wrapped_vault_key BLOB NOT NULL,
    seq INTEGER NOT NULL DEFAULT 0,
    min_seq INTEGER NOT NULL DEFAULT 0,
    blob_bytes INTEGER NOT NULL DEFAULT 0
  );

  CREATE TABLE sessions (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    refresh_hash BLOB NOT NULL,
    prev_refresh_hash BLOB,
    rotated_at INTEGER,
    device_name TEXT NOT NULL,
    platform TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    last_seen_at INTEGER NOT NULL,
    ip TEXT,
    revoked_at INTEGER
  );
  CREATE INDEX sessions_user ON sessions(user_id);
  CREATE UNIQUE INDEX sessions_refresh ON sessions(refresh_hash);
  CREATE INDEX sessions_prev_refresh ON sessions(prev_refresh_hash);

  CREATE TABLE records (
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    type TEXT NOT NULL,
    id TEXT NOT NULL,
    updated_at INTEGER NOT NULL,
    deleted INTEGER NOT NULL,
    ct BLOB,
    size INTEGER NOT NULL,
    seq INTEGER NOT NULL,
    server_time INTEGER NOT NULL,
    PRIMARY KEY (user_id, type, id)
  );
  CREATE INDEX records_user_seq ON records(user_id, seq);
  CREATE INDEX records_tombstones ON records(deleted, server_time) WHERE deleted = 1;

  CREATE TABLE blobs (
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    id TEXT NOT NULL,
    size INTEGER NOT NULL,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (user_id, id)
  );

  CREATE TABLE reset_tokens (
    token_hash BLOB PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    kind TEXT NOT NULL,
    expires_at INTEGER NOT NULL,
    used_at INTEGER
  );

  CREATE TABLE email_codes (
    user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    code_hash BLOB NOT NULL,
    expires_at INTEGER NOT NULL,
    attempts INTEGER NOT NULL DEFAULT 0
  );
  `,
  // v2: one storage quota per user; chat records count alongside attachment blobs.
  `
  ALTER TABLE users ADD COLUMN record_bytes INTEGER NOT NULL DEFAULT 0;
  UPDATE users SET record_bytes = (
    SELECT COALESCE(SUM(size), 0) + COUNT(*) * 64 FROM records WHERE records.user_id = users.id
  );
  `,
];

export function openDb(dataDir: string): Db {
  mkdirSync(dataDir, { recursive: true });
  const { DatabaseSync: Database } = require('node:sqlite') as typeof import('node:sqlite');
  const db = new Database(path.join(dataDir, 'facet.db'));
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA synchronous = NORMAL;
    PRAGMA foreign_keys = ON;
    PRAGMA busy_timeout = 5000;
  `);
  migrate(db);
  return db;
}

function migrate(db: Db): void {
  db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at INTEGER NOT NULL)`);
  const row = db.prepare('SELECT MAX(version) AS v FROM schema_migrations').get() as { v: number | null } | undefined;
  const current = row?.v ?? 0;
  for (let i = current; i < MIGRATIONS.length; i++) {
    transaction(db, () => {
      db.exec(MIGRATIONS[i]!);
      db.prepare('INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)').run(i + 1, Date.now());
    });
  }
}

/** Runs `fn` inside an IMMEDIATE transaction. `fn` must be synchronous. */
export function transaction<T>(db: Db, fn: () => T): T {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

/** node:sqlite returns BLOB columns as Uint8Array; normalize to Buffer. */
export function buf(value: unknown): Buffer {
  if (value instanceof Uint8Array) return Buffer.from(value.buffer, value.byteOffset, value.byteLength);
  throw new Error('expected BLOB column');
}

export function bufOrNull(value: unknown): Buffer | null {
  return value == null ? null : buf(value);
}
