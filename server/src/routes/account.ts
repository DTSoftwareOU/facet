import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { authenticate, issueTokens, requireAuth } from '../auth/tokens.js';
import { closeStreams, type AppContext } from '../context.js';
import { checkVerifier } from '../crypto.js';
import { transaction } from '../db.js';
import { errors } from '../errors.js';
import {
  authHashSchema,
  displayNameSchema,
  kdfSchema,
  parse,
  recoverySchema,
  recordIdSchema,
  wrappedKeySchema,
} from '../validation.js';
import { credentialsFrom, recoveryFrom } from './auth.js';
import type { UserRow } from '../store.js';

const patchBody = z.object({ displayName: displayNameSchema });
const passwordBody = z.object({
  currentAuthHash: authHashSchema,
  kdf: kdfSchema,
  authHash: authHashSchema,
  wrappedVaultKey: wrappedKeySchema,
});
const recoveryBody = z.object({ currentAuthHash: authHashSchema, recovery: recoverySchema });
const deleteBody = z.object({ currentAuthHash: authHashSchema });

export function accountRoutes(app: FastifyInstance, ctx: AppContext): void {
  const auth = { onRequest: authenticate(ctx) };

  const loadUser = (userId: string): UserRow => {
    const user = ctx.store.userById(userId);
    if (!user) throw errors.unauthorized();
    return user;
  };

  const verifyCurrent = async (user: UserRow, currentAuthHash: Buffer) => {
    const limits = ctx.config.rateLimits;
    const key = `account:verify:${user.id}`;
    const retry = ctx.limiter.check(key, limits.authEmail);
    if (retry > 0) throw errors.rateLimited(retry);
    if (!(await checkVerifier(currentAuthHash, user.authVerifier, user.authSalt))) {
      ctx.limiter.record(key, limits.authEmail);
      throw errors.invalidCredentials('Current password is incorrect.');
    }
  };

  app.get('/v1/account', auth, async (req) => {
    const user = loadUser(requireAuth(req).userId);
    return { user: ctx.store.publicUser(user) };
  });

  app.patch('/v1/account', auth, async (req) => {
    const { userId } = requireAuth(req);
    const body = parse(patchBody, req.body);
    loadUser(userId);
    ctx.store.setDisplayName(userId, body.displayName);
    return { user: ctx.store.publicUser(loadUser(userId)) };
  });

  app.post('/v1/account/password', auth, async (req) => {
    const { userId, sessionId } = requireAuth(req);
    const body = parse(passwordBody, req.body);
    const user = loadUser(userId);
    await verifyCurrent(user, body.currentAuthHash);
    const credentials = await credentialsFrom(body.kdf, body.authHash, body.wrappedVaultKey);
    const current = ctx.store.sessionById(sessionId);
    transaction(ctx.db, () => {
      ctx.store.setCredentials(userId, credentials);
      ctx.store.revokeAllSessions(userId);
    });
    closeStreams(ctx, (s) => s.userId === userId);
    const device = {
      name: current?.deviceName ?? 'Unknown device',
      platform: (current?.platform ?? 'other') as 'android' | 'web' | 'other',
    };
    const { session, refreshToken } = ctx.store.createSession(userId, device, req.ip ?? null);
    return { tokens: issueTokens(ctx, session, refreshToken) };
  });

  app.post('/v1/account/recovery', auth, async (req, reply) => {
    const { userId } = requireAuth(req);
    const body = parse(recoveryBody, req.body);
    const user = loadUser(userId);
    await verifyCurrent(user, body.currentAuthHash);
    ctx.store.setRecovery(userId, await recoveryFrom(body.recovery));
    reply.code(204).send();
  });

  app.delete('/v1/account', auth, async (req, reply) => {
    const { userId } = requireAuth(req);
    const body = parse(deleteBody, req.body);
    const user = loadUser(userId);
    await verifyCurrent(user, body.currentAuthHash);
    ctx.store.deleteUser(userId);
    closeStreams(ctx, (s) => s.userId === userId);
    await ctx.blobs.deleteAll(userId);
    req.log.info({ userId }, 'account deleted');
    reply.code(204).send();
  });

  // ----- sessions --------------------------------------------------------------

  app.get('/v1/sessions', auth, async (req) => {
    const { userId, sessionId } = requireAuth(req);
    return {
      sessions: ctx.store.activeSessions(userId).map((s) => ({
        id: s.id,
        deviceName: s.deviceName,
        platform: s.platform,
        createdAt: s.createdAt,
        lastSeenAt: s.lastSeenAt,
        ip: s.ip,
        current: s.id === sessionId,
      })),
    };
  });

  app.delete('/v1/sessions/:id', auth, async (req, reply) => {
    const { userId, sessionId } = requireAuth(req);
    const { id } = parse(z.object({ id: recordIdSchema }), req.params);
    if (id === sessionId) throw errors.invalid('id: use POST /v1/auth/logout to end the current session');
    const target = ctx.store.sessionById(id);
    if (!target || target.userId !== userId || !ctx.store.isSessionLive(target)) throw errors.notFound('Session not found.');
    ctx.store.revokeSession(id);
    closeStreams(ctx, (s) => s.sessionId === id);
    reply.code(204).send();
  });

  app.delete('/v1/sessions', auth, async (req, reply) => {
    const { userId, sessionId } = requireAuth(req);
    ctx.store.revokeAllSessions(userId, sessionId);
    closeStreams(ctx, (s) => s.userId === userId && s.sessionId !== sessionId);
    reply.code(204).send();
  });
}
