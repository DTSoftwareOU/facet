import type { FastifyReply, FastifyRequest } from 'fastify';
import type { AppContext } from '../context.js';
import { signJwt, verifyJwt } from '../crypto.js';
import { errors } from '../errors.js';
import type { SessionRow } from '../store.js';

export interface Tokens {
  accessToken: string;
  accessExpiresAt: number;
  refreshToken: string;
  sessionId: string;
}

export interface AuthInfo {
  userId: string;
  sessionId: string;
}

declare module 'fastify' {
  interface FastifyRequest {
    auth: AuthInfo | null;
  }
}

const TOUCH_INTERVAL_MS = 5 * 60 * 1000;

export function issueTokens(ctx: AppContext, session: SessionRow, refreshToken: string): Tokens {
  const nowSec = Math.floor(Date.now() / 1000);
  const expSec = nowSec + Math.floor(ctx.config.accessTokenTtlMs / 1000);
  const accessToken = signJwt({ sub: session.userId, sid: session.id, iat: nowSec, exp: expSec }, ctx.config.jwtSecret);
  return { accessToken, accessExpiresAt: expSec * 1000, refreshToken, sessionId: session.id };
}

export function bearerToken(request: FastifyRequest): string | null {
  const header = request.headers.authorization;
  if (!header) return null;
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  return match ? match[1]!.trim() : null;
}

/** Resolves and validates the caller's session. Throws `unauthorized` on any failure. */
export function resolveAuth(ctx: AppContext, request: FastifyRequest): AuthInfo {
  const token = bearerToken(request);
  if (!token) throw errors.unauthorized('Missing access token.');
  const claims = verifyJwt(token, ctx.config.jwtSecret);
  if (!claims) throw errors.unauthorized('Access token is invalid or expired.');
  const session = ctx.store.sessionById(claims.sid);
  if (!session || session.userId !== claims.sub || !ctx.store.isSessionLive(session)) {
    throw errors.unauthorized('This session has ended. Sign in again.');
  }
  if (Date.now() - session.lastSeenAt > TOUCH_INTERVAL_MS) ctx.store.touchSession(session.id, request.ip ?? null);
  return { userId: session.userId, sessionId: session.id };
}

export function authenticate(ctx: AppContext) {
  return async (request: FastifyRequest, _reply: FastifyReply): Promise<void> => {
    request.auth = resolveAuth(ctx, request);
  };
}

export function requireAuth(request: FastifyRequest): AuthInfo {
  if (!request.auth) throw errors.unauthorized();
  return request.auth;
}
