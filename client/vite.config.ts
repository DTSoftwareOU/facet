import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';

/**
 * Release builds get a strict Content-Security-Policy: no inline or remote scripts. Requests may
 * go anywhere (connect-src *) because each user brings their own providers and MCP servers.
 * The dev server needs inline scripts for hot reload, so it runs without it.
 */
const CSP =
  "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob: https:; " +
  "media-src 'self' data: blob:; font-src 'self' data:; connect-src * data: blob:; frame-src 'none'; object-src 'none'; " +
  "base-uri 'self'; form-action 'none'";

function csp(): Plugin {
  return {
    name: 'facet-csp',
    apply: 'build',
    transformIndexHtml: (html) => html.replace('<meta charset="UTF-8" />', `<meta charset="UTF-8" />
    <meta http-equiv="Content-Security-Policy" content="${CSP}" />`),
  };
}

// One codebase, two builds: the website (served at /app/ on the sync server's host) and the
// renderer of the Windows app (loaded from disk by Electron, so asset paths are relative).
export default defineConfig(({ mode }) => ({
  base: mode === 'desktop' ? './' : '/app/',
  plugins: [react(), csp()],
  define: {
    __FACET_PLATFORM__: JSON.stringify(mode === 'desktop' ? 'desktop' : 'web'),
    __FACET_VERSION__: JSON.stringify(process.env.npm_package_version ?? '1.0.0'),
  },
  build: {
    outDir: mode === 'desktop' ? '../desktop/renderer' : 'dist',
    emptyOutDir: true,
    target: 'es2022',
    sourcemap: false,
    chunkSizeWarningLimit: 900,
  },
  server: {
    port: 5173,
    proxy: {
      // Dev: talk to a local sync server on the same origin, like production.
      '/v1': { target: process.env.FACET_SYNC_URL ?? 'http://127.0.0.1:8788', changeOrigin: true },
    },
  },
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts', 'src/**/*.test.ts'],
    setupFiles: ['test/setup.ts'],
    testTimeout: 30000,
  },
}));
