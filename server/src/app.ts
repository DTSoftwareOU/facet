import Fastify, { type FastifyError, type FastifyInstance } from 'fastify';
import { BlobStore } from './blobs.js';
import type { Config } from './config.js';
import type { AppContext } from './context.js';
import { openDb } from './db.js';
import { ApiError, errors } from './errors.js';
import { ChangeBus } from './events.js';
import { createSmtpMailer, type Mailer } from './mail.js';
import { RateLimiter } from './ratelimit.js';
import { RecordStore } from './records.js';
import { accountRoutes } from './routes/account.js';
import { authRoutes } from './routes/auth.js';
import { blobRoutes } from './routes/blobs.js';
import { relayRoutes } from './routes/relay.js';
import { metaRoutes } from './routes/meta.js';
import { syncRoutes } from './routes/sync.js';
import { Store } from './store.js';

export interface BuildOptions {
  /** Override the mailer (tests). `null` disables email even if SMTP_URL is set. */
  mailer?: Mailer | null;
}

const HOUSEKEEPING_INTERVAL_MS = 6 * 60 * 60 * 1000;

export function buildApp(config: Config, options: BuildOptions = {}): { app: FastifyInstance; ctx: AppContext } {
  const db = openDb(config.dataDir);
  const mailer =
    options.mailer !== undefined ? options.mailer : config.smtpUrl ? createSmtpMailer(config.smtpUrl, config.smtpFrom) : null;

  const ctx: AppContext = {
    config,
    db,
    store: new Store(db, config),
    records: new RecordStore(db, config.quotaBytes),
    blobs: new BlobStore(db, config.dataDir, config.quotaBytes, config.limits.maxBlobBytes),
    bus: new ChangeBus(),
    limiter: new RateLimiter(),
    mailer,
    streams: new Set(),
  };

  const app = Fastify({
    logger: config.logger
      ? {
          level: config.logLevel,
          redact: { paths: ['req.headers.authorization', 'req.headers.cookie'], remove: true },
        }
      : false,
    // Trust a fixed number of proxy hops (not `true`), so clients can't spoof their IP by
    // prepending X-Forwarded-For entries.
    trustProxy: config.trustProxy > 0 ? (_address: string, hop: number) => hop < config.trustProxy : false,
    bodyLimit: 1024 * 1024,
  });

  app.decorateRequest('auth', null);

  // Lenient JSON: an empty body with a JSON content type is treated as {}.
  app.removeContentTypeParser('application/json');
  app.addContentTypeParser('application/json', { parseAs: 'string' }, (_req, body, done) => {
    const text = (body as string).trim();
    if (text === '') {
      done(null, {});
      return;
    }
    try {
      done(null, JSON.parse(text));
    } catch {
      done(errors.invalid('body: malformed JSON'), undefined);
    }
  });
  app.addContentTypeParser('application/octet-stream', { parseAs: 'buffer' }, (_req, body, done) => done(null, body));

  app.setErrorHandler((err: FastifyError | ApiError, req, reply) => {
    if (err instanceof ApiError) {
      reply.code(err.status).headers(err.headers).send({ error: { code: err.code, message: err.message } });
      return;
    }
    const status = err.statusCode;
    if (status === 413 || err.code === 'FST_ERR_CTP_BODY_TOO_LARGE') {
      reply.code(413).send({ error: { code: 'too_large', message: 'Request body is too large.' } });
      return;
    }
    if (err.code === 'FST_ERR_CTP_INVALID_MEDIA_TYPE') {
      reply.code(400).send({ error: { code: 'invalid_request', message: 'Unsupported Content-Type.' } });
      return;
    }
    if (typeof status === 'number' && status >= 400 && status < 500) {
      reply.code(400).send({ error: { code: 'invalid_request', message: err.message } });
      return;
    }
    req.log.error({ err }, 'unhandled error');
    reply.code(500).send({ error: { code: 'internal', message: 'Something went wrong on the server.' } });
  });

  app.setNotFoundHandler((req, reply) => {
    reply.code(404).send({ error: { code: 'not_found', message: `No route for ${req.method} ${req.url.split('?')[0]}` } });
  });

  app.addHook('onSend', async (_req, reply, payload) => {
    if (!reply.hasHeader('Cache-Control')) reply.header('Cache-Control', 'no-store');
    return payload;
  });

  metaRoutes(app, ctx);
  authRoutes(app, ctx);
  accountRoutes(app, ctx);
  syncRoutes(app, ctx);
  blobRoutes(app, ctx);
  relayRoutes(app, ctx);

  const runHousekeeping = () => {
    try {
      const result = ctx.store.housekeeping();
      if (result.sessions || result.tokens || result.tombstones) app.log.info(result, 'housekeeping');
    } catch (err) {
      app.log.error({ err }, 'housekeeping failed');
    }
  };
  const timer = setInterval(runHousekeeping, HOUSEKEEPING_INTERVAL_MS);
  timer.unref();
  app.addHook('onReady', async () => runHousekeeping());

  // SSE responses are hijacked and would keep the server open forever.
  app.addHook('preClose', async () => {
    for (const s of [...ctx.streams]) s.close();
  });
  app.addHook('onClose', async () => {
    clearInterval(timer);
    ctx.limiter.close();
    ctx.mailer?.close?.();
    db.close();
  });

  return { app, ctx };
}
