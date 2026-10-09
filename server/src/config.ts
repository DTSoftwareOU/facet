import { readFileSync } from 'node:fs';
import path from 'node:path';

export interface RateLimitRule {
  /** Max events in the window. */
  max: number;
  windowMs: number;
}

export interface Config {
  port: number;
  host: string;
  dataDir: string;
  jwtSecret: string;
  serverSecret: string;
  publicUrl: string;
  registrationOpen: boolean;
  blobQuotaBytes: number;
  /** Number of reverse-proxy hops whose X-Forwarded-For entries are trusted (0 = ignore the header). */
  trustProxy: number;
  smtpUrl: string | null;
  smtpFrom: string;
  logLevel: string;
  /** Logging on/off (tests turn it off). */
  logger: boolean;
  version: string;
  defaultKdfIterations: number;
  accessTokenTtlMs: number;
  sessionIdleTtlMs: number;
  /** A rotated refresh token re-presented within this window is treated as a benign retry. */
  refreshReuseGraceMs: number;
  tombstoneRetentionMs: number;
  limits: {
    maxRecordBytes: number;
    maxBatchRecords: number;
    maxBatchBodyBytes: number;
    maxBlobBytes: number;
    maxPullLimit: number;
    defaultPullLimit: number;
  };
  rateLimits: {
    prelogin: RateLimitRule;
    authIp: RateLimitRule;
    authEmail: RateLimitRule;
  };
  ssePingMs: number;
}

const MiB = 1024 * 1024;

function readVersion(): string {
  try {
    const pkgPath = new URL('../package.json', import.meta.url);
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as { version?: string };
    return pkg.version ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
}

export function defaultConfig(): Omit<Config, 'jwtSecret' | 'serverSecret'> {
  return {
    port: 8787,
    host: '0.0.0.0',
    dataDir: path.resolve('data'),
    publicUrl: 'http://localhost:8787',
    registrationOpen: true,
    blobQuotaBytes: 2 * 1024 * MiB,
    trustProxy: 1,
    smtpUrl: null,
    smtpFrom: 'Facet <no-reply@dtsoftware.io>',
    logLevel: 'info',
    logger: true,
    version: readVersion(),
    defaultKdfIterations: 600_000,
    accessTokenTtlMs: 15 * 60 * 1000,
    sessionIdleTtlMs: 90 * 24 * 60 * 60 * 1000,
    refreshReuseGraceMs: 30 * 1000,
    tombstoneRetentionMs: 180 * 24 * 60 * 60 * 1000,
    limits: {
      maxRecordBytes: 2 * MiB,
      maxBatchRecords: 500,
      maxBatchBodyBytes: 8 * MiB,
      maxBlobBytes: 32 * MiB,
      maxPullLimit: 1000,
      defaultPullLimit: 500,
    },
    rateLimits: {
      prelogin: { max: 30, windowMs: 60 * 1000 },
      authIp: { max: 10, windowMs: 15 * 60 * 1000 },
      authEmail: { max: 5, windowMs: 15 * 60 * 1000 },
    },
    ssePingMs: 25 * 1000,
  };
}

function bool(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined || value === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(value.trim().toLowerCase());
}

function int(name: string, value: string | undefined, fallback: number): number {
  if (value === undefined || value === '') return fallback;
  const n = Number(value);
  if (!Number.isSafeInteger(n) || n < 0) throw new Error(`${name} must be a non-negative integer`);
  return n;
}

/** TRUST_PROXY: "true" = one proxy hop (Caddy), "false" = none, or an explicit hop count. */
function proxyHops(value: string | undefined, fallback: number): number {
  if (value === undefined || value === '') return fallback;
  if (/^\d+$/.test(value.trim())) return Number(value.trim());
  return bool(value, fallback > 0) ? 1 : 0;
}

function secret(name: string, value: string | undefined): string {
  if (!value || value.length < 32) {
    throw new Error(`${name} is required and must be at least 32 characters (try: openssl rand -base64 48)`);
  }
  return value;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const base = defaultConfig();
  return {
    ...base,
    port: int('PORT', env.PORT, base.port),
    host: env.HOST || base.host,
    dataDir: path.resolve(env.DATA_DIR || base.dataDir),
    jwtSecret: secret('JWT_SECRET', env.JWT_SECRET),
    serverSecret: secret('SERVER_SECRET', env.SERVER_SECRET),
    publicUrl: (env.PUBLIC_URL || base.publicUrl).replace(/\/+$/, ''),
    registrationOpen: bool(env.REGISTRATION_OPEN, base.registrationOpen),
    blobQuotaBytes: int('BLOB_QUOTA_BYTES', env.BLOB_QUOTA_BYTES, base.blobQuotaBytes),
    trustProxy: proxyHops(env.TRUST_PROXY, base.trustProxy),
    smtpUrl: env.SMTP_URL || null,
    smtpFrom: env.SMTP_FROM || base.smtpFrom,
    logLevel: env.LOG_LEVEL || base.logLevel,
    rateLimits: {
      ...base.rateLimits,
      authIp: { ...base.rateLimits.authIp, max: int('AUTH_RATE_LIMIT_PER_IP', env.AUTH_RATE_LIMIT_PER_IP, base.rateLimits.authIp.max) },
    },
  };
}
