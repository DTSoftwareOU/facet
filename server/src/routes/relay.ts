import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { authenticate, requireAuth } from '../auth/tokens.js';
import type { AppContext } from '../context.js';
import { errors } from '../errors.js';
import { decodeB64, parse, recordIdSchema } from '../validation.js';

/** version (1) + flags (1) + nonce (12) + GCM tag (16) */
const MIN_ENVELOPE_BYTES = 1 + 1 + 12 + 16;

const relayBody = z.object({ to: recordIdSchema, msg: z.string() });

/**
 * Forwards end-to-end encrypted messages between sessions of the same account (docs/REMOTE.md).
 * The server sees who talks to whom and when, never what: the payload is sealed with a key
 * derived from the vault key.
 */
export function relayRoutes(app: FastifyInstance, ctx: AppContext): void {
  const { limits, rateLimits } = ctx.config;
  const auth = { onRequest: authenticate(ctx) };

  app.get('/v1/relay/peers', auth, async (req) => {
    const { userId, sessionId } = requireAuth(req);
    const ids = new Set<string>();
    for (const s of ctx.streams) if (s.userId === userId && s.sessionId !== sessionId) ids.add(s.sessionId);
    const peers = [];
    for (const id of ids) {
      const session = ctx.store.sessionById(id);
      if (!session || session.userId !== userId || !ctx.store.isSessionLive(session)) continue;
      peers.push({ sessionId: id, deviceName: session.deviceName, platform: session.platform });
    }
    return { peers };
  });

  app.post(
    '/v1/relay',
    // base64 grows the envelope by a third; leave room for the JSON around it.
    { onRequest: authenticate(ctx), bodyLimit: Math.ceil((limits.maxRelayBytes * 4) / 3) + 4096 },
    async (req) => {
      const { userId, sessionId } = requireAuth(req);
      ctx.limiter.hit(`relay:${sessionId}`, rateLimits.relay);
      const body = parse(relayBody, req.body);
      const bytes = decodeB64(body.msg);
      if (!bytes) throw errors.invalid('msg: must be base64');
      if (bytes.length > limits.maxRelayBytes) throw errors.tooLarge(`msg: exceeds ${limits.maxRelayBytes} bytes`);
      if (bytes.length < MIN_ENVELOPE_BYTES || bytes[0] !== 0x01) throw errors.invalid('msg: not a version 1 relay envelope');
      if (body.to === sessionId) throw errors.invalid('to: a session can’t message itself');

      let delivered = 0;
      for (const s of [...ctx.streams]) {
        if (s.userId !== userId || s.sessionId !== body.to) continue;
        s.send('relay', { from: sessionId, msg: body.msg });
        delivered++;
      }
      if (delivered === 0) throw errors.peerOffline();
      return { delivered };
    },
  );
}
