/**
 * Navigation: the open chat lives in the URL hash (#/c/<id>), so reloads and new windows keep
 * it; transient UI (settings, sidebar on small screens) lives in a tiny store.
 */
import { useSyncExternalStore } from 'react';

export type Route = { name: 'home'; folderId?: string | null; assistantId?: string | null } | { name: 'chat'; id: string } | { name: 'search' };

function parse(hash: string): Route {
  const h = hash.replace(/^#\/?/, '');
  const [first, second] = h.split('/');
  if (first === 'c' && second) return { name: 'chat', id: decodeURIComponent(second) };
  if (first === 'search') return { name: 'search' };
  if (first === 'new') {
    const params = new URLSearchParams(h.split('?')[1] ?? '');
    return { name: 'home', folderId: params.get('folder'), assistantId: params.get('assistant') };
  }
  return { name: 'home' };
}

let route: Route = typeof location !== 'undefined' ? parse(location.hash) : { name: 'home' };
const routeListeners = new Set<() => void>();

if (typeof window !== 'undefined') {
  window.addEventListener('hashchange', () => {
    route = parse(location.hash);
    for (const l of routeListeners) l();
  });
}

export function useRoute(): Route {
  return useSyncExternalStore(
    (l) => {
      routeListeners.add(l);
      return () => routeListeners.delete(l);
    },
    () => route,
  );
}

export function navigate(to: Route, replace = false): void {
  let hash = '#/';
  if (to.name === 'chat') hash = `#/c/${encodeURIComponent(to.id)}`;
  else if (to.name === 'search') hash = '#/search';
  else if (to.folderId || to.assistantId) {
    const q = new URLSearchParams();
    if (to.folderId) q.set('folder', to.folderId);
    if (to.assistantId) q.set('assistant', to.assistantId);
    hash = `#/new?${q}`;
  }
  if (location.hash === hash) return;
  if (replace) history.replaceState(null, '', hash);
  else history.pushState(null, '', hash);
  route = parse(hash);
  for (const l of routeListeners) l();
  ui.set({ drawer: false });
}

export function currentRoute(): Route {
  return route;
}

// ---- transient UI state ----

export type SettingsPage =
  | 'home' | 'account' | 'providers' | 'assistants' | 'prompts' | 'chat' | 'tools' | 'computer' | 'media'
  | 'appearance' | 'privacy' | 'data' | 'about';

interface UiState {
  /** Open settings page, or null when settings are closed. */
  settings: SettingsPage | null;
  /** A sub-page within a settings page (e.g. a provider id), when one is open. */
  settingsDetail: string | null;
  /** Sidebar shown as a drawer on small screens. */
  drawer: boolean;
  /** Sign-in / sign-up flow. */
  auth: 'signin' | 'signup' | 'recover' | null;
}

let state: UiState = { settings: null, settingsDetail: null, drawer: false, auth: null };
const listeners = new Set<() => void>();

export const ui = {
  get: () => state,
  set(patch: Partial<UiState>) {
    state = { ...state, ...patch };
    for (const l of listeners) l();
  },
  subscribe(l: () => void) {
    listeners.add(l);
    return () => listeners.delete(l);
  },
  openSettings(page: SettingsPage = 'home', detail: string | null = null) {
    ui.set({ settings: page, settingsDetail: detail, drawer: false });
  },
  closeSettings() {
    ui.set({ settings: null, settingsDetail: null });
  },
};

export function useUi(): UiState {
  return useSyncExternalStore(ui.subscribe, ui.get);
}
