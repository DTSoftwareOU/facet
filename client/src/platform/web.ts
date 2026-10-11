/** The website: everything runs in the browser tab. */
import { b64, buf, concat, randomBytes, unb64 } from '../core/bytes';
import { db } from '../data/db';
import { t } from '../i18n';
import type { OAuthBridge, Platform, SecretBox } from './platform';

/**
 * Seals local secrets with a non-extractable AES-GCM key kept in IndexedDB (the browser
 * counterpart of the Android Keystore key): page scripts can use it but can't read it out.
 */
class WebSecretBox implements SecretBox {
  private key: Promise<CryptoKey> | null = null;

  private loadKey(): Promise<CryptoKey> {
    if (!this.key) {
      this.key = (async () => {
        const existing = await db().getKv<CryptoKey | null>('device_key', null);
        if (existing) return existing;
        const created = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
        await db().setKv('device_key', created);
        return created;
      })();
    }
    return this.key;
  }

  async seal(plain: Uint8Array): Promise<string> {
    const iv = randomBytes(12);
    const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: buf(iv) }, await this.loadKey(), buf(plain)));
    return 'v1:' + b64(concat(iv, ct));
  }

  async open(sealed: string): Promise<Uint8Array> {
    if (!sealed.startsWith('v1:')) throw new Error('Unknown sealed format');
    const data = unb64(sealed.slice(3));
    const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: buf(data.subarray(0, 12)) }, await this.loadKey(), buf(data.subarray(12)));
    return new Uint8Array(pt);
  }
}

/** MCP sign-in in a popup; public/oauth-callback.html posts the redirect URL back to this tab. */
const webOAuth: OAuthBridge = {
  async redirectUri() {
    return new URL('oauth-callback.html', document.baseURI).toString();
  },
  authorize(authUrl, redirectUri, signal) {
    return new Promise<string>((resolve, reject) => {
      const popup = window.open(authUrl, 'facet-oauth', 'width=520,height=720');
      if (!popup) {
        reject(new Error(t('The sign-in window was blocked. Allow pop-ups for this site and try again.')));
        return;
      }
      const origin = new URL(redirectUri).origin;
      const done = () => {
        window.removeEventListener('message', onMessage);
        clearInterval(timer);
        signal?.removeEventListener('abort', onAbort);
      };
      const onMessage = (e: MessageEvent) => {
        if (e.origin !== origin || e.data?.type !== 'facet-oauth' || typeof e.data.url !== 'string') return;
        done();
        resolve(e.data.url);
      };
      const onAbort = () => {
        done();
        popup.close();
        reject(new DOMException('Sign-in cancelled', 'AbortError'));
      };
      const timer = setInterval(() => {
        if (popup.closed) {
          done();
          reject(new Error(t('The sign-in window was closed before it finished.')));
        }
      }, 700);
      window.addEventListener('message', onMessage);
      signal?.addEventListener('abort', onAbort);
    });
  },
};

function browserName(): string {
  const ua = navigator.userAgent;
  const browser = /Edg\//.test(ua) ? 'Edge' : /OPR\//.test(ua) ? 'Opera' : /Firefox\//.test(ua) ? 'Firefox'
    : /Chrome\//.test(ua) ? 'Chrome' : /Safari\//.test(ua) ? 'Safari' : 'Browser';
  const os = /Windows/.test(ua) ? 'Windows' : /Android/.test(ua) ? 'Android' : /iPhone|iPad/.test(ua) ? 'iOS'
    : /Mac OS X/.test(ua) ? 'macOS' : /Linux/.test(ua) ? 'Linux' : '';
  return os ? `${browser} on ${os}` : browser;
}

export function createWebPlatform(version: string): Platform {
  const served = location.protocol === 'https:' || location.protocol === 'http:';
  return {
    kind: 'web',
    apiPlatform: 'web',
    // Served by the sync server's own host (or the dev server's proxy): same origin.
    defaultServerUrl: served ? location.origin : 'https://facet.dtsoftware.io',
    async deviceName() {
      return `Facet web · ${browserName()}`.slice(0, 80);
    },
    fetch: (input, init) => fetch(input, init),
    corsLimited: true,
    secrets: new WebSecretBox(),
    openExternal(url) {
      window.open(url, '_blank', 'noopener,noreferrer');
    },
    async saveFile(name, data) {
      const url = URL.createObjectURL(data);
      const a = document.createElement('a');
      a.href = url;
      a.download = name;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 30_000);
    },
    notify(title, body, onClick) {
      if (typeof Notification === 'undefined' || Notification.permission !== 'granted') return;
      const n = new Notification(title, { body, icon: new URL('icon-192.png', document.baseURI).toString() });
      n.onclick = () => {
        window.focus();
        onClick?.();
        n.close();
      };
    },
    oauth: webOAuth,
    version,
  };
}
