import { randomInt } from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { authenticate, issueTokens, requireAuth } from '../auth/tokens.js';
import { closeStreams, type AppContext } from '../context.js';
import { checkVerifier, dummyVerify, hmacSha256, makeVerifier, safeEqual, sha256 } from '../crypto.js';
import { transaction } from '../db.js';
import { errors } from '../errors.js';
import { resetCodeEmail } from '../mail.js';
import {
  authHashSchema,
  deviceSchema,
  displayNameSchema,
  emailSchema,
  kdfSchema,
  parse,
  recoverySchema,
  wrappedKeySchema,
  type KdfInput,
} from '../validation.js';
import type { Credentials, RecoveryCredentials } from '../store.js';

const RESET_TOKEN_TTL_MS = 15 * 60 * 1000;
const EMAIL_CODE_TTL_MS = 30 * 60 * 1000;
const EMAIL_CODE_MAX_ATTEMPTS = 5;

const registerBody = z.object({
  email: emailSchema,
  displayName: displayNameSchema,
  kdf: kdfSchema,
  authHash: authHashSchema,
  wrappedVaultKey: wrappedKeySchema,
  recovery: recoverySchema,
  device: deviceSchema,
});

const loginBody = z.object({ email: emailSchema, authHash: authHashSchema, device: deviceSchema });
const refreshBody = z.object({ refreshToken: z.string().min(16).max(256) });
const recoverStartBody = z.object({ email: emailSchema, recoveryAuthHash: authHashSchema });
const recoverFinishBody = z.object({
  resetToken: z.string().min(16).max(256),
  kdf: kdfSchema,
  authHash: authHashSchema,
  wrappedVaultKey: wrappedKeySchema,
  recovery: recoverySchema,
  device: deviceSchema,
});
const resetRequestBody = z.object({ email: emailSchema });
const resetConfirmBody = z.object({
  email: emailSchema,
  code: z
    .string()
    .transform((s) => s.replace(/[\s-]/g, ''))
    .refine((s) => /^\d{8}$/.test(s), 'must be 8 digits'),
  kdf: kdfSchema,
  authHash: authHashSchema,
  wrappedVaultKey: wrappedKeySchema,
  recovery: recoverySchema,
  device: deviceSchema,
});

export async function credentialsFrom(kdf: KdfInput, authHash: Buffer, wrappedVaultKey: Buffer): Promise<Credentials> {
  const v = await makeVerifier(authHash);
  return {
    kdfIterations: kdf.iterations,
    kdfSalt: kdf.salt,
    authVerifier: v.verifier,
    authSalt: v.salt,
    wrappedVaultKey,
  };
}

export async function recoveryFrom(recovery: { authHash: Buffer; wrappedVaultKey: Buffer }): Promise<RecoveryCredentials> {
  const v = await makeVerifier(recovery.authHash);
  return { recoveryVerifier: v.verifier, recoverySalt: v.salt, recoveryWrappedVaultKey: recovery.wrappedVaultKey };
}

export function authRoutes(app: FastifyInstance, ctx: AppContext): void {
  const limits = ctx.config.rateLimits;
  const ipOf = (req: FastifyRequest) => req.ip ?? 'unknown';
  const limitIp = (req: FastifyRequest) => ctx.limiter.hit(`auth:ip:${ipOf(req)}`, limits.authIp);
  const emailKey = (email: string) => `auth:email:${email}`;
  const checkEmail = (email: string) => {
    const retry = ctx.limiter.check(emailKey(email), limits.authEmail);
    if (retry > 0) throw errors.rateLimited(retry);
  };
  const failEmail = (email: string) => ctx.limiter.record(emailKey(email), limits.authEmail);

  const fakeKdf = (email: string) => ({
    algorithm: 'pbkdf2-sha256' as const,
    iterations: ctx.config.defaultKdfIterations,
    salt: hmacSha256(ctx.config.serverSecret, `prelogin:${email}`).subarray(0, 16).toString('base64'),
  });

  app.post('/v1/auth/prelogin', async (req) => {
    ctx.limiter.hit(`prelogin:ip:${ipOf(req)}`, limits.prelogin);
    const { email } = parse(z.object({ email: emailSchema }), req.body);
    const user = ctx.store.userByEmail(email);
    return { kdf: user ? ctx.store.publicKdf(user) : fakeKdf(email) };
  });

  app.post('/v1/auth/register', async (req, reply) => {
    limitIp(req);
    const body = parse(registerBody, req.body);
    if (!ctx.config.registrationOpen) throw errors.registrationClosed();
    if (ctx.store.userByEmail(body.email)) throw errors.emailTaken();
    const [credentials, recovery] = await Promise.all([
      credentialsFrom(body.kdf, body.authHash, body.wrappedVaultKey),
      recoveryFrom(body.recovery),
    ]);
    let user;
    try {
      user = ctx.store.createUser({ email: body.email, displayName: body.displayName, credentials, recovery });
    } catch (err) {
      if (err instanceof Error && /UNIQUE constraint failed: users\.email/.test(err.message)) throw errors.emailTaken();
      throw err;
    }
    const { session, refreshToken } = ctx.store.createSession(user.id, body.device, req.ip ?? null);
    reply.code(201);
    return { user: ctx.store.publicUser(user), tokens: issueTokens(ctx, session, refreshToken) };
  });

  app.post('/v1/auth/login', async (req) => {
    limitIp(req);
    const body = parse(loginBody, req.body);
    checkEmail(body.email);
    const user = ctx.store.userByEmail(body.email);
    if (!user) {
      await dummyVerify(body.authHash);
      failEmail(body.email);
      throw errors.invalidCredentials();
    }
    if (!(await checkVerifier(body.authHash, user.authVerifier, user.authSalt))) {
      failEmail(body.email);
      throw errors.invalidCredentials();
    }
    const { session, refreshToken } = ctx.store.createSession(user.id, body.device, req.ip ?? null);
    return {
      user: ctx.store.publicUser(user),
      tokens: issueTokens(ctx, session, refreshToken),
      kdf: ctx.store.publicKdf(user),
      wrappedVaultKey: user.wrappedVaultKey.toString('base64'),
    };
  });

  app.post('/v1/auth/refresh', async (req) => {
    const { refreshToken } = parse(refreshBody, req.body);
    const hash = sha256(refreshToken);
    const ip = req.ip ?? null;

    const current = ctx.store.sessionByRefreshHash(hash);
    if (current) {
      if (!ctx.store.isSessionLive(current)) throw errors.invalidRefresh();
      const next = ctx.store.rotateRefresh(current, ip);
      return { tokens: issueTokens(ctx, current, next) };
    }

    const previous = ctx.store.sessionByPrevRefreshHash(hash);
    if (previous) {
      const withinGrace =
        previous.rotatedAt !== null && Date.now() - previous.rotatedAt < ctx.config.refreshReuseGraceMs;
      if (withinGrace && ctx.store.isSessionLive(previous)) {
        // The client most likely never received the rotated token (lost response); hand out a fresh one.
        const next = ctx.store.reissueRefresh(previous, ip);
        return { tokens: issueTokens(ctx, previous, next) };
      }
      // A rotated token came back: assume it was stolen and end the session.
      ctx.store.revokeSession(previous.id);
      closeStreams(ctx, (s) => s.sessionId === previous.id);
      req.log.warn({ sessionId: previous.id }, 'refresh token reuse detected; session revoked');
    }
    throw errors.invalidRefresh();
  });

  app.post('/v1/auth/logout', { onRequest: authenticate(ctx) }, async (req, reply) => {
    const auth = requireAuth(req);
    ctx.store.revokeSession(auth.sessionId);
    closeStreams(ctx, (s) => s.sessionId === auth.sessionId);
    reply.code(204).send();
  });

  app.post('/v1/auth/recover/start', async (req) => {
    limitIp(req);
    const body = parse(recoverStartBody, req.body);
    checkEmail(body.email);
    const user = ctx.store.userByEmail(body.email);
    const invalid = () => errors.invalidCredentials('Email or recovery code is incorrect.');
    if (!user) {
      await dummyVerify(body.recoveryAuthHash);
      failEmail(body.email);
      throw invalid();
    }
    if (!(await checkVerifier(body.recoveryAuthHash, user.recoveryVerifier, user.recoverySalt))) {
      failEmail(body.email);
      throw invalid();
    }
    const resetToken = ctx.store.createResetToken(user.id, 'recovery', RESET_TOKEN_TTL_MS);
    return {
      resetToken,
      recoveryWrappedVaultKey: user.recoveryWrappedVaultKey.toString('base64'),
      kdf: ctx.store.publicKdf(user),
    };
  });

  app.post('/v1/auth/recover/finish', async (req) => {
    limitIp(req);
    const body = parse(recoverFinishBody, req.body);
    const userId = ctx.store.consumeResetToken(body.resetToken, 'recovery');
    if (!userId) throw errors.invalidCredentials('This recovery link has expired. Start again.');
    const [credentials, recovery] = await Promise.all([
      credentialsFrom(body.kdf, body.authHash, body.wrappedVaultKey),
      recoveryFrom(body.recovery),
    ]);
    transaction(ctx.db, () => {
      ctx.store.setCredentials(userId, credentials);
      ctx.store.setRecovery(userId, recovery);
      ctx.store.revokeAllSessions(userId);
    });
    closeStreams(ctx, (s) => s.userId === userId);
    const user = ctx.store.userById(userId);
    if (!user) throw errors.invalidCredentials();
    const { session, refreshToken } = ctx.store.createSession(user.id, body.device, req.ip ?? null);
    return { user: ctx.store.publicUser(user), tokens: issueTokens(ctx, session, refreshToken) };
  });

  app.post('/v1/auth/reset/request', async (req, reply) => {
    const mailer = ctx.mailer;
    if (!mailer) throw errors.emailDisabled();
    limitIp(req);
    const { email } = parse(resetRequestBody, req.body);
    checkEmail(email);
    failEmail(email); // every request counts, to stop inbox flooding
    const user = ctx.store.userByEmail(email);
    if (user) {
      const code = String(randomInt(0, 100_000_000)).padStart(8, '0');
      ctx.store.setEmailCode(user.id, hmacSha256(ctx.config.serverSecret, `reset:${user.id}:${code}`), EMAIL_CODE_TTL_MS);
      try {
        await mailer.send(resetCodeEmail(user.email, code, ctx.config.publicUrl));
      } catch (err) {
        req.log.error({ err: err instanceof Error ? err.message : String(err) }, 'failed to send reset email');
      }
    }
    reply.code(202);
    return {};
  });

  app.post('/v1/auth/reset/confirm', async (req) => {
    if (!ctx.mailer) throw errors.emailDisabled();
    limitIp(req);
    const body = parse(resetConfirmBody, req.body);
    const invalid = () => errors.invalidCredentials('The code is incorrect or has expired.');
    const user = ctx.store.userByEmail(body.email);
    if (!user) throw invalid();
    const pending = ctx.store.emailCode(user.id);
    if (!pending || pending.expiresAt < Date.now() || pending.attempts >= EMAIL_CODE_MAX_ATTEMPTS) {
      ctx.store.deleteEmailCode(user.id);
      throw invalid();
    }
    const candidate = hmacSha256(ctx.config.serverSecret, `reset:${user.id}:${body.code}`);
    if (!safeEqual(candidate, pending.codeHash)) {
      const attempts = ctx.store.bumpEmailCodeAttempts(user.id);
      if (attempts >= EMAIL_CODE_MAX_ATTEMPTS) ctx.store.deleteEmailCode(user.id);
      throw invalid();
    }
    const [credentials, recovery] = await Promise.all([
      credentialsFrom(body.kdf, body.authHash, body.wrappedVaultKey),
      recoveryFrom(body.recovery),
    ]);
    transaction(ctx.db, () => {
      ctx.store.wipeUserData(user.id);
      ctx.store.setCredentials(user.id, credentials);
      ctx.store.setRecovery(user.id, recovery);
      ctx.store.revokeAllSessions(user.id);
      ctx.store.deleteEmailCode(user.id);
    });
    closeStreams(ctx, (s) => s.userId === user.id);
    await ctx.blobs.deleteAll(user.id);
    const fresh = ctx.store.userById(user.id)!;
    const { session, refreshToken } = ctx.store.createSession(fresh.id, body.device, req.ip ?? null);
    return { user: ctx.store.publicUser(fresh), tokens: issueTokens(ctx, session, refreshToken) };
  });
}
