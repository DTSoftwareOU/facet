/**
 * Owns the account session (port of AuthManager.kt): client-side key derivation
 * (docs/SECURITY.md), tokens, and the vault key. The password and the vault key never leave
 * this device in plaintext; tokens and the vault key are sealed with the platform SecretBox.
 * Open tabs share one session: refreshes are serialized with a Web Lock and re-read storage.
 */
import { b64, fromUtf8, unb64, utf8 } from '../core/bytes';
import {
  DEFAULT_ITERATIONS,
  DecryptionError,
  Vault,
  deriveFromPassword,
  deriveFromRecovery,
  formatRecoveryCode,
  generateRecoveryCode,
  parseRecoveryCode,
  unwrapVaultKey,
  wrapVaultKey,
} from '../core/crypto';
import { randomBytes } from '../core/bytes';
import { db } from '../data/db';
import { platform } from '../platform';
import { ApiError, NetworkError, SyncApi, type DeviceDto, type Kdf, type MetaDto, type RecoveryDto, type SessionDto, type TokensDto, type UserDto } from './api';

export type AccountState =
  /** Using Facet without an account; everything stays on this device. */
  | { kind: 'guest' }
  | {
      kind: 'signedIn';
      userId: string;
      email: string;
      displayName: string | null;
      serverUrl: string;
      usedBytes: number;
      quotaBytes: number;
      /** Of usedBytes: chats, settings and keys (records) vs. files (blobs). */
      recordBytes: number;
      blobBytes: number;
    }
  /** The session ended (revoked or expired). Local data is kept; sync is paused until sign-in. */
  | { kind: 'expired'; email: string; serverUrl: string };

export type SignedIn = Extract<AccountState, { kind: 'signedIn' }>;

/** The name to show: the encrypted profile name, else the server's display name, else the email's local part. */
export function shownName(a: SignedIn, profileName: string): string {
  return profileName.trim() || a.displayName || a.email.split('@')[0];
}

/** User-facing auth failure. */
export class AuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AuthError';
  }
}

interface StoredAccount {
  userId: string;
  email: string;
  displayName: string | null;
  usedBytes: number;
  quotaBytes: number;
  recordBytes: number;
  blobBytes: number;
  expired: boolean;
}

const K_ACCOUNT = 'account';
const K_SERVER = 'server_url';
const K_VAULT = 'vault';
const K_REFRESH = 'refresh';
const K_ACCESS = 'access';
const K_ACCESS_EXP = 'access_exp';
const K_SESSION = 'session_id';
const SECRET_KEYS = [K_VAULT, K_REFRESH, K_ACCESS, K_ACCESS_EXP, K_SESSION];

type Listener = (s: AccountState) => void;

async function withLock<T>(name: string, fn: () => Promise<T>): Promise<T> {
  const locks = (globalThis.navigator as Navigator | undefined)?.locks;
  if (locks?.request) return locks.request(name, fn) as Promise<T>;
  return fn();
}

export class AuthManager {
  private stateValue: AccountState = { kind: 'guest' };
  private server = '';
  private vaultCache: Promise<Vault | null> | null = null;
  private listeners = new Set<Listener>();
  private channel: BroadcastChannel | null = null;

  /** Called after sign-in/sign-up so the sync engine can start. Arg: true when local data should be uploaded. */
  onSignedIn: ((freshAccount: boolean) => void) | null = null;
  /** Stores the display name in end-to-end encrypted settings (never sent to the server in plaintext). */
  onProfileName: ((name: string) => void) | null = null;

  constructor(private readonly api = new SyncApi((i, init) => platform().fetch(i, init))) {
    if (typeof BroadcastChannel !== 'undefined') {
      this.channel = new BroadcastChannel('facet-auth');
      this.channel.onmessage = () => {
        this.vaultCache = null;
        void this.load();
      };
    }
  }

  /** Reads the stored session. Call once at startup. */
  async load(): Promise<void> {
    this.server = (await db().getKv<string>(K_SERVER, '')) || platform().defaultServerUrl;
    const acct = await db().getKv<StoredAccount | null>(K_ACCOUNT, null);
    let next: AccountState;
    if (!acct) next = { kind: 'guest' };
    else if (acct.expired) next = { kind: 'expired', email: acct.email, serverUrl: this.server };
    else next = { kind: 'signedIn', ...acct, serverUrl: this.server };
    this.setState(next);
  }

  get state(): AccountState {
    return this.stateValue;
  }

  get isSignedIn(): boolean {
    return this.stateValue.kind === 'signedIn';
  }

  get serverUrl(): string {
    return this.server || platform().defaultServerUrl;
  }

  subscribe = (l: Listener): (() => void) => {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  };

  private setState(s: AccountState) {
    this.stateValue = s;
    for (const l of this.listeners) l(s);
  }

  private broadcast() {
    this.channel?.postMessage('changed');
  }

  async setServerUrl(url: string): Promise<void> {
    const clean = url.trim().replace(/\/+$/, '') || platform().defaultServerUrl;
    this.server = clean;
    await db().setKv(K_SERVER, clean);
    this.broadcast();
  }

  /** The vault key, unsealed once per session. */
  vault(): Promise<Vault | null> {
    if (!this.vaultCache) {
      this.vaultCache = (async () => {
        const sealed = await db().getKv<string | null>(K_VAULT, null);
        if (!sealed) return null;
        try {
          return await Vault.open(await platform().secrets.open(sealed));
        } catch {
          return null;
        }
      })();
    }
    return this.vaultCache;
  }

  meta(url = this.serverUrl): Promise<MetaDto> {
    return this.api.meta(url);
  }

  // ---- Sign up / sign in ----

  /** Creates an account. Returns the recovery code the user must save. */
  async register(email: string, password: string, displayName: string | null): Promise<string> {
    const cleanEmail = email.trim().toLowerCase();
    const salt = randomBytes(16);
    const keys = await deriveFromPassword(password, salt, DEFAULT_ITERATIONS);
    const vaultKey = randomBytes(32);
    const recovery = generateRecoveryCode();
    const recKeys = await deriveFromRecovery(recovery);
    const res = await this.mapErrors(async () =>
      this.api.register(this.serverUrl, {
        email: cleanEmail,
        displayName: null,
        kdf: { algorithm: 'pbkdf2-sha256', iterations: DEFAULT_ITERATIONS, salt: b64(salt) },
        authHash: b64(keys.authHash),
        wrappedVaultKey: b64(await wrapVaultKey(keys.wrapKey, vaultKey)),
        recovery: { authHash: b64(recKeys.authHash), wrappedVaultKey: b64(await wrapVaultKey(recKeys.wrapKey, vaultKey, true)) },
        device: await this.device(),
      }),
    );
    await this.saveSession(res.user, res.tokens, vaultKey);
    const name = displayName?.trim();
    if (name) this.onProfileName?.(name);
    this.onSignedIn?.(true);
    return formatRecoveryCode(recovery);
  }

  async login(email: string, password: string): Promise<void> {
    const cleanEmail = email.trim().toLowerCase();
    const kdf = await this.mapErrors(() => this.api.prelogin(this.serverUrl, cleanEmail));
    const keys = await deriveFromPassword(password, unb64(kdf.salt), kdf.iterations);
    const res = await this.mapErrors(async () => this.api.login(this.serverUrl, { email: cleanEmail, authHash: b64(keys.authHash), device: await this.device() }));
    let vaultKey: Uint8Array;
    try {
      vaultKey = await unwrapVaultKey(keys.wrapKey, unb64(res.wrappedVaultKey));
    } catch {
      throw new AuthError('Your encryption key couldn’t be unlocked with this password.');
    }
    const previous = (await db().getKv<StoredAccount | null>(K_ACCOUNT, null))?.userId ?? null;
    await this.saveSession(res.user, res.tokens, vaultKey);
    this.onSignedIn?.(previous !== null && previous !== res.user.id);
  }

  // ---- Recovery ----

  /** Resets the password with a recovery code. Keeps all data. Returns the new recovery code. */
  async recoverWithCode(email: string, code: string, newPassword: string): Promise<string> {
    const cleanEmail = email.trim().toLowerCase();
    const codeBytes = parseRecoveryCode(code);
    if (!codeBytes) throw new AuthError('That recovery code isn’t valid. It has 32 letters and digits.');
    const recKeys = await deriveFromRecovery(codeBytes);
    const start = await this.mapErrors(() => this.api.recoverStart(this.serverUrl, cleanEmail, b64(recKeys.authHash)));
    let vaultKey: Uint8Array;
    try {
      vaultKey = await unwrapVaultKey(recKeys.wrapKey, unb64(start.recoveryWrappedVaultKey), true);
    } catch {
      throw new AuthError('That recovery code doesn’t match this account.');
    }
    const pm = await this.passwordMaterial(newPassword, vaultKey);
    const rm = await this.recoveryMaterial(vaultKey);
    const res = await this.mapErrors(async () =>
      this.api.recoverFinish(this.serverUrl, {
        resetToken: start.resetToken, kdf: pm.kdf, authHash: pm.authHash, wrappedVaultKey: pm.wrapped,
        recovery: rm.recovery, device: await this.device(),
      }),
    );
    await this.saveSession(res.user, res.tokens, vaultKey);
    this.onSignedIn?.(false);
    return rm.code;
  }

  async requestEmailReset(email: string): Promise<void> {
    await this.mapErrors(() => this.api.resetRequest(this.serverUrl, email.trim().toLowerCase()));
  }

  /**
   * Resets the password with an emailed code. The server deletes all encrypted data; this device
   * re-uploads what it has under a new vault key. Returns the new recovery code.
   */
  async confirmEmailReset(email: string, code: string, newPassword: string): Promise<string> {
    const vaultKey = randomBytes(32);
    const pm = await this.passwordMaterial(newPassword, vaultKey);
    const rm = await this.recoveryMaterial(vaultKey);
    const res = await this.mapErrors(async () =>
      this.api.resetConfirm(this.serverUrl, {
        email: email.trim().toLowerCase(), code: code.trim(), kdf: pm.kdf, authHash: pm.authHash,
        wrappedVaultKey: pm.wrapped, recovery: rm.recovery, device: await this.device(),
      }),
    );
    await this.saveSession(res.user, res.tokens, vaultKey);
    this.onSignedIn?.(true);
    return rm.code;
  }

  // ---- Account management ----

  async changePassword(current: string, newPassword: string): Promise<void> {
    const vault = await this.vault();
    if (!vault) throw new AuthError('Sign in again to change your password.');
    const currentHash = await this.currentAuthHash(current);
    const pm = await this.passwordMaterial(newPassword, vault.raw);
    const tokens = await this.authed((base, token) =>
      this.api.changePassword(base, token, { currentAuthHash: currentHash, kdf: pm.kdf, authHash: pm.authHash, wrappedVaultKey: pm.wrapped }),
    );
    await this.saveTokens(tokens);
  }

  /** Creates a new recovery code (the old one stops working). */
  async regenerateRecoveryCode(password: string): Promise<string> {
    const vault = await this.vault();
    if (!vault) throw new AuthError('Sign in again to create a recovery code.');
    const currentHash = await this.currentAuthHash(password);
    const rm = await this.recoveryMaterial(vault.raw);
    await this.authed((base, token) => this.api.setRecovery(base, token, currentHash, rm.recovery));
    return rm.code;
  }

  async deleteAccount(password: string): Promise<void> {
    const currentHash = await this.currentAuthHash(password);
    await this.authed((base, token) => this.api.deleteAccount(base, token, currentHash));
    await this.clearSession();
  }

  updateDisplayName(name: string | null): void {
    this.onProfileName?.(name?.trim() ?? '');
  }

  async refreshAccount(): Promise<void> {
    const user = await this.authed((base, token) => this.api.account(base, token));
    await this.saveUser(user);
  }

  sessions(): Promise<SessionDto[]> {
    return this.authed((base, token) => this.api.sessions(base, token));
  }

  revokeSession(id: string): Promise<void> {
    return this.authed((base, token) => this.api.revokeSession(base, token, id));
  }

  revokeOtherSessions(): Promise<void> {
    return this.authed((base, token) => this.api.revokeOtherSessions(base, token));
  }

  /** Signs out. The caller decides whether to wipe local data. */
  async logout(): Promise<void> {
    try {
      await this.authed((base, token) => this.api.logout(base, token));
    } catch {
      // Offline or already revoked: sign out locally anyway.
    }
    await this.clearSession();
  }

  async previousUserId(): Promise<string | null> {
    return (await db().getKv<StoredAccount | null>(K_ACCOUNT, null))?.userId ?? null;
  }

  // ---- Token handling ----

  /**
   * Runs [block] with a valid access token, refreshing it when needed and retrying once on 401.
   * Throws AuthError when the session has ended.
   */
  async authed<T>(block: (base: string, token: string) => Promise<T>): Promise<T> {
    const token = await this.accessToken(false);
    try {
      return await block(this.serverUrl, token);
    } catch (e) {
      if (e instanceof ApiError && e.status === 401 && e.code === 'unauthorized') {
        return block(this.serverUrl, await this.accessToken(true, token));
      }
      throw e;
    }
  }

  private async readSecret(key: string): Promise<string | null> {
    const sealed = await db().getKv<string | null>(key, null);
    if (!sealed) return null;
    try {
      return fromUtf8(await platform().secrets.open(sealed));
    } catch {
      return null;
    }
  }

  private accessToken(forceRefresh: boolean, rejected?: string): Promise<string> {
    return withLock('facet-auth-refresh', async () => {
      if (this.stateValue.kind !== 'signedIn') throw new AuthError('You’re not signed in.');
      const current = await this.readSecret(K_ACCESS);
      const expiresAt = await db().getKv<number>(K_ACCESS_EXP, 0);
      // Another tab may have refreshed while we waited for the lock: use its token.
      const fresh = current !== null && expiresAt - Date.now() > 60_000;
      if (fresh && (!forceRefresh || (rejected !== undefined && current !== rejected))) return current;
      const refresh = await this.readSecret(K_REFRESH);
      if (!refresh) {
        await this.markExpired();
        throw new AuthError('Your session ended. Sign in again to keep syncing.');
      }
      try {
        const tokens = await this.api.refresh(this.serverUrl, refresh);
        await this.saveTokens(tokens);
        return tokens.accessToken;
      } catch (e) {
        if (e instanceof ApiError && e.status === 401) {
          await this.markExpired();
          throw new AuthError('Your session ended. Sign in again to keep syncing.');
        }
        throw e;
      }
    });
  }

  // ---- helpers ----

  private async currentAuthHash(password: string): Promise<string> {
    const acct = await db().getKv<StoredAccount | null>(K_ACCOUNT, null);
    if (!acct) throw new AuthError('You’re not signed in.');
    const kdf = await this.mapErrors(() => this.api.prelogin(this.serverUrl, acct.email));
    const keys = await deriveFromPassword(password, unb64(kdf.salt), kdf.iterations);
    return b64(keys.authHash);
  }

  private async passwordMaterial(password: string, vaultKey: Uint8Array): Promise<{ kdf: Kdf; authHash: string; wrapped: string }> {
    const salt = randomBytes(16);
    const keys = await deriveFromPassword(password, salt, DEFAULT_ITERATIONS);
    return {
      kdf: { algorithm: 'pbkdf2-sha256', iterations: DEFAULT_ITERATIONS, salt: b64(salt) },
      authHash: b64(keys.authHash),
      wrapped: b64(await wrapVaultKey(keys.wrapKey, vaultKey)),
    };
  }

  private async recoveryMaterial(vaultKey: Uint8Array): Promise<{ code: string; recovery: RecoveryDto }> {
    const code = generateRecoveryCode();
    const keys = await deriveFromRecovery(code);
    return {
      code: formatRecoveryCode(code),
      recovery: { authHash: b64(keys.authHash), wrappedVaultKey: b64(await wrapVaultKey(keys.wrapKey, vaultKey, true)) },
    };
  }

  private async saveSession(user: UserDto, tokens: TokensDto, vaultKey: Uint8Array): Promise<void> {
    this.vaultCache = Vault.open(vaultKey);
    await db().setKv(K_VAULT, await platform().secrets.seal(vaultKey));
    await this.saveTokens(tokens);
    await this.saveUser(user, false);
  }

  private async saveTokens(tokens: TokensDto): Promise<void> {
    // Persist the refresh token before the access token is used (docs/API.md).
    const secrets = platform().secrets;
    const refresh = await secrets.seal(utf8(tokens.refreshToken));
    const access = await secrets.seal(utf8(tokens.accessToken));
    await db().transaction('rw', db().kv, async () => {
      await db().setKv(K_REFRESH, refresh);
      await db().setKv(K_ACCESS, access);
      await db().setKv(K_ACCESS_EXP, tokens.accessExpiresAt);
      await db().setKv(K_SESSION, tokens.sessionId);
    });
  }

  private async saveUser(user: UserDto, keepExpired = true): Promise<void> {
    const prev = await db().getKv<StoredAccount | null>(K_ACCOUNT, null);
    const acct: StoredAccount = {
      userId: user.id,
      email: user.email,
      displayName: user.displayName ?? null,
      usedBytes: user.storage.usedBytes,
      quotaBytes: user.storage.quotaBytes,
      recordBytes: user.storage.recordBytes,
      blobBytes: user.storage.blobBytes,
      expired: keepExpired ? (prev?.expired ?? false) : false,
    };
    await db().setKv(K_ACCOUNT, acct);
    await this.load();
    this.broadcast();
  }

  private async markExpired(): Promise<void> {
    const acct = await db().getKv<StoredAccount | null>(K_ACCOUNT, null);
    if (acct) await db().setKv(K_ACCOUNT, { ...acct, expired: true });
    await db().kv.bulkDelete([K_ACCESS, K_REFRESH]);
    await this.load();
    this.broadcast();
  }

  private async clearSession(): Promise<void> {
    this.vaultCache = null;
    await db().kv.bulkDelete([K_ACCOUNT, ...SECRET_KEYS]);
    await this.load();
    this.broadcast();
  }

  private async device(): Promise<DeviceDto> {
    return { name: (await platform().deviceName()).slice(0, 80), platform: platform().apiPlatform };
  }

  private async mapErrors<T>(block: () => Promise<T>): Promise<T> {
    try {
      return await block();
    } catch (e) {
      if (e instanceof ApiError) {
        const messages: Record<string, string> = {
          invalid_credentials: 'That email and password don’t match an account.',
          email_taken: 'An account with this email already exists. Sign in instead.',
          registration_closed: 'This server isn’t accepting new accounts.',
          rate_limited: 'Too many attempts. Wait a few minutes and try again.',
          email_disabled: 'This server can’t send email. Use your recovery code instead.',
        };
        throw new AuthError(messages[e.code] ?? e.message ?? 'The sync server returned an error.');
      }
      if (e instanceof AuthError) throw e;
      if (e instanceof NetworkError || e instanceof TypeError) {
        throw new AuthError('Couldn’t reach the sync server. Check your connection and the server address.');
      }
      if (e instanceof DecryptionError) throw new AuthError('Your encryption key couldn’t be unlocked.');
      throw e;
    }
  }
}
