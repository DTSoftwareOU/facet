import { createReadStream } from 'node:fs';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { authenticate, requireAuth } from '../auth/tokens.js';
import type { AppContext } from '../context.js';
import { errors } from '../errors.js';
import { parse, recordIdSchema } from '../validation.js';

const params = z.object({ id: recordIdSchema });

export function blobRoutes(app: FastifyInstance, ctx: AppContext): void {
  const auth = authenticate(ctx);

  app.put(
    '/v1/blobs/:id',
    // Authenticate before the (potentially large) body is read.
    { onRequest: auth, bodyLimit: ctx.config.limits.maxBlobBytes },
    async (req, reply) => {
      const { userId } = requireAuth(req);
      const { id } = parse(params, req.params);
      if (!Buffer.isBuffer(req.body)) throw errors.invalid('body: send the blob as application/octet-stream');
      const result = await ctx.blobs.put(userId, id, req.body);
      reply.code(201);
      return result;
    },
  );

  app.get('/v1/blobs/:id', { onRequest: auth }, async (req, reply) => {
    const { userId } = requireAuth(req);
    const { id } = parse(params, req.params);
    const found = await ctx.blobs.locate(userId, id);
    if (!found) throw errors.notFound('Blob not found.');
    reply
      .header('Content-Type', 'application/octet-stream')
      .header('Content-Length', String(found.size))
      .header('Cache-Control', 'private, no-cache');
    return reply.send(createReadStream(found.path));
  });

  app.delete('/v1/blobs/:id', { onRequest: auth }, async (req, reply) => {
    const { userId } = requireAuth(req);
    const { id } = parse(params, req.params);
    await ctx.blobs.delete(userId, id);
    reply.code(204).send();
  });
}
