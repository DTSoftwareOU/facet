// Bundles the main process, the preload script and the grep worker into dist/ (CommonJS, Node).
// `--tests` also bundles test/*.test.ts into dist/test/ for `node --test`.
import { build } from 'esbuild';
import { readdirSync, readFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));
const withTests = process.argv.includes('--tests');

const common = {
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node22',
  external: ['electron', 'electron-updater'],
  define: { __FACET_APP_VERSION__: JSON.stringify(pkg.version) },
  logLevel: 'warning',
  legalComments: 'none',
};

await build({
  ...common,
  entryPoints: {
    main: path.join(root, 'src/main.ts'),
    preload: path.join(root, 'src/preload.ts'),
    'grep-worker': path.join(root, 'src/computer/grep-worker.ts'),
  },
  outdir: path.join(root, 'dist'),
});

if (withTests) {
  const testDir = path.join(root, 'test');
  const outdir = path.join(root, 'dist/test');
  rmSync(outdir, { recursive: true, force: true });
  const entries = readdirSync(testDir).filter((f) => f.endsWith('.test.ts'));
  await build({
    ...common,
    entryPoints: entries.map((f) => path.join(testDir, f)),
    outdir,
  });
}

console.log(`Built facet-desktop ${pkg.version}${withTests ? ' (with tests)' : ''}`);
