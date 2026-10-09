import './warnings.js';
import { existsSync } from 'node:fs';
import { buildApp } from './app.js';
import { loadConfig } from './config.js';

if (existsSync('.env')) process.loadEnvFile('.env');

const config = loadConfig();
const { app } = buildApp(config);

let shuttingDown = false;
async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  app.log.info({ signal }, 'shutting down');
  const force = setTimeout(() => {
    app.log.error('forced exit after timeout');
    process.exit(1);
  }, 10_000);
  force.unref();
  try {
    await app.close();
    process.exit(0);
  } catch (err) {
    app.log.error({ err }, 'error during shutdown');
    process.exit(1);
  }
}

process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));

try {
  await app.listen({ port: config.port, host: config.host });
  app.log.info(
    { version: config.version, dataDir: config.dataDir, registrationOpen: config.registrationOpen, email: Boolean(config.smtpUrl) },
    'Facet Sync ready',
  );
} catch (err) {
  app.log.error({ err }, 'failed to start');
  process.exit(1);
}
