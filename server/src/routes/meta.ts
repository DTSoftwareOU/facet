import type { FastifyInstance } from 'fastify';
import type { AppContext } from '../context.js';

export function metaRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.get('/v1/health', async () => {
    ctx.db.prepare('SELECT 1').get();
    return { ok: true };
  });

  app.get('/v1/meta', async () => ({
    name: 'Facet Sync',
    version: ctx.config.version,
    registrationOpen: ctx.config.registrationOpen,
    emailEnabled: ctx.mailer !== null,
    limits: {
      maxRecordBytes: ctx.config.limits.maxRecordBytes,
      maxBatchRecords: ctx.config.limits.maxBatchRecords,
      maxBlobBytes: ctx.config.limits.maxBlobBytes,
    },
  }));
}
