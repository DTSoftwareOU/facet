// Writes a consistent snapshot of the database: node dist/backup.js <destination.db>
import './warnings.js';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { openDb } from './db.js';

const dest = process.argv[2];
if (!dest) {
  console.error('usage: node dist/backup.js <destination.db>');
  process.exit(2);
}
if (existsSync(dest)) {
  console.error(`refusing to overwrite ${dest}`);
  process.exit(2);
}
const db = openDb(path.resolve(process.env.DATA_DIR || 'data'));
db.exec(`VACUUM INTO '${path.resolve(dest).replace(/'/g, "''")}'`);
db.close();
console.log(`backup written to ${dest}`);
