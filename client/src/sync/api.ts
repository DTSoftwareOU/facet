/** Thin, stateless client for the Facet sync server (docs/API.md). Authentication lives in AuthManager. */
import { buf } from '../core/bytes';
import { t } from '../i18n';

export interface Kdf {
  algorithm: string;
  iterations: number;
  salt: string;
}

export interface Storage {
  usedBytes: number;
  quotaBytes: number;
  recordBytes: number;
  blobBytes: number;
}

export interface UserDto {
  id: string;
  email: string;
  displayName?: string | null;
  createdAt: number;
  storage: Storage;
}

export interface TokensDto {
  accessToken: string;
  accessExpiresAt: number;
  refreshToken: string;
  sessionId: string;
}

export interface DeviceDto {
  name: string;
  platform: string;
}

export interface RecoveryDto {
  authHash: string;
  wrappedVaultKey: string;
}

export interface MetaDto {
  name: string;
  version: string;
  registrationOpen: boolean;
  emailEnabled: boolean;
}

export interface SessionDto {
  id: string;
  deviceName: string;
  platform: string;
  createdAt: number;
  lastSeenAt: number;
  ip?: string | null;
  current: boolean;
}

export interface PeerDto {
  sessionId: string;
  deviceName: string;
  platform: string;
}

export interface RecordDto {
  id: string;
  type: string;
  updatedAt: number;
  deleted: boolean;
  ct?: string | null;
  seq?: number;
}

export interface PushRes {
  accepted: { id: string; type: string; seq: number }[];
  rejected: { id: string; type: string; reason: string; current?: RecordDto | null }[];
  cursor: number;
}

export interface PullRes {
  records: RecordDto[];
  cursor: number;
  hasMore: boolean;
  reset?: boolean;
}

/** The server answered with an error (docs/API.md "Errors"). */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly retryAfter: number | null = null,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

/** The server couldn't be reached (offline, DNS, TLS, blocked). */
export class NetworkError extends Error {
  constructor(message = t('Couldn’t reach the sync server.')) {
    super(message);
    this.name = 'NetworkError';
  }
}

function emptyStorage(): Storage {
  return { usedBytes: 0, quotaBytes: 0, recordBytes: 0, blobBytes: 0 };
}

export function normalizeUser(u: any): UserDto {
  return {
    id: String(u?.id ?? ''),
    email: String(u?.email ?? ''),
    displayName: u?.displayName ?? null,
    createdAt: Number(u?.createdAt ?? 0),
    storage: { ...emptyStorage(), ...(u?.storage ?? {}) },
  };
}

function defaultMessage(status: number): string {
  if (status >= 500) return t('The sync server had a problem. Try again in a moment.');
  if (status === 404) return t('The sync server doesn’t recognize this request. Check the server address.');
  return t('The sync server returned an error ({status}).', { status: String(status) });
}

export class SyncApi {
  constructor(private readonly fetchFn: typeof fetch = (i, init) => fetch(i, init)) {}

  private async request(base: string, method: string, path: string, token: string | null, body?: BodyInit | null, contentType?: string): Promise<Response> {
    const headers: Record<string, string> = {};
    if (token) headers.Authorization = `Bearer ${token}`;
    if (contentType) headers['Content-Type'] = contentType;
    let res: Response;
    try {
      res = await this.fetchFn(base.replace(/\/+$/, '') + path, { method, headers, body: body ?? undefined, cache: 'no-store' });
    } catch (e) {
      if ((e as Error)?.name === 'AbortError') throw e;
      throw new NetworkError();
    }
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      let code = `http_${res.status}`;
      let message = defaultMessage(res.status);
      try {
        const err = JSON.parse(text)?.error;
        if (err?.code) code = String(err.code);
        if (err?.message) message = String(err.message);
      } catch {
        // Not JSON (a proxy error page): keep the default message.
      }
      const ra = Number(res.headers.get('Retry-After'));
      throw new ApiError(res.status, code, message, Number.isFinite(ra) && ra > 0 ? ra : null);
    }
    return res;
  }

  private async json<T>(base: string, method: string, path: string, token: string | null, body?: unknown): Promise<T> {
    const res = await this.request(base, method, path, token, body === undefined ? null : JSON.stringify(body), body === undefined ? undefined : 'application/json');
    const text = await res.text();
    return (text ? JSON.parse(text) : {}) as T;
  }

  meta(base: string): Promise<MetaDto> {
    return this.json(base, 'GET', '/v1/meta', null);
  }

  async prelogin(base: string, email: string): Promise<Kdf> {
    return (await this.json<{ kdf: Kdf }>(base, 'POST', '/v1/auth/prelogin', null, { email })).kdf;
  }

  async register(base: string, req: unknown): Promise<{ user: UserDto; tokens: TokensDto }> {
    const r = await this.json<any>(base, 'POST', '/v1/auth/register', null, req);
    return { user: normalizeUser(r.user), tokens: r.tokens };
  }

  async login(base: string, req: { email: string; authHash: string; device: DeviceDto }): Promise<{ user: UserDto; tokens: TokensDto; kdf: Kdf; wrappedVaultKey: string }> {
    const r = await this.json<any>(base, 'POST', '/v1/auth/login', null, req);
    return { ...r, user: normalizeUser(r.user) };
  }

  async refresh(base: string, refreshToken: string): Promise<TokensDto> {
    return (await this.json<{ tokens: TokensDto }>(base, 'POST', '/v1/auth/refresh', null, { refreshToken })).tokens;
  }

  async logout(base: string, token: string): Promise<void> {
    await this.json(base, 'POST', '/v1/auth/logout', token, {});
  }

  recoverStart(base: string, email: string, recoveryAuthHash: string): Promise<{ resetToken: string; recoveryWrappedVaultKey: string; kdf: Kdf }> {
    return this.json(base, 'POST', '/v1/auth/recover/start', null, { email, recoveryAuthHash });
  }

  async recoverFinish(base: string, req: unknown): Promise<{ user: UserDto; tokens: TokensDto }> {
    const r = await this.json<any>(base, 'POST', '/v1/auth/recover/finish', null, req);
    return { user: normalizeUser(r.user), tokens: r.tokens };
  }

  async resetRequest(base: string, email: string): Promise<void> {
    await this.json(base, 'POST', '/v1/auth/reset/request', null, { email });
  }

  async resetConfirm(base: string, req: unknown): Promise<{ user: UserDto; tokens: TokensDto }> {
    const r = await this.json<any>(base, 'POST', '/v1/auth/reset/confirm', null, req);
    return { user: normalizeUser(r.user), tokens: r.tokens };
  }

  async account(base: string, token: string): Promise<UserDto> {
    return normalizeUser((await this.json<any>(base, 'GET', '/v1/account', token)).user);
  }

  async changePassword(base: string, token: string, req: unknown): Promise<TokensDto> {
    return (await this.json<{ tokens: TokensDto }>(base, 'POST', '/v1/account/password', token, req)).tokens;
  }

  async setRecovery(base: string, token: string, currentAuthHash: string, recovery: RecoveryDto): Promise<void> {
    await this.json(base, 'POST', '/v1/account/recovery', token, { currentAuthHash, recovery });
  }

  async deleteAccount(base: string, token: string, currentAuthHash: string): Promise<void> {
    await this.json(base, 'DELETE', '/v1/account', token, { currentAuthHash });
  }

  async sessions(base: string, token: string): Promise<SessionDto[]> {
    return (await this.json<{ sessions: SessionDto[] }>(base, 'GET', '/v1/sessions', token)).sessions ?? [];
  }

  async revokeSession(base: string, token: string, id: string): Promise<void> {
    await this.request(base, 'DELETE', `/v1/sessions/${encodeURIComponent(id)}`, token);
  }

  async revokeOtherSessions(base: string, token: string): Promise<void> {
    await this.request(base, 'DELETE', '/v1/sessions', token);
  }

  async push(base: string, token: string, records: RecordDto[]): Promise<PushRes> {
    const r = await this.json<Partial<PushRes>>(base, 'POST', '/v1/sync/push', token, { records });
    return { accepted: r.accepted ?? [], rejected: r.rejected ?? [], cursor: r.cursor ?? 0 };
  }

  async pull(base: string, token: string, since: number, limit = 500): Promise<PullRes> {
    const r = await this.json<Partial<PullRes>>(base, 'GET', `/v1/sync/pull?since=${since}&limit=${limit}`, token);
    return { records: r.records ?? [], cursor: r.cursor ?? since, hasMore: r.hasMore ?? false, reset: r.reset ?? false };
  }

  async putBlob(base: string, token: string, id: string, bytes: Uint8Array): Promise<void> {
    await this.request(base, 'PUT', `/v1/blobs/${id}`, token, buf(bytes), 'application/octet-stream');
  }

  async getBlob(base: string, token: string, id: string): Promise<Uint8Array> {
    const res = await this.request(base, 'GET', `/v1/blobs/${id}`, token);
    return new Uint8Array(await res.arrayBuffer());
  }

  async deleteBlob(base: string, token: string, id: string): Promise<void> {
    await this.request(base, 'DELETE', `/v1/blobs/${id}`, token);
  }

  /** The account's other sessions that are online now (docs/REMOTE.md). */
  async relayPeers(base: string, token: string): Promise<PeerDto[]> {
    const r = await this.json<{ peers?: PeerDto[] }>(base, 'GET', '/v1/relay/peers', token);
    return r.peers ?? [];
  }

  /** Forwards an encrypted envelope (base64) to another session of the account. */
  async relay(base: string, token: string, to: string, msg: string): Promise<void> {
    await this.json(base, 'POST', '/v1/relay', token, { to, msg });
  }

  /** Opens the change stream (Server-Sent Events). The caller reads `body` and aborts via [signal]. */
  async stream(base: string, token: string, signal: AbortSignal): Promise<Response> {
    let res: Response;
    try {
      res = await this.fetchFn(base.replace(/\/+$/, '') + '/v1/sync/stream', {
        headers: { Authorization: `Bearer ${token}`, Accept: 'text/event-stream' },
        signal,
        cache: 'no-store',
      });
    } catch (e) {
      if ((e as Error)?.name === 'AbortError') throw e;
      throw new NetworkError();
    }
    return res;
  }
}
