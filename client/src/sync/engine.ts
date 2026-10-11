/**
 * Offline-first, end-to-end encrypted sync (port of SyncEngine.kt; docs/API.md "Sync"). Local rows
 * carry a dirty flag; pushes are last-writer-wins on updatedAt; pulls follow the server's change
 * cursor. While the app is open, a Server-Sent Events stream triggers a pull whenever another
 * device pushes. Open tabs coordinate with Web Locks: one sync at a time, and one tab (the leader)
 * keeps the change stream open; the others see its changes through the shared database.
 */
import { compressible, decryptBlob, DecryptionError, encryptBlob } from '../core/crypto';
import { readSse } from '../core/sse';
import type { AttachmentStore } from '../data/attachments';
import { db } from '../data/db';
import type { AttachmentEntity, MessageEntity } from '../data/entities';
import type { SettingsStore, SyncedPrefs } from '../data/prefs';
import { platform } from '../platform';
import { ApiError, NetworkError, SyncApi, type RecordDto } from './api';
import { AuthError, type AuthManager, type SignedIn } from './auth';
import { RecordCodec, RecordType, type OpenedRecord } from './codec';

export type SyncPhase = 'OFF' | 'IDLE' | 'SYNCING' | 'OFFLINE' | 'ERROR' | 'PAUSED';

export interface SyncState {
  phase: SyncPhase;
  lastSyncAt: number;
  message?: string | null;
  /** The account's sync storage is full: some changes and files are waiting on this device. */
  storageFull: boolean;
}

/** An automatic clean-up: [files] old files ([bytes]) left sync storage and stayed on the devices that had them. */
export interface AutoFreed {
  at: number;
  files: number;
  bytes: number;
}

const LIMIT = 200;
const PAGE = 500;
const MAX_ROUNDS = 25;
/** Usage checks with the server per sync while storage is tight. */
const MAX_ROOM_CHECKS = 6;
/** The server counts each record's ciphertext plus this much. */
const RECORD_OVERHEAD = 64;
const EAGER_DOWNLOAD_MAX = 6 * 1024 * 1024;
/** The sync server rejects encrypted blobs over 32 MiB; leave headroom for encryption overhead. */
export const MAX_SYNC_BLOB_BYTES = 31 * 1024 * 1024;
const STORAGE_FULL =
  'Your sync storage is full. New changes and files are kept on this device until you free up space in Settings → Data and storage.';

const K_CURSOR = 'sync_cursor';
const K_LAST = 'sync_last';
const K_FREED = 'sync_auto_freed';

interface Pending {
  record: RecordDto;
  onAccepted: () => Promise<void>;
}

type Upload = 'DONE' | 'FULL' | 'FAILED';

async function withLock<T>(name: string, fn: () => Promise<T>): Promise<T> {
  const locks = (globalThis.navigator as Navigator | undefined)?.locks;
  if (locks?.request) return locks.request(name, fn) as Promise<T>;
  return fn();
}

const isOffline = (e: unknown) => e instanceof NetworkError || e instanceof TypeError;

export class SyncEngine {
  private stateValue: SyncState = { phase: 'OFF', lastSyncAt: 0, storageFull: false };
  private listeners = new Set<() => void>();
  private debounce: ReturnType<typeof setTimeout> | null = null;
  private running: Promise<boolean> | null = null;
  private rerun = false;
  private streamAbort: AbortController | null = null;
  private storageFull = false;
  private uploadedBytes = 0;
  private roomChecks = 0;
  private lastAccountRefresh = 0;
  private autoFreedValue: AutoFreed | null = null;
  private started = false;
  /** Gets every change-stream event (ready, presence, relay…) of the window that holds the stream. */
  onStreamEvent: ((event: string, data: string) => void) | null = null;

  constructor(
    private readonly auth: AuthManager,
    private readonly settings: SettingsStore,
    private readonly attachments: AttachmentStore,
    private readonly api = new SyncApi((i, init) => platform().fetch(i, init)),
  ) {}

  get state(): SyncState {
    return this.stateValue;
  }

  /** The last automatic clean-up this device did, if any. */
  get autoFreed(): AutoFreed | null {
    return this.autoFreedValue;
  }

  subscribe = (l: () => void): (() => void) => {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  };

  private setState(s: Partial<SyncState>) {
    this.stateValue = { ...this.stateValue, ...s };
    for (const l of this.listeners) l();
  }

  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;
    this.stateValue.lastSyncAt = await db().getKv<number>(K_LAST, 0);
    this.autoFreedValue = await db().getKv<AutoFreed | null>(K_FREED, null);
    const onAccount = () => {
      const s = this.auth.state;
      if (s.kind === 'signedIn') {
        if (this.stateValue.phase === 'OFF' || this.stateValue.phase === 'PAUSED') this.setState({ phase: 'IDLE', message: null });
        this.requestSync(0);
        this.startStream();
      } else {
        this.stopStream();
        if (s.kind === 'guest') this.setState({ phase: 'OFF', message: null, storageFull: false });
        else this.setState({ phase: 'PAUSED', message: 'Sign in again to resume sync.' });
      }
    };
    this.auth.subscribe(onAccount);
    onAccount();
    if (typeof window !== 'undefined') {
      window.addEventListener('online', () => {
        this.requestSync(500);
        this.restartStream();
      });
      document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible') this.requestSync(0);
      });
      // A fallback in case the change stream silently stalls.
      setInterval(() => this.requestSync(0), 5 * 60_000);
    }
  }

  /** Debounced sync request after local edits. */
  requestSync(delayMs = 1500): void {
    if (!this.auth.isSignedIn) return;
    if (this.debounce) clearTimeout(this.debounce);
    this.debounce = setTimeout(() => {
      this.debounce = null;
      void this.syncNow();
    }, delayMs);
  }

  /** Runs a sync now (or queues one right after the sync in progress). Resolves true on success. */
  syncNow(): Promise<boolean> {
    if (this.running) {
      this.rerun = true;
      return this.running;
    }
    this.running = (async () => {
      try {
        let ok = await withLock('facet-sync', () => this.syncOnce());
        while (this.rerun) {
          this.rerun = false;
          ok = await withLock('facet-sync', () => this.syncOnce());
        }
        return ok;
      } finally {
        this.running = null;
      }
    })();
    return this.running;
  }

  private async syncOnce(): Promise<boolean> {
    if (!this.auth.isSignedIn) return false;
    const vault = await this.auth.vault();
    if (!vault) return false;
    const codec = new RecordCodec(vault, platform().secrets);
    this.setState({ phase: 'SYNCING', message: null });
    this.storageFull = false;
    this.uploadedBytes = 0;
    this.roomChecks = 0;
    try {
      await this.push(codec);
      await this.pull(codec);
      await this.purge(codec);
      await this.downloadPending(codec);
      // Keep the storage meter current after uploads, and whenever space is tight.
      if (this.storageFull || this.uploadedBytes > 0 || Date.now() - this.lastAccountRefresh > 10 * 60_000) {
        await this.auth.refreshAccount().catch(() => {});
        this.lastAccountRefresh = Date.now();
      }
      const now = Date.now();
      await db().setKv(K_LAST, now);
      this.setState({ phase: 'IDLE', lastSyncAt: now, message: this.storageFull ? STORAGE_FULL : null, storageFull: this.storageFull });
      return true;
    } catch (e) {
      if (e instanceof AuthError) {
        this.setState({ phase: this.auth.isSignedIn ? 'ERROR' : 'PAUSED', message: e.message });
      } else if (e instanceof ApiError) {
        this.setState({ phase: 'ERROR', message: e.message });
      } else if (isOffline(e)) {
        this.setState({ phase: 'OFFLINE', message: 'Offline. Changes will sync when you’re back online.' });
      } else {
        console.warn('sync failed', e);
        this.setState({ phase: 'ERROR', message: 'Sync failed. It will retry automatically.' });
      }
      return false;
    }
  }

  // ---- push ----

  private async push(codec: RecordCodec): Promise<void> {
    // Clean up as storage fills, so devices that hold none of the old files can keep syncing too.
    if (this.settings.synced.autoFreeSpace) {
      const a = this.account();
      if (a && a.quotaBytes > 0) await this.ensureRoom(codec, a.quotaBytes / 50, Number.MAX_SAFE_INTEGER, false);
    }
    await this.retryWaitingFiles(codec);
    for (let round = 0; round < MAX_ROUNDS; round++) {
      const batch = await this.collectDirty(codec);
      if (batch.length === 0) return;
      let refusedForSpace = false;
      for (const chunk of chunked(batch)) {
        const res = await this.auth.authed((base, token) => this.api.push(base, token, chunk.map((p) => p.record)));
        const byKey = new Map(chunk.map((p) => [p.record.type + '/' + p.record.id, p]));
        for (const a of res.accepted) await byKey.get(a.type + '/' + a.id)?.onAccepted();
        const currents = res.rejected.map((r) => r.current).filter((c): c is RecordDto => !!c);
        if (currents.length) await this.applyRecords(codec, currents, true);
        // Refused for space: make room and send them next round, or keep them queued here until there's space.
        const refused = res.rejected.filter((r) => r.reason === 'quota');
        if (refused.length) {
          const need = refused.reduce((sum, r) => sum + Math.floor(((byKey.get(r.type + '/' + r.id)?.record.ct?.length ?? 0) * 3) / 4) + RECORD_OVERHEAD, 0);
          if (!(await this.ensureRoom(codec, need, Number.MAX_SAFE_INTEGER, true))) {
            this.storageFull = true;
            refusedForSpace = true;
          }
        }
      }
      if (refusedForSpace) return;
    }
  }

  private async collectDirty(codec: RecordCodec): Promise<Pending[]> {
    const out: Pending[] = [];
    const d = db();
    const markClean = (table: typeof d.conversations | typeof d.messages | any, id: string, updatedAt: number) =>
      table.where('id').equals(id).and((x: { updatedAt: number }) => x.updatedAt === updatedAt).modify({ dirty: 0 });

    if (this.settings.syncedDirty) {
      const s: SyncedPrefs = this.settings.synced;
      out.push({ record: await codec.encodeSettings(s), onAccepted: () => this.settings.markSyncedClean(s.updatedAt) });
    }
    for (const e of await d.providers.where('dirty').equals(1).limit(LIMIT).toArray()) {
      out.push({ record: await codec.encodeProvider(e), onAccepted: () => markClean(d.providers, e.id, e.updatedAt) });
    }
    for (const e of await d.folders.where('dirty').equals(1).limit(LIMIT).toArray()) {
      out.push({ record: await codec.encodeFolder(e), onAccepted: () => markClean(d.folders, e.id, e.updatedAt) });
    }
    for (const e of await d.prompts.where('dirty').equals(1).limit(LIMIT).toArray()) {
      out.push({ record: await codec.encodePrompt(e), onAccepted: () => markClean(d.prompts, e.id, e.updatedAt) });
    }
    for (const e of await d.assistants.where('dirty').equals(1).limit(LIMIT).toArray()) {
      out.push({ record: await codec.encodeAssistant(e), onAccepted: () => markClean(d.assistants, e.id, e.updatedAt) });
    }
    for (const e of await d.conversations.where('dirty').equals(1).limit(LIMIT).toArray()) {
      out.push({ record: await codec.encodeConversation(e), onAccepted: () => markClean(d.conversations, e.id, e.updatedAt) });
    }
    for (const e of await d.attachments.where('dirty').equals(1).limit(LIMIT).toArray()) {
      if (!e.conversationId && !e.deleted) continue; // unsent draft
      let current = e;
      if (!e.deleted && !e.uploaded && !e.localOnly) {
        const blob = await this.attachments.blob(e.id);
        if (!blob) continue;
        // Files over the server's blob limit stay on this device; only their record syncs.
        if (blob.size <= MAX_SYNC_BLOB_BYTES) {
          const blobId = await codec.blobId(e.id);
          let sealed: Uint8Array;
          try {
            sealed = await encryptBlob((await this.auth.vault())!.aes, blobId, new Uint8Array(await blob.arrayBuffer()), { compressible: compressible(e.mimeType) });
          } catch {
            continue;
          }
          const size = sealed.length;
          // When storage looks full, make room first (by clearing older files) rather than send a doomed upload.
          const roomy = await this.ensureRoom(codec, size, e.createdAt, false);
          let result: Upload = roomy ? await this.putBlob(blobId, sealed) : 'FULL';
          if (result === 'FULL' && roomy && (await this.ensureRoom(codec, size, e.createdAt, true))) result = await this.putBlob(blobId, sealed);
          if (result === 'DONE') {
            this.uploadedBytes += size;
            await d.attachments.update(e.id, { uploaded: true });
            current = { ...e, uploaded: true };
          } else if (result === 'FULL') {
            // Sync storage is full: the file waits here, its record syncs, and it uploads once there's room.
            this.storageFull = true;
          } else {
            // e.g. a network blip: retry next sync without holding up everything else.
            continue;
          }
        }
      }
      out.push({ record: await codec.encodeAttachment(current), onAccepted: () => markClean(d.attachments, e.id, e.updatedAt) });
    }
    for (const e of await d.mcpServers.where('dirty').equals(1).limit(LIMIT).toArray()) {
      // Local command servers belong to this computer and never sync.
      if (e.stdio) continue;
      out.push({ record: await codec.encodeMcp(e), onAccepted: () => markClean(d.mcpServers, e.id, e.updatedAt) });
    }
    for (const e of await d.skills.where('dirty').equals(1).limit(LIMIT).toArray()) {
      out.push({ record: await codec.encodeSkill(e), onAccepted: () => markClean(d.skills, e.id, e.updatedAt) });
    }
    const messages = await d.messages.where('dirty').equals(1).filter((m) => m.status !== 'STREAMING').limit(LIMIT * 2).toArray();
    for (const e of messages) {
      out.push({ record: await codec.encodeMessage(e), onAccepted: () => markClean(d.messages, e.id, e.updatedAt) });
    }
    return out;
  }

  // ---- pull ----

  private async pull(codec: RecordCodec): Promise<void> {
    let since = await db().getKv<number>(K_CURSOR, 0);
    let seen: Map<string, Set<string>> | null = null;
    for (let rounds = 0; rounds < 10_000; rounds++) {
      const res = await this.auth.authed((base, token) => this.api.pull(base, token, since, PAGE));
      if (res.reset) {
        since = 0;
        await db().setKv(K_CURSOR, 0);
        seen = new Map();
        continue;
      }
      const opened = await this.applyRecords(codec, res.records, false);
      if (seen) for (const r of opened) {
        if (!seen.has(r.type)) seen.set(r.type, new Set());
        seen.get(r.type)!.add(r.id);
      }
      since = res.cursor;
      await db().setKv(K_CURSOR, since);
      if (!res.hasMore) break;
    }
    if (seen) await this.deleteUnseen(seen);
  }

  /**
   * Decrypts and applies pulled records (last writer wins). Crypto runs first: IndexedDB
   * transactions can't wait on Web Crypto. Returns the records that could be opened.
   */
  private async applyRecords(codec: RecordCodec, raws: RecordDto[], force: boolean): Promise<OpenedRecord[]> {
    const opened: OpenedRecord[] = [];
    const sealed = new Map<string, any>();
    for (const raw of raws) {
      try {
        const r = await codec.open(raw);
        if (!r) continue;
        opened.push(r);
        if (!r.deleted && r.type === RecordType.PROVIDER) sealed.set(r.type + r.id, await codec.providerSecrets(r));
        if (!r.deleted && r.type === RecordType.MCP) sealed.set(r.type + r.id, await codec.mcpSecrets(r));
      } catch (e) {
        if (e instanceof DecryptionError || e instanceof SyntaxError) console.warn('skipping unreadable record');
        else throw e;
      }
    }
    if (opened.length === 0) return opened;
    const d = db();
    let settingsRecord: OpenedRecord | null = null;
    const deletedFiles: string[] = [];
    await d.transaction('rw', [d.conversations, d.messages, d.attachments, d.files, d.assistants, d.folders, d.prompts, d.providers, d.mcpServers, d.skills], async () => {
      for (const r of opened) {
        try {
          switch (r.type) {
            case RecordType.CONVERSATION: {
              const local = await d.conversations.get(r.id);
              if (!force && local?.dirty && local.updatedAt > r.updatedAt) break;
              if (r.deleted) {
                await d.conversations.delete(r.id);
                await d.messages.where('conversationId').equals(r.id).delete();
              } else await d.conversations.put(codec.conversation(r, local));
              break;
            }
            case RecordType.MESSAGE: {
              const local = await d.messages.get(r.id);
              if (local?.status === 'STREAMING') break;
              if (!force && local?.dirty && local.updatedAt > r.updatedAt) break;
              if (r.deleted) await d.messages.delete(r.id);
              else await d.messages.put(codec.message(r));
              break;
            }
            case RecordType.ATTACHMENT: {
              const local = await d.attachments.get(r.id);
              if (!force && local?.dirty && local.updatedAt > r.updatedAt) break;
              if (r.deleted) {
                if (local) {
                  await d.files.delete(r.id);
                  deletedFiles.push(r.id);
                }
                await d.attachments.delete(r.id);
              } else await d.attachments.put(codec.attachment(r, local));
              break;
            }
            case RecordType.ASSISTANT: {
              const local = await d.assistants.get(r.id);
              if (!force && local?.dirty && local.updatedAt > r.updatedAt) break;
              if (r.deleted) await d.assistants.delete(r.id);
              else await d.assistants.put(codec.assistant(r));
              break;
            }
            case RecordType.FOLDER: {
              const local = await d.folders.get(r.id);
              if (!force && local?.dirty && local.updatedAt > r.updatedAt) break;
              if (r.deleted) await d.folders.delete(r.id);
              else await d.folders.put(codec.folder(r));
              break;
            }
            case RecordType.PROMPT: {
              const local = await d.prompts.get(r.id);
              if (!force && local?.dirty && local.updatedAt > r.updatedAt) break;
              if (r.deleted) await d.prompts.delete(r.id);
              else await d.prompts.put(codec.prompt(r));
              break;
            }
            case RecordType.PROVIDER: {
              const local = await d.providers.get(r.id);
              if (!force && local?.dirty && local.updatedAt > r.updatedAt) break;
              if (r.deleted) await d.providers.delete(r.id);
              else await d.providers.put(codec.provider(r, local, sealed.get(r.type + r.id)));
              break;
            }
            case RecordType.MCP: {
              const local = await d.mcpServers.get(r.id);
              if (local?.stdio) break;
              if (!force && local?.dirty && local.updatedAt > r.updatedAt) break;
              if (r.deleted) await d.mcpServers.delete(r.id);
              else await d.mcpServers.put(codec.mcpServer(r, local, sealed.get(r.type + r.id)));
              break;
            }
            case RecordType.SKILL: {
              const local = await d.skills.get(r.id);
              if (!force && local?.dirty && local.updatedAt > r.updatedAt) break;
              if (r.deleted) await d.skills.delete(r.id);
              else await d.skills.put(codec.skill(r));
              break;
            }
            case RecordType.SETTINGS:
              if (!r.deleted) settingsRecord = r;
              break;
            default:
              // Unknown type from a newer client: ignore.
              break;
          }
        } catch (e) {
          if (!(e instanceof TypeError)) throw e;
          console.warn('skipping malformed record');
        }
      }
    });
    for (const id of deletedFiles) await this.attachments.deleteFile(id);
    if (settingsRecord) {
      const remote = codec.settings(settingsRecord);
      if (force || !this.settings.syncedDirty || remote.updatedAt >= this.settings.synced.updatedAt) {
        await this.settings.applyRemoteSynced(remote);
      }
    }
    return opened;
  }

  /** After a server reset, local clean rows the server no longer has are deleted. */
  private async deleteUnseen(seen: Map<string, Set<string>>): Promise<void> {
    const d = db();
    const gone = async (type: string, table: any): Promise<string[]> => {
      const clean: string[] = await table.where('dirty').equals(0).primaryKeys();
      const ids = seen.get(type) ?? new Set();
      return clean.filter((id) => !ids.has(id));
    };
    const convs = await gone(RecordType.CONVERSATION, d.conversations);
    const msgs = await gone(RecordType.MESSAGE, d.messages);
    const atts = await gone(RecordType.ATTACHMENT, d.attachments);
    const others: [any, string[]][] = [
      [d.assistants, await gone(RecordType.ASSISTANT, d.assistants)],
      [d.folders, await gone(RecordType.FOLDER, d.folders)],
      [d.prompts, await gone(RecordType.PROMPT, d.prompts)],
      [d.providers, await gone(RecordType.PROVIDER, d.providers)],
      [d.skills, await gone(RecordType.SKILL, d.skills)],
    ];
    const mcp = (await gone(RecordType.MCP, d.mcpServers)).filter(Boolean);
    const removedFiles: string[] = [];
    await d.transaction('rw', [d.conversations, d.messages, d.attachments, d.files, d.assistants, d.folders, d.prompts, d.providers, d.mcpServers, d.skills], async () => {
      for (const id of convs) {
        await d.conversations.delete(id);
        await d.messages.where('conversationId').equals(id).delete();
      }
      await d.messages.bulkDelete(msgs);
      for (const id of atts) {
        const a = await d.attachments.get(id);
        if (a?.uploaded) {
          await d.files.delete(id);
          await d.attachments.delete(id);
          removedFiles.push(id);
        }
      }
      for (const [table, ids] of others) await table.bulkDelete(ids);
      for (const id of mcp) {
        const m = await d.mcpServers.get(id);
        if (m && !m.stdio) await d.mcpServers.delete(id);
      }
    });
    for (const id of removedFiles) await this.attachments.deleteFile(id);
  }

  private async purge(codec: RecordCodec): Promise<void> {
    const d = db();
    for (const table of [d.mcpServers, d.skills, d.conversations, d.messages, d.assistants, d.folders, d.prompts, d.providers] as any[]) {
      await table.where('dirty').equals(0).filter((x: { deleted: number }) => x.deleted === 1).delete();
    }
    const purgeable = await d.attachments.where('dirty').equals(0).filter((a) => a.deleted === 1).toArray();
    for (const a of purgeable) {
      if (a.uploaded) {
        const blobId = await codec.blobId(a.id);
        await this.auth.authed((base, token) => this.api.deleteBlob(base, token, blobId)).catch(() => {});
      }
      await this.attachments.deleteFile(a.id);
      await d.attachments.delete(a.id);
    }
  }

  private async downloadPending(codec: RecordCodec): Promise<void> {
    const pending = await db().attachments
      .where('hasFile').equals(0)
      .filter((a) => a.deleted === 0 && a.uploaded && a.kind === 'image' && a.sizeBytes < EAGER_DOWNLOAD_MAX)
      .limit(20)
      .toArray();
    for (const a of pending) await this.download(codec, a).catch(() => {});
  }

  private async download(codec: RecordCodec, a: AttachmentEntity): Promise<void> {
    const vault = await this.auth.vault();
    if (!vault) return;
    const blobId = await codec.blobId(a.id);
    const blob = await this.auth.authed((base, token) => this.api.getBlob(base, token, blobId));
    await this.attachments.storeDownloaded(a, await decryptBlob(vault.aes, blobId, blob));
  }

  /** Downloads an attachment's file on demand. Returns false if it isn't available. */
  async ensureLocal(attachmentId: string): Promise<boolean> {
    const a = await db().attachments.get(attachmentId);
    if (!a) return false;
    if (a.hasFile && (await this.attachments.blob(a.id))) return true;
    if (!a.uploaded || !this.auth.isSignedIn) return false;
    const vault = await this.auth.vault();
    if (!vault) return false;
    try {
      await this.download(new RecordCodec(vault, platform().secrets), a);
      return true;
    } catch {
      return false;
    }
  }

  // ---- storage ----

  private async putBlob(blobId: string, blob: Uint8Array): Promise<Upload> {
    try {
      await this.auth.authed((base, token) => this.api.putBlob(base, token, blobId, blob));
      return 'DONE';
    } catch (e) {
      if (e instanceof ApiError) return e.code === 'quota_exceeded' ? 'FULL' : 'FAILED';
      if (e instanceof AuthError) throw e;
      return 'FAILED';
    }
  }

  private account(): SignedIn | null {
    const s = this.auth.state;
    return s.kind === 'signedIn' ? s : null;
  }

  /** Files in sync storage that this device also holds completely, oldest first. */
  private async inCloudOldestFirst(before: number): Promise<AttachmentEntity[]> {
    const rows = await db().attachments
      .where('createdAt').below(before)
      .filter((a) => a.deleted === 0 && a.uploaded && !a.localOnly && a.hasFile === 1 && !!a.conversationId)
      .toArray();
    rows.sort((x, y) => x.createdAt - y.createdAt || (x.id < y.id ? -1 : 1));
    const out: AttachmentEntity[] = [];
    for (const a of rows) if ((await this.attachments.blob(a.id))?.size === a.sizeBytes) out.push(a);
    return out;
  }

  /**
   * Whether [need] more bytes fit in sync storage ([fresh]: check with the server rather than
   * the last known usage). When they don't and automatic clean-up is on, removes the cloud copies
   * of the oldest files this device holds (created before [before]), plus some headroom so it
   * doesn't run on every change. Those files stay on this device, and on any device that
   * downloaded them. Nothing is removed unless that makes [need] fit.
   */
  private async ensureRoom(codec: RecordCodec, need: number, before: number, fresh: boolean): Promise<boolean> {
    // Bytes past the quota; null when the server sets no quota.
    const over = (): number | null => {
      const a = this.account();
      return a && a.quotaBytes > 0 ? a.usedBytes + need - a.quotaBytes : null;
    };
    if (!fresh && (over() ?? 0) <= 0) return true;
    if (this.roomChecks++ >= MAX_ROOM_CHECKS) return false;
    await this.auth.refreshAccount().catch(() => {});
    const excess = over() ?? 0;
    if (excess <= 0) return true;
    if (!this.settings.synced.autoFreeSpace) return false;
    const quota = this.account()?.quotaBytes;
    if (!quota) return false;
    // Only files whose complete copy is here: the cloud copy is the one going away.
    const candidates = await this.inCloudOldestFirst(before);
    if (candidates.reduce((sum, f) => sum + f.sizeBytes, 0) < excess) return false;
    const goal = excess + quota / 20;
    let freed = 0;
    let files = 0;
    for (const f of candidates) {
      if (freed >= goal) break;
      try {
        const blobId = await codec.blobId(f.id);
        await this.auth.authed((base, token) => this.api.deleteBlob(base, token, blobId));
      } catch {
        break;
      }
      await this.unsync(f.id);
      freed += f.sizeBytes;
      files++;
    }
    if (files === 0) return false;
    this.autoFreedValue = { at: Date.now(), files, bytes: freed };
    await db().setKv(K_FREED, this.autoFreedValue);
    this.setState({});
    let refreshed = true;
    await this.auth.refreshAccount().catch(() => {
      refreshed = false;
    });
    return (over() ?? 0) - (refreshed ? 0 : freed) <= 0;
  }

  /** Keeps a synced file on this device only: the record syncs again with uploaded = false. */
  private async unsync(id: string): Promise<void> {
    await db().attachments.update(id, { localOnly: true, uploaded: false, dirty: 1, updatedAt: Date.now() });
  }

  /** Files that waited because storage was full upload again, oldest first, once there's room for them. */
  private async retryWaitingFiles(codec: RecordCodec): Promise<void> {
    const waiting = await db().attachments
      .where('dirty').equals(0)
      .filter((a) => a.deleted === 0 && !a.uploaded && !a.localOnly && a.hasFile === 1 && !!a.conversationId && a.sizeBytes <= MAX_SYNC_BLOB_BYTES)
      .toArray();
    waiting.sort((x, y) => x.createdAt - y.createdAt || (x.id < y.id ? -1 : 1));
    let queued = 0;
    for (const f of waiting) {
      if (!(await this.ensureRoom(codec, queued + f.sizeBytes, f.createdAt, false))) {
        this.storageFull = true;
        return;
      }
      // A newer updatedAt, so its record wins over the synced "not uploaded" one.
      await db().attachments.update(f.id, { dirty: 1, updatedAt: Date.now() });
      queued += f.sizeBytes;
    }
  }

  /** Frees cloud space: deletes a file's encrypted copy from the server and keeps it on this device. */
  async keepOnDeviceOnly(attachmentId: string): Promise<void> {
    const a = await db().attachments.get(attachmentId);
    if (!a) return;
    const vault = await this.auth.vault();
    if (a.uploaded && vault && this.auth.isSignedIn) {
      const blobId = await new RecordCodec(vault, platform().secrets).blobId(a.id);
      await this.auth.authed((base, token) => this.api.deleteBlob(base, token, blobId));
    }
    await this.unsync(a.id);
    this.requestSync();
  }

  /** Tries to upload files that were kept on this device (after you freed space). */
  async retryDeviceOnlyFiles(): Promise<void> {
    const now = Date.now();
    await db().attachments.filter((a) => a.localOnly && a.deleted === 0).modify({ localOnly: false, dirty: 1, updatedAt: now });
    this.requestSync();
  }

  /** Frees space on this device: removes local copies of files that are safely on the server. */
  async clearDownloadedCopies(): Promise<number> {
    let freed = 0;
    const copies = await db().attachments.where('hasFile').equals(1).filter((a) => a.deleted === 0 && a.uploaded && !a.localOnly).toArray();
    for (const a of copies) {
      const blob = await this.attachments.blob(a.id);
      if (!blob) continue;
      freed += blob.size;
      await this.attachments.deleteFile(a.id);
      await db().attachments.update(a.id, { hasFile: 0 });
    }
    return freed;
  }

  // ---- account lifecycle ----

  /** Queues every local entity for upload (new account, or after an email reset). */
  async markEverythingDirty(): Promise<void> {
    const d = db();
    await d.transaction('rw', d.syncedTables, async () => {
      for (const table of d.syncedTables as any[]) await table.toCollection().modify({ dirty: 1 });
      await d.attachments.toCollection().modify({ uploaded: false });
    });
    await this.settings.markSyncedDirty();
    await db().setKv(K_CURSOR, 0);
  }

  /** Removes all synced content from this device (sign out with "remove data"). */
  async wipeLocalData(): Promise<void> {
    const d = db();
    await d.transaction('rw', [...d.syncedTables, d.files], async () => {
      for (const table of d.syncedTables as any[]) {
        if (table === d.mcpServers) await d.mcpServers.filter((m) => !m.stdio).delete();
        else await table.clear();
      }
    });
    await this.attachments.clearAll();
    await this.settings.resetSynced();
    await d.kv.bulkDelete([K_CURSOR, K_LAST, K_FREED]);
    this.autoFreedValue = null;
    this.setState({ lastSyncAt: 0, storageFull: false });
  }

  async resetCursor(): Promise<void> {
    await db().setKv(K_CURSOR, 0);
  }

  // ---- live updates ----

  private startStream() {
    if (this.streamAbort || typeof window === 'undefined') return;
    const abort = new AbortController();
    this.streamAbort = abort;
    // One tab per browser keeps the stream: whoever holds the lock until it closes or signs out.
    void withLock('facet-sse', () => this.runStream(abort.signal)).catch(() => {});
  }

  private stopStream() {
    this.streamAbort?.abort();
    this.streamAbort = null;
  }

  private restartStream() {
    if (!this.auth.isSignedIn) return;
    this.stopStream();
    this.startStream();
  }

  private async runStream(signal: AbortSignal): Promise<void> {
    let backoff = 1_000;
    while (!signal.aborted && this.auth.isSignedIn) {
      try {
        const token = await this.auth.authed(async (_base, t) => t);
        const res = await this.api.stream(this.auth.serverUrl, token, signal);
        if (res.status === 401) {
          // Refreshes the access token for the next attempt.
          await this.auth.refreshAccount().catch(() => {});
        } else if (res.ok && res.body) {
          backoff = 1_000;
          const cursor = await db().getKv<number>(K_CURSOR, 0);
          let known = cursor;
          for await (const ev of readSse(res.body, signal)) {
            try {
              this.onStreamEvent?.(ev.event, ev.data);
            } catch {
              // A listener's failure must not end the stream.
            }
            if (ev.event !== 'ready' && ev.event !== 'changed') continue;
            try {
              const remote = Number(JSON.parse(ev.data).cursor);
              known = await db().getKv<number>(K_CURSOR, known);
              if (Number.isFinite(remote) && remote !== known) this.requestSync(250);
            } catch {
              // Malformed event: ignore.
            }
          }
        }
      } catch (e) {
        if ((e as Error)?.name === 'AbortError') return;
        // Network drop or auth issue: retry with backoff.
      }
      if (signal.aborted || !this.auth.isSignedIn) return;
      await new Promise((r) => setTimeout(r, backoff));
      backoff = Math.min(backoff * 2, 60_000);
    }
  }
}

function chunked(batch: Pending[]): Pending[][] {
  const out: Pending[][] = [];
  let cur: Pending[] = [];
  let bytes = 0;
  for (const p of batch) {
    const size = (p.record.ct?.length ?? 0) + 200;
    if (cur.length && (cur.length >= 200 || bytes + size > 5_000_000)) {
      out.push(cur);
      cur = [];
      bytes = 0;
    }
    cur.push(p);
    bytes += size;
  }
  if (cur.length) out.push(cur);
  return out;
}

export type { MessageEntity };
