/**
 * End-to-end sync between two simulated devices against a real local sync server
 * (start one with `PORT=8790 JWT_SECRET=… SERVER_SECRET=… node server/dist/index.js`; the test
 * is skipped when nothing answers). Each device has its own database; the test switches between
 * them, as the app code always reads the current database through db().
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { b64, fromUtf8, unb64, utf8 } from '../src/core/bytes';
import { newId } from '../src/core/ids';
import { AttachmentStore } from '../src/data/attachments';
import { ConversationRepository } from '../src/data/conversations';
import { FacetDb, setDb } from '../src/data/db';
import { SettingsStore } from '../src/data/prefs';
import { defaultParams } from '../src/llm/types';
import { setPlatform, type Platform } from '../src/platform';
import { AuthManager } from '../src/sync/auth';
import { SyncEngine } from '../src/sync/engine';

const SERVER = process.env.FACET_E2E_SERVER ?? 'http://127.0.0.1:8790';
const DATA_DIR = process.env.FACET_E2E_DATA_DIR;

const testPlatform: Platform = {
  kind: 'web',
  apiPlatform: 'web',
  defaultServerUrl: SERVER,
  deviceName: async () => 'Test browser',
  fetch: (i, init) => fetch(i, init),
  corsLimited: false,
  secrets: { seal: async (p) => 'v1:' + b64(p), open: async (s) => unb64(s.slice(3)) },
  openExternal: () => {},
  saveFile: async () => {},
  notify: () => {},
  oauth: { redirectUri: async () => '', authorize: async () => '' },
  version: 'test',
};

interface Device {
  db: FacetDb;
  settings: SettingsStore;
  auth: AuthManager;
  attachments: AttachmentStore;
  sync: SyncEngine;
  conversations: ConversationRepository;
}

async function device(name: string): Promise<Device> {
  const d = new FacetDb(`e2e-${name}-${Math.random()}`);
  setDb(d);
  const settings = new SettingsStore();
  await settings.load();
  const auth = new AuthManager();
  await auth.load();
  await auth.setServerUrl(SERVER);
  const attachments = new AttachmentStore();
  const sync = new SyncEngine(auth, settings, attachments);
  auth.onProfileName = (n) => void settings.updateSynced((s) => ({ ...s, profileName: n }));
  return { db: d, settings, auth, attachments, sync, conversations: new ConversationRepository() };
}

/** Runs [fn] as [dev]: points db() at its database first. */
async function as<T>(dev: Device, fn: () => Promise<T>): Promise<T> {
  setDb(dev.db);
  return fn();
}

let serverUp = false;

beforeAll(async () => {
  (globalThis as any).BroadcastChannel = undefined;
  setPlatform(testPlatform);
  serverUp = await fetch(`${SERVER}/v1/health`).then((r) => r.ok, () => false);
});

describe('sync end to end', () => {
  it('moves chats, keys, settings and files between devices, encrypted', async (ctx) => {
    if (!serverUp) ctx.skip();
    const email = `web-e2e-${newId()}@example.com`;
    const password = 'correct horse battery staple';
    const secretTitle = 'Secret plans for the lighthouse ' + newId();
    const secretText = 'The treasure is under the third stair ' + newId();
    const secretKey = 'sk-test-' + newId();

    const a = await device('a');
    const code = await as(a, () => a.auth.register(email, password, 'Ada'));
    expect(code).toMatch(/^[0-9A-Z]{4}(-[0-9A-Z]{4}){7}$/);

    // Device A creates a chat with a reply, a provider key, a file and a settings change.
    const convId = await as(a, async () => {
      const c = await a.conversations.create(null, 'p1', 'gpt-test', defaultParams({ effort: 'HIGH' }));
      await a.conversations.rename(c.id, secretTitle);
      const now = Date.now();
      await a.conversations.insertMessage({ id: newId(now), conversationId: c.id, parentId: null, role: 'user', content: secretText, status: 'DONE', createdAt: now, updatedAt: now, deleted: 0, dirty: 1 });
      await a.db.providers.put({
        id: 'p1', kind: 'openai', label: 'Work', baseUrl: 'https://api.openai.com/v1', apiKeySealed: await testPlatform.secrets.seal(utf8(secretKey)),
        headersJson: '{}', enabled: true, modelsJson: '[]', modelsFetchedAt: 0, favoritesJson: '[]', customModelsJson: '[]', capsOverridesJson: '{}',
        modelPrefsJson: '{}', sort: 0, createdAt: now, updatedAt: now, deleted: 0, dirty: 1,
      });
      await a.attachments.storeGenerated(utf8('notes about ' + secretText), 'text/plain', 'notes.txt', c.id);
      await a.settings.updateSynced((s) => ({ ...s, aboutMe: 'I like lighthouses', yoloMode: true }));
      expect(await a.sync.syncNow()).toBe(true);
      return c.id;
    });

    // Device B signs in and gets everything.
    const b = await device('b');
    await as(b, async () => {
      await b.auth.login(email, password);
      expect(await b.sync.syncNow()).toBe(true);
      const conv = await b.db.conversations.get(convId);
      expect(conv?.title).toBe(secretTitle);
      expect(JSON.parse(conv!.paramsJson).effort).toBe('HIGH');
      const msgs = await b.conversations.messages(convId);
      expect(msgs.map((m) => m.content)).toEqual([secretText]);
      const p = await b.db.providers.get('p1');
      expect(fromUtf8(await testPlatform.secrets.open(p!.apiKeySealed))).toBe(secretKey);
      expect(b.settings.synced.aboutMe).toBe('I like lighthouses');
      expect(b.settings.synced.yoloMode).toBe(true);
      expect(b.settings.synced.profileName).toBe('Ada');
      const att = (await b.db.attachments.where('conversationId').equals(convId).toArray())[0];
      expect(att.uploaded).toBe(true);
      expect(att.hasFile).toBe(0);
      expect(await b.sync.ensureLocal(att.id)).toBe(true);
      expect(fromUtf8((await b.attachments.bytes(att.id))!)).toBe('notes about ' + secretText);
      // B renames; A sees it.
      await b.conversations.rename(convId, 'Renamed on B');
      expect(await b.sync.syncNow()).toBe(true);
    });
    await as(a, async () => {
      expect(await a.sync.syncNow()).toBe(true);
      expect((await a.db.conversations.get(convId))?.title).toBe('Renamed on B');
      // A deletes the chat; B loses it.
      await a.conversations.delete(convId);
      expect(await a.sync.syncNow()).toBe(true);
    });
    await as(b, async () => {
      expect(await b.sync.syncNow()).toBe(true);
      expect(await b.db.conversations.get(convId)).toBeUndefined();
      expect(await b.conversations.messages(convId)).toEqual([]);
    });

    // The server stores nothing readable.
    if (DATA_DIR) {
      const files: string[] = [];
      const walk = (dir: string) => {
        for (const f of readdirSync(dir)) {
          const full = join(dir, f);
          if (statSync(full).isDirectory()) walk(full);
          else files.push(full);
        }
      };
      walk(DATA_DIR);
      for (const f of files) {
        const text = readFileSync(f).toString('latin1');
        for (const secret of [secretTitle, secretText, secretKey, 'lighthouses', 'notes about']) expect(text.includes(secret), `${secret} in ${f}`).toBe(false);
      }
    }
  });

  it('recovers with the recovery code and keeps data', async (ctx) => {
    if (!serverUp) ctx.skip();
    const email = `web-rec-${newId()}@example.com`;
    const a = await device('rec');
    const code = await as(a, () => a.auth.register(email, 'first password 1', null));
    await as(a, async () => {
      await a.settings.updateSynced((s) => ({ ...s, aboutMe: 'kept' }));
      expect(await a.sync.syncNow()).toBe(true);
    });
    const b = await device('rec-b');
    await as(b, async () => {
      const next = await b.auth.recoverWithCode(email, code.toLowerCase(), 'second password 2');
      expect(next).not.toBe(code);
      expect(await b.sync.syncNow()).toBe(true);
      expect(b.settings.synced.aboutMe).toBe('kept');
    });
    const c = await device('rec-c');
    await as(c, async () => {
      await expect(c.auth.login(email, 'first password 1')).rejects.toThrow();
      await c.auth.login(email, 'second password 2');
      expect(c.auth.isSignedIn).toBe(true);
    });
  });
});
