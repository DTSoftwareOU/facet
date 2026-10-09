/** React bindings for the app's stores. Database reads use Dexie live queries (they also follow other tabs). */
import { useLiveQuery } from 'dexie-react-hooks';
import { useEffect, useState, useSyncExternalStore } from 'react';
import { getApp } from '../app';
import { db } from '../data/db';
import type { LocalPrefs, SyncedPrefs } from '../data/prefs';
import type { LiveTurn } from '../domain/chat';
import type { AccountState } from '../sync/auth';
import type { AutoFreed, SyncState } from '../sync/engine';

export function useLocalPrefs(): LocalPrefs {
  const s = getApp().settings;
  return useSyncExternalStore(s.subscribe, () => s.local);
}

export function useSyncedPrefs(): SyncedPrefs {
  const s = getApp().settings;
  return useSyncExternalStore(s.subscribe, () => s.synced);
}

export function useAccount(): AccountState {
  const a = getApp().auth;
  return useSyncExternalStore(a.subscribe, () => a.state);
}

export function useSyncState(): SyncState {
  const s = getApp().sync;
  return useSyncExternalStore(s.subscribe, () => s.state);
}

export function useAutoFreed(): AutoFreed | null {
  const s = getApp().sync;
  return useSyncExternalStore(s.subscribe, () => s.autoFreed);
}

export function useLiveTurns(): ReadonlyMap<string, LiveTurn> {
  const c = getApp().chat;
  return useSyncExternalStore(c.subscribe, () => c.live);
}

export function useActiveChats(): ReadonlySet<string> {
  const c = getApp().chat;
  return useSyncExternalStore(c.subscribe, () => c.active);
}

/** Providers (not deleted), live. */
export function useProviders() {
  return useLiveQuery(async () => {
    const list = await db().providers.filter((p) => p.deleted === 0).toArray();
    return list.sort((a, b) => a.sort - b.sort || a.createdAt - b.createdAt);
  }, []);
}

/** The chat-model catalog for pickers, live. */
export function useCatalog() {
  const providers = useProviders();
  return providers ? getApp().providers.catalog(providers) : undefined;
}

export function useAssistants() {
  return useLiveQuery(() => getApp().assistants.all(), []);
}

export function useFolders() {
  return useLiveQuery(async () => {
    const list = await db().folders.filter((f) => f.deleted === 0).toArray();
    return list.sort((a, b) => a.sort - b.sort || a.createdAt - b.createdAt);
  }, []);
}

export function usePrompts() {
  return useLiveQuery(async () => {
    const list = await db().prompts.filter((p) => p.deleted === 0).toArray();
    return list.sort((a, b) => b.updatedAt - a.updatedAt);
  }, []);
}

/** An object URL for an attachment's file, downloading it from sync storage when needed. */
export function useAttachmentUrl(id: string | null | undefined, download = true): { url: string | null; missing: boolean } {
  const [state, setState] = useState<{ url: string | null; missing: boolean }>({ url: null, missing: false });
  const hasFile = useLiveQuery(async () => (id ? (await db().attachments.get(id))?.hasFile ?? 0 : 0), [id]);
  useEffect(() => {
    let cancelled = false;
    if (!id) return;
    void (async () => {
      const app = getApp();
      let url = await app.attachments.url(id);
      if (!url && download) {
        const ok = await app.sync.ensureLocal(id);
        if (ok) url = await app.attachments.url(id);
      }
      if (!cancelled) setState({ url, missing: !url });
    })();
    return () => {
      cancelled = true;
    };
  }, [id, hasFile, download]);
  return state;
}

/** Window width breakpoints. */
export function useNarrow(max = 900): boolean {
  const query = `(max-width: ${max}px)`;
  const [narrow, setNarrow] = useState(() => typeof matchMedia !== 'undefined' && matchMedia(query).matches);
  useEffect(() => {
    const mq = matchMedia(query);
    const on = () => setNarrow(mq.matches);
    mq.addEventListener('change', on);
    return () => mq.removeEventListener('change', on);
  }, [query]);
  return narrow;
}
