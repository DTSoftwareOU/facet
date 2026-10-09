import type { Config } from './config.js';
import { buf, bufOrNull, transaction, type Db } from './db.js';
import { newId, randomToken, sha256 } from './crypto.js';
import type { DeviceInput } from './validation.js';
import { RECORD_OVERHEAD_BYTES } from './records.js';

export interface UserRow {
  id: string;
  email: string;
  displayName: string | null;
  createdAt: number;
  updatedAt: number;
  kdfAlgorithm: string;
  kdfIterations: number;
  kdfSalt: Buffer;
  authVerifier: Buffer;
  authSalt: Buffer;
  wrappedVaultKey: Buffer;
  recoveryVerifier: Buffer;
  recoverySalt: Buffer;
  recoveryWrappedVaultKey: Buffer;
  seq: number;
  minSeq: number;
  blobBytes: number;
  recordBytes: number;
}

export interface SessionRow {
  id: string;
  userId: string;
  refreshHash: Buffer;
  prevRefreshHash: Buffer | null;
  rotatedAt: number | null;
  deviceName: string;
  platform: string;
  createdAt: number;
  lastSeenAt: number;
  ip: string | null;
  revokedAt: number | null;
}

export interface Credentials {
  kdfIterations: number;
  kdfSalt: Buffer;
  authVerifier: Buffer;
  authSalt: Buffer;
  wrappedVaultKey: Buffer;
}

export interface RecoveryCredentials {
  recoveryVerifier: Buffer;
  recoverySalt: Buffer;
  recoveryWrappedVaultKey: Buffer;
}

export interface PublicUser {
  id: string;
  email: string;
  displayName: string | null;
  createdAt: number;
  storage: { usedBytes: number; quotaBytes: number; recordBytes: number; blobBytes: number };
}

export interface PublicKdf {
  algorithm: 'pbkdf2-sha256';
  iterations: number;
  salt: string;
}

type Row = Record<string, unknown>;

function toUser(r: Row): UserRow {
  return {
    id: r.id as string,
    email: r.email as string,
    displayName: (r.display_name as string | null) ?? null,
    createdAt: r.created_at as number,
    updatedAt: r.updated_at as number,
    kdfAlgorithm: r.kdf_algorithm as string,
    kdfIterations: r.kdf_iterations as number,
    kdfSalt: buf(r.kdf_salt),
    authVerifier: buf(r.auth_verifier),
    authSalt: buf(r.auth_salt),
    wrappedVaultKey: buf(r.wrapped_vault_key),
    recoveryVerifier: buf(r.recovery_verifier),
    recoverySalt: buf(r.recovery_salt),
    recoveryWrappedVaultKey: buf(r.recovery_wrapped_vault_key),
    seq: r.seq as number,
    minSeq: r.min_seq as number,
    blobBytes: r.blob_bytes as number,
    recordBytes: (r.record_bytes as number | undefined) ?? 0,
  };
}

function toSession(r: Row): SessionRow {
  return {
    id: r.id as string,
    userId: r.user_id as string,
    refreshHash: buf(r.refresh_hash),
    prevRefreshHash: bufOrNull(r.prev_refresh_hash),
    rotatedAt: (r.rotated_at as number | null) ?? null,
    deviceName: r.device_name as string,
    platform: r.platform as string,
    createdAt: r.created_at as number,
    lastSeenAt: r.last_seen_at as number,
    ip: (r.ip as string | null) ?? null,
    revokedAt: (r.revoked_at as number | null) ?? null,
  };
}

/** Users, sessions and one-time tokens. */
export class Store {
  constructor(
    readonly db: Db,
    private readonly config: Config,
  ) {}

  // ----- users ---------------------------------------------------------------

  userByEmail(email: string): UserRow | null {
    const r = this.db.prepare('SELECT * FROM users WHERE email = ?').get(email) as Row | undefined;
    return r ? toUser(r) : null;
  }

  userById(id: string): UserRow | null {
    const r = this.db.prepare('SELECT * FROM users WHERE id = ?').get(id) as Row | undefined;
    return r ? toUser(r) : null;
  }

  createUser(input: {
    email: string;
    displayName: string | null;
    credentials: Credentials;
    recovery: RecoveryCredentials;
  }): UserRow {
    const id = newId();
    const now = Date.now();
    const c = input.credentials;
    const rc = input.recovery;
    this.db
      .prepare(
        `INSERT INTO users (id, email, display_name, created_at, updated_at, kdf_algorithm, kdf_iterations, kdf_salt,
          auth_verifier, auth_salt, wrapped_vault_key, recovery_verifier, recovery_salt, recovery_wrapped_vault_key)
         VALUES (?, ?, ?, ?, ?, 'pbkdf2-sha256', ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        input.email,
        input.displayName,
        now,
        now,
        c.kdfIterations,
        c.kdfSalt,
        c.authVerifier,
        c.authSalt,
        c.wrappedVaultKey,
        rc.recoveryVerifier,
        rc.recoverySalt,
        rc.recoveryWrappedVaultKey,
      );
    return this.userById(id)!;
  }

  setCredentials(userId: string, c: Credentials): void {
    this.db
      .prepare(
        `UPDATE users SET kdf_algorithm = 'pbkdf2-sha256', kdf_iterations = ?, kdf_salt = ?, auth_verifier = ?,
           auth_salt = ?, wrapped_vault_key = ?, updated_at = ? WHERE id = ?`,
      )
      .run(c.kdfIterations, c.kdfSalt, c.authVerifier, c.authSalt, c.wrappedVaultKey, Date.now(), userId);
  }

  setRecovery(userId: string, rc: RecoveryCredentials): void {
    this.db
      .prepare(
        `UPDATE users SET recovery_verifier = ?, recovery_salt = ?, recovery_wrapped_vault_key = ?, updated_at = ?
         WHERE id = ?`,
      )
      .run(rc.recoveryVerifier, rc.recoverySalt, rc.recoveryWrappedVaultKey, Date.now(), userId);
  }

  setDisplayName(userId: string, displayName: string | null): void {
    this.db.prepare('UPDATE users SET display_name = ?, updated_at = ? WHERE id = ?').run(displayName, Date.now(), userId);
  }

  deleteUser(userId: string): void {
    this.db.prepare('DELETE FROM users WHERE id = ?').run(userId);
  }

  /** Removes every record and blob row and resets the change cursor (email reset). */
  wipeUserData(userId: string): void {
    this.db.prepare('DELETE FROM records WHERE user_id = ?').run(userId);
    this.db.prepare('DELETE FROM blobs WHERE user_id = ?').run(userId);
    this.db
      .prepare('UPDATE users SET seq = 0, min_seq = 0, blob_bytes = 0, record_bytes = 0, updated_at = ? WHERE id = ?')
      .run(Date.now(), userId);
  }

  publicUser(u: UserRow): PublicUser {
    return {
      id: u.id,
      email: u.email,
      displayName: u.displayName,
      createdAt: u.createdAt,
      storage: {
        usedBytes: u.blobBytes + u.recordBytes,
        quotaBytes: this.config.quotaBytes,
        recordBytes: u.recordBytes,
        blobBytes: u.blobBytes,
      },
    };
  }

  publicKdf(u: UserRow): PublicKdf {
    return { algorithm: 'pbkdf2-sha256', iterations: u.kdfIterations, salt: u.kdfSalt.toString('base64') };
  }

  // ----- sessions ------------------------------------------------------------

  createSession(userId: string, device: DeviceInput, ip: string | null): { session: SessionRow; refreshToken: string } {
    const id = newId();
    const refreshToken = randomToken(32);
    const now = Date.now();
    this.db
      .prepare(
        `INSERT INTO sessions (id, user_id, refresh_hash, device_name, platform, created_at, last_seen_at, ip)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(id, userId, sha256(refreshToken), device.name, device.platform, now, now, ip);
    return { session: this.sessionById(id)!, refreshToken };
  }

  sessionById(id: string): SessionRow | null {
    const r = this.db.prepare('SELECT * FROM sessions WHERE id = ?').get(id) as Row | undefined;
    return r ? toSession(r) : null;
  }

  sessionByRefreshHash(hash: Buffer): SessionRow | null {
    const r = this.db.prepare('SELECT * FROM sessions WHERE refresh_hash = ?').get(hash) as Row | undefined;
    return r ? toSession(r) : null;
  }

  sessionByPrevRefreshHash(hash: Buffer): SessionRow | null {
    const r = this.db.prepare('SELECT * FROM sessions WHERE prev_refresh_hash = ?').get(hash) as Row | undefined;
    return r ? toSession(r) : null;
  }

  /** Replaces the session's refresh token; the old one is kept as `prev` for reuse detection. */
  rotateRefresh(session: SessionRow, ip: string | null): string {
    const refreshToken = randomToken(32);
    const now = Date.now();
    this.db
      .prepare(
        `UPDATE sessions SET prev_refresh_hash = refresh_hash, refresh_hash = ?, rotated_at = ?, last_seen_at = ?,
           ip = COALESCE(?, ip) WHERE id = ?`,
      )
      .run(sha256(refreshToken), now, now, ip, session.id);
    return refreshToken;
  }

  /** Issues a new current refresh token without changing `prev` (benign retry inside the grace window). */
  reissueRefresh(session: SessionRow, ip: string | null): string {
    const refreshToken = randomToken(32);
    const now = Date.now();
    this.db
      .prepare(`UPDATE sessions SET refresh_hash = ?, last_seen_at = ?, ip = COALESCE(?, ip) WHERE id = ?`)
      .run(sha256(refreshToken), now, ip, session.id);
    return refreshToken;
  }

  touchSession(sessionId: string, ip: string | null): void {
    this.db.prepare('UPDATE sessions SET last_seen_at = ?, ip = COALESCE(?, ip) WHERE id = ?').run(Date.now(), ip, sessionId);
  }

  revokeSession(sessionId: string): void {
    this.db.prepare('UPDATE sessions SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL').run(Date.now(), sessionId);
  }

  revokeAllSessions(userId: string, exceptSessionId?: string): void {
    if (exceptSessionId) {
      this.db
        .prepare('UPDATE sessions SET revoked_at = ? WHERE user_id = ? AND id != ? AND revoked_at IS NULL')
        .run(Date.now(), userId, exceptSessionId);
    } else {
      this.db.prepare('UPDATE sessions SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL').run(Date.now(), userId);
    }
  }

  activeSessions(userId: string): SessionRow[] {
    const cutoff = Date.now() - this.config.sessionIdleTtlMs;
    const rows = this.db
      .prepare(
        `SELECT * FROM sessions WHERE user_id = ? AND revoked_at IS NULL AND last_seen_at > ?
         ORDER BY last_seen_at DESC`,
      )
      .all(userId, cutoff) as Row[];
    return rows.map(toSession);
  }

  isSessionLive(s: SessionRow): boolean {
    return s.revokedAt === null && s.lastSeenAt > Date.now() - this.config.sessionIdleTtlMs;
  }

  // ----- one-time tokens -----------------------------------------------------

  createResetToken(userId: string, kind: 'recovery', ttlMs: number): string {
    const token = randomToken(32);
    this.db
      .prepare('INSERT INTO reset_tokens (token_hash, user_id, kind, expires_at) VALUES (?, ?, ?, ?)')
      .run(sha256(token), userId, kind, Date.now() + ttlMs);
    return token;
  }

  /** Atomically marks a token used and returns its user id, or null if invalid/expired/used. */
  consumeResetToken(token: string, kind: 'recovery'): string | null {
    const hash = sha256(token);
    return transaction(this.db, () => {
      const r = this.db
        .prepare('SELECT user_id, expires_at, used_at, kind FROM reset_tokens WHERE token_hash = ?')
        .get(hash) as Row | undefined;
      if (!r || r.kind !== kind || r.used_at != null || (r.expires_at as number) < Date.now()) return null;
      this.db.prepare('UPDATE reset_tokens SET used_at = ? WHERE token_hash = ?').run(Date.now(), hash);
      return r.user_id as string;
    });
  }

  setEmailCode(userId: string, codeHash: Buffer, ttlMs: number): void {
    this.db
      .prepare(
        `INSERT INTO email_codes (user_id, code_hash, expires_at, attempts) VALUES (?, ?, ?, 0)
         ON CONFLICT(user_id) DO UPDATE SET code_hash = excluded.code_hash, expires_at = excluded.expires_at, attempts = 0`,
      )
      .run(userId, codeHash, Date.now() + ttlMs);
  }

  emailCode(userId: string): { codeHash: Buffer; expiresAt: number; attempts: number } | null {
    const r = this.db.prepare('SELECT * FROM email_codes WHERE user_id = ?').get(userId) as Row | undefined;
    if (!r) return null;
    return { codeHash: buf(r.code_hash), expiresAt: r.expires_at as number, attempts: r.attempts as number };
  }

  bumpEmailCodeAttempts(userId: string): number {
    this.db.prepare('UPDATE email_codes SET attempts = attempts + 1 WHERE user_id = ?').run(userId);
    return this.emailCode(userId)?.attempts ?? 0;
  }

  deleteEmailCode(userId: string): void {
    this.db.prepare('DELETE FROM email_codes WHERE user_id = ?').run(userId);
  }

  // ----- housekeeping --------------------------------------------------------

  /** Deletes expired sessions/tokens and purges old tombstones. Returns counts for logging. */
  housekeeping(): { sessions: number; tokens: number; tombstones: number } {
    const now = Date.now();
    const sessions = this.db
      .prepare('DELETE FROM sessions WHERE (revoked_at IS NOT NULL AND revoked_at < ?) OR last_seen_at < ?')
      .run(now - 7 * 24 * 60 * 60 * 1000, now - this.config.sessionIdleTtlMs).changes as number;
    const tokens =
      (this.db.prepare('DELETE FROM reset_tokens WHERE expires_at < ?').run(now - 24 * 60 * 60 * 1000).changes as number) +
      (this.db.prepare('DELETE FROM email_codes WHERE expires_at < ?').run(now).changes as number);

    const cutoff = now - this.config.tombstoneRetentionMs;
    const tombstones = transaction(this.db, () => {
      const horizon = this.db
        .prepare('SELECT user_id, MAX(seq) AS max_seq FROM records WHERE deleted = 1 AND server_time < ? GROUP BY user_id')
        .all(cutoff) as Row[];
      for (const h of horizon) {
        this.db
          .prepare('UPDATE users SET min_seq = MAX(min_seq, ?) WHERE id = ?')
          .run(h.max_seq as number, h.user_id as string);
      }
      // Purged tombstones no longer count toward storage.
      const freed = this.db
        .prepare('SELECT user_id, SUM(size) + COUNT(*) * ? AS bytes FROM records WHERE deleted = 1 AND server_time < ? GROUP BY user_id')
        .all(RECORD_OVERHEAD_BYTES, cutoff) as Row[];
      for (const f of freed) {
        this.db
          .prepare('UPDATE users SET record_bytes = MAX(0, record_bytes - ?) WHERE id = ?')
          .run(f.bytes as number, f.user_id as string);
      }
      return this.db.prepare('DELETE FROM records WHERE deleted = 1 AND server_time < ?').run(cutoff).changes as number;
    });
    return { sessions, tokens, tombstones };
  }
}
