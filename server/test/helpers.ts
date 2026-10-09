import '../src/warnings.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { buildApp, type BuildOptions } from '../src/app.js';
import { defaultConfig, type Config } from '../src/config.js';
import type { AppContext } from '../src/context.js';
import {
  AAD,
  newAccount,
  passwordKeys,
  registerBody,
  unwrapVaultKey,
  type AccountSecrets,
} from './client-crypto.js';

export const TEST_ITERATIONS = 100_000;

const RELAXED = { max: 100_000, windowMs: 60_000 };

export interface TestApp {
  app: FastifyInstance;
  ctx: AppContext;
  config: Config;
  close(): Promise<void>;
}

export async function makeApp(overrides: Partial<Config> = {}, options: BuildOptions = {}): Promise<TestApp> {
  const dataDir = mkdtempSync(path.join(tmpdir(), 'facet-test-'));
  const config: Config = {
    ...defaultConfig(),
    dataDir,
    jwtSecret: 'test-jwt-secret-0123456789abcdefghijklmnop',
    serverSecret: 'test-server-secret-0123456789abcdefghijklm',
    logger: false,
    refreshReuseGraceMs: 0,
    rateLimits: { prelogin: RELAXED, authIp: RELAXED, authEmail: RELAXED },
    ...overrides,
  };
  const { app, ctx } = buildApp(config, options);
  await app.ready();
  return {
    app,
    ctx,
    config,
    async close() {
      await app.close();
      rmSync(dataDir, { recursive: true, force: true });
    },
  };
}

export interface ApiResponse<T = any> {
  status: number;
  json: T;
  headers: Record<string, string | string[] | number | undefined>;
  raw: Buffer;
}

export async function api<T = any>(
  app: FastifyInstance,
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE',
  url: string,
  opts: { token?: string; body?: unknown; payload?: Buffer; contentType?: string; ip?: string } = {},
): Promise<ApiResponse<T>> {
  const headers: Record<string, string> = {};
  if (opts.token) headers.authorization = `Bearer ${opts.token}`;
  let payload: string | Buffer | undefined;
  if (opts.payload !== undefined) {
    payload = opts.payload;
    headers['content-type'] = opts.contentType ?? 'application/octet-stream';
  } else if (opts.body !== undefined) {
    payload = JSON.stringify(opts.body);
    headers['content-type'] = 'application/json';
  }
  const res = await app.inject({
    method,
    url,
    headers,
    payload,
    ...(opts.ip ? { remoteAddress: opts.ip } : {}),
  });
  const raw = res.rawPayload;
  let json: any = undefined;
  if (raw.length > 0 && String(res.headers['content-type'] ?? '').includes('application/json')) {
    json = JSON.parse(raw.toString('utf8'));
  }
  return { status: res.statusCode, json: json as T, headers: res.headers, raw };
}

export interface Registered {
  email: string;
  account: AccountSecrets;
  user: any;
  tokens: { accessToken: string; refreshToken: string; sessionId: string; accessExpiresAt: number };
}

let counter = 0;
export function uniqueEmail(prefix = 'user'): string {
  counter += 1;
  return `${prefix}${counter}.${Date.now()}@example.com`;
}

export async function registerUser(app: FastifyInstance, email = uniqueEmail(), password = 'hunter2 but longer'): Promise<Registered> {
  const account = newAccount(password, TEST_ITERATIONS);
  const res = await api(app, 'POST', '/v1/auth/register', { body: registerBody(email, account) });
  if (res.status !== 201) throw new Error(`register failed: ${res.status} ${JSON.stringify(res.json)}`);
  return { email, account, user: res.json.user, tokens: res.json.tokens };
}

/** Full client login: prelogin → derive → login → unwrap vault key. */
export async function loginUser(app: FastifyInstance, email: string, password: string, deviceName = 'Second device') {
  const pre = await api(app, 'POST', '/v1/auth/prelogin', { body: { email } });
  if (pre.status !== 200) throw new Error(`prelogin failed: ${pre.status}`);
  const salt = Buffer.from(pre.json.kdf.salt, 'base64');
  const keys = passwordKeys(password, salt, pre.json.kdf.iterations);
  const res = await api(app, 'POST', '/v1/auth/login', {
    body: { email, authHash: keys.authKey.toString('base64'), device: { name: deviceName, platform: 'android' } },
  });
  let vaultKey: Buffer | null = null;
  if (res.status === 200) {
    vaultKey = unwrapVaultKey(keys.wrapKey, Buffer.from(res.json.wrappedVaultKey, 'base64'), AAD.vaultKey);
  }
  return { res, keys, vaultKey };
}
