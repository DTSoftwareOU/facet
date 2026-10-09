/**
 * OAuth sign-in for MCP servers with a loopback redirect (RFC 8252 §7.3): a one-shot HTTP server on
 * a fixed port receives the browser's redirect. The ports are fixed so the redirect URI can be
 * registered once (dynamic client registration stores it).
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';

export const OAUTH_PORTS = [33418, 33419];
const CALLBACK_PATH = '/callback';
const TIMEOUT_MS = 10 * 60 * 1000;

function uriFor(port: number): string {
  return `http://127.0.0.1:${port}${CALLBACK_PATH}`;
}

function portFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const srv = http.createServer();
    srv.once('error', () => resolve(false));
    srv.listen(port, '127.0.0.1', () => srv.close(() => resolve(true)));
  });
}

const PAGE = (title: string, text: string) => `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${title}</title>
<style>
  :root { color-scheme: dark; }
  body { margin: 0; min-height: 100vh; display: grid; place-items: center; background: #11151B; color: #F4F7FB;
         font: 16px/1.5 "Segoe UI", system-ui, -apple-system, sans-serif; }
  main { text-align: center; padding: 32px; max-width: 420px; }
  svg { width: 56px; height: 56px; margin-bottom: 16px; }
  h1 { font-size: 22px; font-weight: 600; margin: 0 0 8px; }
  p { margin: 0; color: #A9B4C4; }
</style></head>
<body><main>
<svg viewBox="0 0 100 100" aria-hidden="true">
  <polygon points="4,50 50,4 50,32 32,50" fill="#F2C66D"/><polygon points="50,4 96,50 68,50 50,32" fill="#6E9BFF"/>
  <polygon points="96,50 50,96 50,68 68,50" fill="#3A5BD9"/><polygon points="50,96 4,50 32,50 50,68" fill="#49D3C1"/>
  <polygon points="50,32 68,50 50,68 32,50" fill="#F4F7FB"/>
</svg>
<h1>${title}</h1><p>${text}</p>
</main></body></html>`;

interface Pending {
  server: http.Server;
  timer: NodeJS.Timeout;
  reject: (e: Error) => void;
}

export class OAuthLoopback {
  private pending: Pending | null = null;

  constructor(
    private readonly openBrowser: (url: string) => Promise<void>,
    private readonly onCallback: () => void,
  ) {}

  /** The first fixed port that is free right now. */
  async redirectUri(): Promise<string> {
    if (this.pending) {
      const addr = this.pending.server.address() as AddressInfo | null;
      if (addr) return uriFor(addr.port);
    }
    for (const port of OAUTH_PORTS) if (await portFree(port)) return uriFor(port);
    return uriFor(OAUTH_PORTS[0]);
  }

  cancel(reason = 'Sign-in was cancelled.'): void {
    const p = this.pending;
    if (!p) return;
    this.pending = null;
    clearTimeout(p.timer);
    p.server.close();
    p.server.closeAllConnections?.();
    p.reject(new Error(reason));
  }

  authorize(authUrl: string, redirectUri: string): Promise<string> {
    let auth: URL;
    let redirect: URL;
    try {
      auth = new URL(authUrl);
      redirect = new URL(redirectUri);
    } catch {
      return Promise.reject(new Error('Invalid sign-in address.'));
    }
    if (auth.protocol !== 'https:' && auth.protocol !== 'http:') return Promise.reject(new Error('The sign-in page must be an http(s) address.'));
    const port = Number(redirect.port);
    if (redirect.protocol !== 'http:' || redirect.hostname !== '127.0.0.1' || !OAUTH_PORTS.includes(port)) {
      return Promise.reject(new Error(`The redirect URI must be one from redirectUri() (${uriFor(OAUTH_PORTS[0])}).`));
    }
    this.cancel('Another sign-in started.');
    const path = redirect.pathname || CALLBACK_PATH;

    return new Promise<string>((resolve, reject) => {
      const server = http.createServer((req, res) => {
        const url = new URL(req.url ?? '/', `http://127.0.0.1:${port}`);
        if (req.method !== 'GET' || url.pathname !== path) {
          res.writeHead(404, { 'content-type': 'text/plain' }).end('Not found');
          return;
        }
        const failed = url.searchParams.has('error') || !url.searchParams.has('code');
        const html = failed
          ? PAGE("Sign-in didn't complete", 'You can close this tab and return to Facet.')
          : PAGE("You're signed in.", 'You can close this tab and return to Facet.');
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', connection: 'close' }).end(html);
        if (this.pending?.server !== server) return;
        this.pending = null;
        clearTimeout(timer);
        server.close();
        this.onCallback();
        resolve(`http://127.0.0.1:${port}${url.pathname}${url.search}`);
      });
      const timer = setTimeout(() => {
        if (this.pending?.server === server) this.cancel('Sign-in timed out after 10 minutes.');
      }, TIMEOUT_MS);
      this.pending = { server, timer, reject };
      server.once('error', (e: NodeJS.ErrnoException) => {
        if (this.pending?.server === server) {
          this.pending = null;
          clearTimeout(timer);
          reject(
            new Error(
              e.code === 'EADDRINUSE'
                ? `Port ${port} is in use by another program, so the sign-in redirect can't be received. Close that program and try again.`
                : `Couldn't wait for the sign-in redirect: ${e.message}`,
            ),
          );
        }
      });
      server.listen(port, '127.0.0.1', () => {
        this.openBrowser(auth.toString()).catch((e: Error) => this.cancel(`Couldn't open the browser: ${e.message}`));
      });
    });
  }
}
