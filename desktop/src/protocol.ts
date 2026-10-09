/**
 * The `facet://app/` scheme: serves the renderer (the web app built into desktop/renderer) from a
 * stable, secure origin so IndexedDB, localStorage, crypto.subtle and fetch behave like on the web.
 */
import { promises as fsp } from 'node:fs';
import path from 'node:path';

export const SCHEME = 'facet';
export const APP_ORIGIN = 'facet://app';
export const APP_URL = `${APP_ORIGIN}/index.html`;

export const CSP =
  "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob: https:; " +
  "media-src 'self' data: blob:; font-src 'self' data:; connect-src * data: blob:; frame-src 'none'; " +
  "object-src 'none'; base-uri 'none'";

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.cjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.xml': 'application/xml; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.ico': 'image/x-icon',
  '.bmp': 'image/bmp',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.eot': 'application/vnd.ms-fontobject',
  '.wasm': 'application/wasm',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.ogg': 'audio/ogg',
  '.oga': 'audio/ogg',
  '.m4a': 'audio/mp4',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.pdf': 'application/pdf',
};

export function mimeFor(file: string): string {
  return MIME[path.extname(file).toLowerCase()] ?? 'application/octet-stream';
}

/**
 * Maps a request URL to a file inside [root], or null when it would leave [root] (path traversal),
 * isn't for the app host, or is malformed.
 */
export function resolveRequestPath(root: string, requestUrl: string): string | null {
  let url: URL;
  try {
    url = new URL(requestUrl);
  } catch {
    return null;
  }
  if (url.protocol !== `${SCHEME}:` || url.host !== 'app') return null;
  let pathname: string;
  try {
    pathname = decodeURIComponent(url.pathname);
  } catch {
    return null;
  }
  if (pathname.includes('\0')) return null;
  const rootAbs = path.resolve(root);
  const rel = pathname.replace(/^[/\\]+/, '') || 'index.html';
  const file = path.resolve(rootAbs, rel);
  if (file !== rootAbs && !file.startsWith(rootAbs + path.sep)) return null;
  return file;
}

const FALLBACK_HTML = `<!doctype html><html><head><meta charset="utf-8"><title>Facet</title>
<style>body{margin:0;min-height:100vh;display:grid;place-items:center;background:#11151B;color:#F4F7FB;font:15px/1.5 "Segoe UI",system-ui,sans-serif}
main{max-width:460px;padding:24px}code{background:#1C2431;padding:2px 6px;border-radius:4px}</style></head>
<body><main><h1>The app isn't built yet</h1><p>Run <code>npm run build:renderer</code> in <code>desktop/</code> (or <code>npm run build:desktop</code> in <code>client/</code>), then reload.</p></main></body></html>`;

function respond(body: string | Uint8Array, status: number, type: string): Response {
  return new Response(body, {
    status,
    headers: {
      'content-type': type,
      'content-security-policy': CSP,
      'x-content-type-options': 'nosniff',
      'cache-control': 'no-cache',
    },
  });
}

/** The protocol handler: files from [root], index.html for unknown app routes, 404 for missing assets. */
export function createHandler(root: string): (request: Request) => Promise<Response> {
  return async (request) => {
    if (request.method !== 'GET' && request.method !== 'HEAD') return respond('Method not allowed', 405, 'text/plain');
    const file = resolveRequestPath(root, request.url);
    if (!file) return respond('Not found', 404, 'text/plain');
    try {
      const st = await fsp.stat(file);
      if (st.isFile()) return respond(new Uint8Array(await fsp.readFile(file)), 200, mimeFor(file));
    } catch {
      /* fall through */
    }
    // Missing: app routes (no extension, or .html) get index.html; missing assets are 404s.
    const ext = path.extname(file).toLowerCase();
    if (ext === '' || ext === '.html') {
      try {
        return respond(new Uint8Array(await fsp.readFile(path.join(root, 'index.html'))), 200, MIME['.html']);
      } catch {
        return respond(FALLBACK_HTML, 200, MIME['.html']);
      }
    }
    return respond('Not found', 404, 'text/plain');
  };
}
