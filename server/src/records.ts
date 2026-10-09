import { transaction, bufOrNull, type Db } from './db.js';
import { safeEqual } from './crypto.js';

export interface RecordIn {
  id: string;
  type: string;
  updatedAt: number;
  deleted: boolean;
  ct: Buffer | null;
}

export interface RecordOut {
  id: string;
  type: string;
  updatedAt: number;
  deleted: boolean;
  ct: string | null;
  seq: number;
}

export interface PushResult {
  accepted: { id: string; type: string; seq: number }[];
  rejected: { id: string; type: string; reason: 'stale'; current: RecordOut }[];
  cursor: number;
  changed: boolean;
}

export interface PullResult {
  records: RecordOut[];
  cursor: number;
  hasMore: boolean;
  reset?: true;
}

type Row = Record<string, unknown>;

function toOut(r: Row): RecordOut {
  const ct = bufOrNull(r.ct);
  return {
    id: r.id as string,
    type: r.type as string,
    updatedAt: r.updated_at as number,
    deleted: (r.deleted as number) === 1,
    ct: ct ? ct.toString('base64') : null,
    seq: r.seq as number,
  };
}

/** Encrypted record storage with last-writer-wins and a per-user change cursor. */
export class RecordStore {
  constructor(private readonly db: Db) {}

  push(userId: string, records: RecordIn[]): PushResult {
    return transaction(this.db, () => {
      const user = this.db.prepare('SELECT seq FROM users WHERE id = ?').get(userId) as { seq: number } | undefined;
      if (!user) throw new Error('user vanished during push');
      let seq = user.seq;
      const now = Date.now();
      const accepted: PushResult['accepted'] = [];
      const rejected: PushResult['rejected'] = [];

      const select = this.db.prepare('SELECT * FROM records WHERE user_id = ? AND type = ? AND id = ?');
      const insert = this.db.prepare(
        `INSERT INTO records (user_id, type, id, updated_at, deleted, ct, size, seq, server_time)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      const update = this.db.prepare(
        `UPDATE records SET updated_at = ?, deleted = ?, ct = ?, size = ?, seq = ?, server_time = ?
         WHERE user_id = ? AND type = ? AND id = ?`,
      );

      for (const r of records) {
        const existing = select.get(userId, r.type, r.id) as Row | undefined;
        const size = r.ct?.length ?? 0;
        if (!existing) {
          seq += 1;
          insert.run(userId, r.type, r.id, r.updatedAt, r.deleted ? 1 : 0, r.ct, size, seq, now);
          accepted.push({ id: r.id, type: r.type, seq });
          continue;
        }

        const storedUpdatedAt = existing.updated_at as number;
        const storedDeleted = (existing.deleted as number) === 1;
        const storedCt = bufOrNull(existing.ct);
        const sameCt = storedCt === null ? r.ct === null : r.ct !== null && safeEqual(storedCt, r.ct);
        if (storedUpdatedAt === r.updatedAt && storedDeleted === r.deleted && sameCt) {
          // Idempotent retry: nothing changes, report the existing seq.
          accepted.push({ id: r.id, type: r.type, seq: existing.seq as number });
          continue;
        }

        const newer = r.updatedAt > storedUpdatedAt;
        const tie = r.updatedAt === storedUpdatedAt;
        // A tombstone only yields to a strictly newer live write.
        const wins = storedDeleted && !r.deleted ? newer : newer || tie;
        if (!wins) {
          rejected.push({ id: r.id, type: r.type, reason: 'stale', current: toOut(existing) });
          continue;
        }
        seq += 1;
        update.run(r.updatedAt, r.deleted ? 1 : 0, r.ct, size, seq, now, userId, r.type, r.id);
        accepted.push({ id: r.id, type: r.type, seq });
      }

      if (seq !== user.seq) this.db.prepare('UPDATE users SET seq = ? WHERE id = ?').run(seq, userId);
      return { accepted, rejected, cursor: seq, changed: seq !== user.seq };
    });
  }

  pull(userId: string, since: number, limit: number): PullResult {
    const user = this.db.prepare('SELECT seq, min_seq FROM users WHERE id = ?').get(userId) as
      | { seq: number; min_seq: number }
      | undefined;
    if (!user) return { records: [], cursor: 0, hasMore: false, reset: true };
    if (since > user.seq || (since > 0 && since < user.min_seq)) {
      return { records: [], cursor: 0, hasMore: false, reset: true };
    }
    const rows = this.db
      .prepare('SELECT * FROM records WHERE user_id = ? AND seq > ? ORDER BY seq ASC LIMIT ?')
      .all(userId, since, limit + 1) as Row[];
    const hasMore = rows.length > limit;
    const page = (hasMore ? rows.slice(0, limit) : rows).map(toOut);
    const last = page[page.length - 1];
    return { records: page, cursor: last ? last.seq : since, hasMore };
  }

  cursor(userId: string): number {
    const row = this.db.prepare('SELECT seq FROM users WHERE id = ?').get(userId) as { seq: number } | undefined;
    return row?.seq ?? 0;
  }
}
