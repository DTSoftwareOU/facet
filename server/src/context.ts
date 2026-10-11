import type { BlobStore } from './blobs.js';
import type { Config } from './config.js';
import type { Db } from './db.js';
import type { ChangeBus } from './events.js';
import type { Mailer } from './mail.js';
import type { RateLimiter } from './ratelimit.js';
import type { RecordStore } from './records.js';
import type { Store } from './store.js';

export interface OpenStream {
  userId: string;
  sessionId: string;
  /** Writes one SSE event to this stream. */
  send(event: string, data: unknown): void;
  close(): void;
}

export interface AppContext {
  config: Config;
  db: Db;
  store: Store;
  records: RecordStore;
  blobs: BlobStore;
  bus: ChangeBus;
  limiter: RateLimiter;
  mailer: Mailer | null;
  /** Live SSE connections, closed on shutdown or when their session/account goes away. */
  streams: Set<OpenStream>;
}

export function closeStreams(ctx: AppContext, predicate: (s: OpenStream) => boolean): void {
  for (const s of [...ctx.streams]) if (predicate(s)) s.close();
}
