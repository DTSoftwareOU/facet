import { mkdirSync } from 'node:fs';
import { mkdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { transaction, type Db } from './db.js';
import { errors } from './errors.js';

const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const MIN_BLOB_BYTES = 1 + 12 + 16;

/** Encrypted attachment blobs on disk, with per-user quota accounting in SQLite. */
export class BlobStore {
  readonly root: string;

  constructor(
    private readonly db: Db,
    dataDir: string,
    private readonly quotaBytes: number,
    private readonly maxBlobBytes: number,
  ) {
    this.root = path.join(dataDir, 'blobs');
    mkdirSync(this.root, { recursive: true });
  }

  private userDir(userId: string): string {
    // userId is a server-generated UUID; blob ids are validated against ID_RE.
    return path.join(this.root, userId);
  }

  filePath(userId: string, id: string): string {
    if (!ID_RE.test(id)) throw errors.invalid('id: must be 1-64 chars of [A-Za-z0-9_-]');
    return path.join(this.userDir(userId), id);
  }

  async put(userId: string, id: string, data: Buffer): Promise<{ id: string; size: number }> {
    const target = this.filePath(userId, id);
    if (data.length > this.maxBlobBytes) throw errors.tooLarge(`Blob exceeds ${this.maxBlobBytes} bytes.`);
    // v1: 0x01 || nonce || ct.  v2: 0x02 || flags || nonce || ct (flags bit0 = DEFLATE before encryption).
    const v1 = data[0] === 0x01 && data.length >= MIN_BLOB_BYTES;
    const v2 = data[0] === 0x02 && data.length >= MIN_BLOB_BYTES + 1;
    if (!v1 && !v2) {
      throw errors.invalid('body: must be an encrypted blob envelope (version 0x01 or 0x02)');
    }
    await mkdir(this.userDir(userId), { recursive: true });
    const tmp = `${target}.${randomBytes(6).toString('hex')}.tmp`;
    await writeFile(tmp, data);
    try {
      transaction(this.db, () => {
        const existing = this.db.prepare('SELECT size FROM blobs WHERE user_id = ? AND id = ?').get(userId, id) as
          | { size: number }
          | undefined;
        const user = this.db.prepare('SELECT blob_bytes, record_bytes FROM users WHERE id = ?').get(userId) as
          | { blob_bytes: number; record_bytes: number }
          | undefined;
        if (!user) throw errors.unauthorized();
        const total = user.blob_bytes - (existing?.size ?? 0) + data.length;
        if (data.length > (existing?.size ?? 0) && total + user.record_bytes > this.quotaBytes) throw errors.quotaExceeded();
        this.db
          .prepare(
            `INSERT INTO blobs (user_id, id, size, created_at) VALUES (?, ?, ?, ?)
             ON CONFLICT(user_id, id) DO UPDATE SET size = excluded.size, created_at = excluded.created_at`,
          )
          .run(userId, id, data.length, Date.now());
        this.db.prepare('UPDATE users SET blob_bytes = ? WHERE id = ?').run(total, userId);
      });
    } catch (err) {
      await rm(tmp, { force: true });
      throw err;
    }
    await rename(tmp, target);
    return { id, size: data.length };
  }

  async locate(userId: string, id: string): Promise<{ path: string; size: number } | null> {
    const file = this.filePath(userId, id);
    const row = this.db.prepare('SELECT size FROM blobs WHERE user_id = ? AND id = ?').get(userId, id) as
      | { size: number }
      | undefined;
    if (!row) return null;
    try {
      const s = await stat(file);
      return { path: file, size: s.size };
    } catch {
      return null;
    }
  }

  async delete(userId: string, id: string): Promise<void> {
    const file = this.filePath(userId, id);
    transaction(this.db, () => {
      const row = this.db.prepare('SELECT size FROM blobs WHERE user_id = ? AND id = ?').get(userId, id) as
        | { size: number }
        | undefined;
      if (!row) return;
      this.db.prepare('DELETE FROM blobs WHERE user_id = ? AND id = ?').run(userId, id);
      this.db.prepare('UPDATE users SET blob_bytes = MAX(0, blob_bytes - ?) WHERE id = ?').run(row.size, userId);
    });
    await rm(file, { force: true });
  }

  /** Removes every blob file for a user (rows are removed by the caller / cascade). */
  async deleteAll(userId: string): Promise<void> {
    await rm(this.userDir(userId), { recursive: true, force: true });
  }
}
