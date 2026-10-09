import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { authenticate, requireAuth } from '../auth/tokens.js';
import type { AppContext, OpenStream } from '../context.js';
import { errors } from '../errors.js';
import type { RecordIn } from '../records.js';
import { decodeB64, parse, recordIdSchema, recordTypeSchema } from '../validation.js';

const MIN_ENVELOPE_BYTES = 1 + 1 + 12 + 16;

const recordSchema = z.object({
  id: recordIdSchema,
  type: recordTypeSchema,
  updatedAt: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  deleted: z.boolean(),
  ct: z.string().nullable().optional(),
});

const pullQuery = z.object({
  since: z.coerce.number().int().min(0).max(Number.MAX_SAFE_INTEGER).default(0),
  limit: z.coerce.number().int().min(1).optional(),
});

export function syncRoutes(app: FastifyInstance, ctx: AppContext): void {
  const { limits } = ctx.config;

  app.post(
    '/v1/sync/push',
    { onRequest: authenticate(ctx), bodyLimit: limits.maxBatchBodyBytes },
    async (req) => {
      const { userId } = requireAuth(req);
      const { records: raw } = parse(z.object({ records: z.array(z.unknown()) }), req.body);
      if (raw.length > limits.maxBatchRecords) {
        throw errors.tooLarge(`A push may contain at most ${limits.maxBatchRecords} records.`);
      }
      const records: RecordIn[] = raw.map((item, index) => {
        const r = parse(recordSchema, item, `records.${index}`);
        let ct: Buffer | null = null;
        if (r.ct != null) {
          const bytes = decodeB64(r.ct);
          if (!bytes) throw errors.invalid(`records.${index}.ct: must be base64`);
          if (bytes.length > limits.maxRecordBytes) {
            throw errors.tooLarge(`records.${index}.ct: exceeds ${limits.maxRecordBytes} bytes`);
          }
          if (bytes.length < MIN_ENVELOPE_BYTES || bytes[0] !== 0x01) {
            throw errors.invalid(`records.${index}.ct: not a version 1 envelope`);
          }
          ct = bytes;
        } else if (!r.deleted) {
          throw errors.invalid(`records.${index}.ct: required unless deleted`);
        }
        return { id: r.id, type: r.type, updatedAt: r.updatedAt, deleted: r.deleted, ct };
      });

      const result = ctx.records.push(userId, records);
      if (result.changed) ctx.bus.publish(userId, result.cursor);
      return { accepted: result.accepted, rejected: result.rejected, cursor: result.cursor };
    },
  );

  app.get('/v1/sync/pull', { onRequest: authenticate(ctx) }, async (req) => {
    const { userId } = requireAuth(req);
    const q = parse(pullQuery, req.query);
    const limit = Math.min(q.limit ?? limits.defaultPullLimit, limits.maxPullLimit);
    return ctx.records.pull(userId, q.since, limit);
  });

  app.get('/v1/sync/stream', { onRequest: authenticate(ctx) }, async (req, reply) => {
    const { userId, sessionId } = requireAuth(req);
    reply.hijack();
    const res = reply.raw;
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.flushHeaders();
    req.raw.socket.setNoDelay(true);
    req.raw.socket.setKeepAlive(true);

    let closed = false;
    const write = (chunk: string) => {
      if (!closed && !res.writableEnded) res.write(chunk);
    };

    const unsubscribe = ctx.bus.subscribe(userId, (cursor) => {
      write(`event: changed\ndata: ${JSON.stringify({ cursor })}\n\n`);
    });
    const ping = setInterval(() => {
      const session = ctx.store.sessionById(sessionId);
      if (!session || !ctx.store.isSessionLive(session)) {
        stream.close();
        return;
      }
      write(': ping\n\n');
    }, ctx.config.ssePingMs);

    const cleanup = () => {
      if (closed) return;
      closed = true;
      clearInterval(ping);
      unsubscribe();
      ctx.streams.delete(stream);
    };
    const stream: OpenStream = {
      userId,
      sessionId,
      close() {
        cleanup();
        if (!res.writableEnded) res.end();
      },
    };
    ctx.streams.add(stream);
    req.raw.on('close', cleanup);
    res.on('close', cleanup);

    write(`event: ready\ndata: ${JSON.stringify({ cursor: ctx.records.cursor(userId) })}\n\n`);
  });
}
