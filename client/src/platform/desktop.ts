/**
 * The Windows app: the renderer is this same web app, and Electron's preload script exposes
 * `window.facetDesktop` (desktop/src/preload.ts) for what a web page can't do: run commands,
 * read and edit files, start local MCP servers, keep secrets with Windows DPAPI, and update itself.
 * The window loads with web security relaxed for provider requests, so `fetch` isn't limited by CORS.
 */
import { b64, unb64 } from '../core/bytes';
import type { ComputerBridge, HostBridge, OAuthBridge, Platform, StdioBridge, UpdateBridge } from './platform';

/** The API the preload script exposes. Keep in sync with desktop/src/preload.ts. */
export interface DesktopApi {
  version: string;
  deviceName(): Promise<string>;
  /** Windows DPAPI (Electron safeStorage). Plaintext travels as base64. */
  secrets: { seal(plainB64: string): Promise<string>; open(sealed: string): Promise<string> };
  openExternal(url: string): void;
  /** Shows a save dialog; false when the user cancelled. */
  saveFile(name: string, bytes: Uint8Array): Promise<boolean>;
  notify(title: string, body: string): void;
  /** Called when the user clicks a notification (after the window is focused). */
  onNotificationClick(listener: () => void): () => void;
  /** AbortSignals can't cross the context bridge: `cancel` stops a sign-in that is waiting. */
  oauth: OAuthBridge & { cancel(): Promise<void> };
  computer: ComputerBridge;
  stdio: StdioBridge;
  updates: UpdateBridge;
  host: HostBridge;
}

declare global {
  interface Window {
    facetDesktop?: DesktopApi;
  }
}

export function createDesktopPlatform(api: DesktopApi): Platform {
  let clickHandler: (() => void) | undefined;
  api.onNotificationClick(() => clickHandler?.());
  return {
    kind: 'desktop',
    apiPlatform: 'windows',
    defaultServerUrl: 'https://facet.dtsoftware.io',
    deviceName: () => api.deviceName(),
    fetch: (input, init) => fetch(input, init),
    corsLimited: false,
    secrets: {
      seal: (plain) => api.secrets.seal(b64(plain)),
      open: async (sealed) => unb64(await api.secrets.open(sealed)),
    },
    openExternal: (url) => api.openExternal(url),
    async saveFile(name, data) {
      await api.saveFile(name, new Uint8Array(await data.arrayBuffer()));
    },
    notify(title, body, onClick) {
      clickHandler = onClick;
      api.notify(title, body);
    },
    oauth: {
      redirectUri: () => api.oauth.redirectUri(),
      async authorize(authUrl, redirectUri, signal) {
        const onAbort = () => void api.oauth.cancel();
        signal?.addEventListener('abort', onAbort, { once: true });
        try {
          return await api.oauth.authorize(authUrl, redirectUri);
        } finally {
          signal?.removeEventListener('abort', onAbort);
        }
      },
    },
    computer: api.computer,
    stdio: api.stdio,
    updates: api.updates,
    host: api.host,
    version: api.version,
  };
}
