import { createHash, createHmac, randomBytes, randomUUID, scrypt, timingSafeEqual } from 'node:crypto';

const SCRYPT_PARAMS = { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 } as const;

function scryptAsync(secret: Buffer, salt: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(secret, salt, 32, SCRYPT_PARAMS, (err, key) => (err ? reject(err) : resolve(key)));
  });
}

export interface Verifier {
  verifier: Buffer;
  salt: Buffer;
}

/** Hashes a client-derived auth key (already high entropy) for storage. */
export async function makeVerifier(authHash: Buffer): Promise<Verifier> {
  const salt = randomBytes(16);
  return { verifier: await scryptAsync(authHash, salt), salt };
}

export async function checkVerifier(authHash: Buffer, verifier: Buffer, salt: Buffer): Promise<boolean> {
  const candidate = await scryptAsync(authHash, salt);
  return candidate.length === verifier.length && timingSafeEqual(candidate, verifier);
}

/** Burns the same work as a real check so unknown accounts can't be timed. */
export async function dummyVerify(authHash: Buffer): Promise<void> {
  await scryptAsync(authHash, randomBytes(16));
}

export function sha256(data: string | Buffer): Buffer {
  return createHash('sha256').update(data).digest();
}

export function hmacSha256(key: string | Buffer, data: string | Buffer): Buffer {
  return createHmac('sha256', key).update(data).digest();
}

export function safeEqual(a: Buffer, b: Buffer): boolean {
  return a.length === b.length && timingSafeEqual(a, b);
}

export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString('base64url');
}

export function newId(): string {
  return randomUUID();
}

// ---------------------------------------------------------------------------
// Minimal HS256 JWT
// ---------------------------------------------------------------------------

export interface AccessClaims {
  sub: string;
  sid: string;
  iat: number;
  exp: number;
}

const JWT_HEADER = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');

export function signJwt(claims: AccessClaims, secret: string): string {
  const payload = Buffer.from(JSON.stringify(claims)).toString('base64url');
  const signingInput = `${JWT_HEADER}.${payload}`;
  const sig = hmacSha256(secret, signingInput).toString('base64url');
  return `${signingInput}.${sig}`;
}

export function verifyJwt(token: string, secret: string, nowMs = Date.now()): AccessClaims | null {
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const [header, payload, sig] = parts as [string, string, string];
  if (header !== JWT_HEADER) return null;
  const expected = hmacSha256(secret, `${header}.${payload}`);
  let given: Buffer;
  try {
    given = Buffer.from(sig, 'base64url');
  } catch {
    return null;
  }
  if (!safeEqual(expected, given)) return null;
  let claims: unknown;
  try {
    claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
  } catch {
    return null;
  }
  if (!claims || typeof claims !== 'object') return null;
  const c = claims as Partial<AccessClaims>;
  if (typeof c.sub !== 'string' || typeof c.sid !== 'string' || typeof c.exp !== 'number' || typeof c.iat !== 'number') {
    return null;
  }
  if (c.exp * 1000 <= nowMs) return null;
  return c as AccessClaims;
}
