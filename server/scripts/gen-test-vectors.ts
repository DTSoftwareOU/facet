// Regenerates docs/test-vectors.json: npm run vectors
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { buildVectors } from '../test/vectors.js';

const target = fileURLToPath(new URL('../../docs/test-vectors.json', import.meta.url));
writeFileSync(target, `${JSON.stringify(buildVectors(), null, 2)}\n`);
console.log(`wrote ${target}`);
