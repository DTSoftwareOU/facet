import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';
import { createHandler, mimeFor, resolveRequestPath } from '../src/protocol';
import { Secrets, type SafeStorageLike } from '../src/secrets';
import { escapeCmdArgument, StdioServers, windowsCommandLine } from '../src/stdio';
import { OAuthLoopback } from '../src/oauth';

describe('facet:// protocol', () => {
  const root = path.resolve('renderer-root');
  it('maps request URLs into the renderer folder', () => {
    assert.equal(resolveRequestPath(root, 'facet://app/index.html'), path.join(root, 'index.html'));
    assert.equal(resolveRequestPath(root, 'facet://app/'), path.join(root, 'index.html'));
    assert.equal(resolveRequestPath(root, 'facet://app/assets/a%20b.js'), path.join(root, 'assets', 'a b.js'));
  });

  it('blocks traversal, other hosts and malformed URLs', () => {
    assert.equal(resolveRequestPath(root, 'facet://app/..%2f..%2fsecret.txt'), null);
    // The URL parser resolves encoded dot segments itself: this stays inside the root.
    assert.equal(resolveRequestPath(root, 'facet://app/%2e%2e/%2e%2e/secret.txt'), path.join(root, 'secret.txt'));
    assert.equal(resolveRequestPath(root, 'facet://app/..%5c..%5csecret.txt'), process.platform === 'win32' ? null : path.join(root, '..\\..\\secret.txt'));
    assert.equal(resolveRequestPath(root, 'facet://app/C:%5cWindows%5cwin.ini'), process.platform === 'win32' ? null : path.join(root, 'C:\\Windows\\win.ini'));
    assert.equal(resolveRequestPath(root, 'facet://other/index.html'), null);
    assert.equal(resolveRequestPath(root, 'facet://app/%E0%A4%A'), null);
    assert.equal(resolveRequestPath(root, 'facet://app/a%00b'), null);
  });

  it('serves MIME types, SPA fallback and 404s', async () => {
    assert.equal(mimeFor('a/b.JS'), 'text/javascript; charset=utf-8');
    assert.equal(mimeFor('x.wasm'), 'application/wasm');
    const handler = createHandler(path.join(os.tmpdir(), 'facet-no-renderer-here'));
    const page = await handler(new Request('facet://app/chats/123'));
    assert.equal(page.status, 200);
    assert.match(page.headers.get('content-security-policy') ?? '', /default-src 'self'/);
    assert.match(await page.text(), /isn't built yet/);
    const asset = await handler(new Request('facet://app/assets/missing.js'));
    assert.equal(asset.status, 404);
  });
});

describe('secrets', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'facet-secrets-'));
  after(() => rmSync(dir, { recursive: true, force: true }));

  it('uses OS encryption when available (d1)', async () => {
    const fake: SafeStorageLike = {
      isEncryptionAvailable: () => true,
      encryptString: (s) => Buffer.from(`enc:${s}`),
      decryptString: (b) => b.toString().slice(4),
    };
    const s = new Secrets(fake, dir);
    const sealed = await s.seal('aGVsbG8=');
    assert.ok(sealed.startsWith('d1:'));
    assert.equal(await s.open(sealed), 'aGVsbG8=');
  });

  it('falls back to AES-GCM with a local key (d0)', async () => {
    const none: SafeStorageLike = {
      isEncryptionAvailable: () => false,
      encryptString: () => {
        throw new Error('unavailable');
      },
      decryptString: () => {
        throw new Error('unavailable');
      },
    };
    const s = new Secrets(none, dir);
    const sealed = await s.seal('c2VjcmV0');
    assert.ok(sealed.startsWith('d0:'));
    assert.equal(await s.open(sealed), 'c2VjcmV0');
    // A second instance reads the same key from disk.
    assert.equal(await new Secrets(none, dir).open(sealed), 'c2VjcmV0');
    // Tampering is detected.
    const raw = Buffer.from(sealed.slice(3), 'base64');
    raw[raw.length - 1] ^= 1;
    await assert.rejects(s.open(`d0:${raw.toString('base64')}`));
    await assert.rejects(s.open('x9:abc'), /Unknown secret format/);
  });
});

describe('stdio command lines (cmd.exe escaping)', () => {
  it('passes whole command lines through', () => {
    assert.equal(windowsCommandLine({ command: 'npx -y @modelcontextprotocol/server-everything', args: [] }), 'npx -y @modelcontextprotocol/server-everything');
  });

  it('quotes program paths with spaces', () => {
    assert.equal(windowsCommandLine({ command: 'C:\\Program Files\\nodejs\\node.exe', args: ['x'] }), '"C:\\Program Files\\nodejs\\node.exe" ^"x^"');
    assert.equal(windowsCommandLine({ command: '"C:\\Program Files\\nodejs\\node.exe"', args: [] }), '"C:\\Program Files\\nodejs\\node.exe"');
  });

  it('quotes and escapes arguments', () => {
    assert.equal(escapeCmdArgument('simple'), '^"simple^"');
    assert.equal(escapeCmdArgument('C:\\My Folder\\'), '^"C:\\My^ Folder\\\\^"');
    assert.equal(escapeCmdArgument('a"b'), '^"a\\^"b^"');
    assert.equal(escapeCmdArgument('100%'), '^"100^%^"');
    assert.equal(
      windowsCommandLine({ command: 'npx', args: ['-y', '@scope/server', 'C:\\Users\\me\\My Docs'] }),
      'npx ^"-y^" ^"@scope/server^" ^"C:\\Users\\me\\My^ Docs^"',
    );
  });
});

describe('OAuth loopback', () => {
  it('receives the redirect and answers the browser', async () => {
    let page: Promise<string> = Promise.resolve('');
    let focused = false;
    const loop = new OAuthLoopback(
      async (url) => {
        assert.equal(url, 'https://auth.example.com/authorize?client_id=x');
        // Play the browser: follow the redirect to the loopback server.
        const uri = await loop.redirectUri();
        page = fetch(`${uri}?code=abc&state=xyz`).then((r) => r.text());
      },
      () => (focused = true),
    );
    const uri = await loop.redirectUri();
    assert.match(uri, /^http:\/\/127\.0\.0\.1:3341[89]\/callback$/);
    const result = await loop.authorize('https://auth.example.com/authorize?client_id=x', uri);
    assert.equal(result, `${uri}?code=abc&state=xyz`);
    assert.match(await page, /You're signed in/);
    assert.equal(focused, true);
  });

  it('rejects foreign redirect URIs and can be cancelled', async () => {
    const loop = new OAuthLoopback(async () => {}, () => {});
    await assert.rejects(loop.authorize('https://a.example/auth', 'http://evil.example/cb'), /redirect URI/);
    await assert.rejects(loop.authorize('file:///c:/x', await loop.redirectUri()), /http\(s\)/);
    const p = loop.authorize('https://a.example/auth', await loop.redirectUri());
    setTimeout(() => loop.cancel(), 100);
    await assert.rejects(p, /cancelled/);
  });
});

describe('stdio servers', () => {
  it('exchanges newline-delimited messages and reports exit', async () => {
    const messages: string[] = [];
    let exit: { code: number | null; stderr: string } | null = null;
    let gotExit: () => void = () => {};
    const exited = new Promise<void>((r) => (gotExit = r));
    const servers = new StdioServers(() => ({
      message: (_h, m) => messages.push(m),
      exit: (_h, code, stderr) => {
        exit = { code, stderr };
        gotExit();
      },
    }));
    // The node path may contain spaces (C:\Program Files\nodejs\node.exe): it must survive cmd.exe.
    const script =
      "process.stdout.write(JSON.stringify({ argv: process.argv.slice(1) }) + '\\n'); process.stdin.setEncoding('utf8'); let b=''; " +
      "process.stdin.on('data', (d) => { b += d; let i; while ((i = b.indexOf('\\n')) >= 0) { const line = b.slice(0, i); b = b.slice(i + 1); " +
      "const m = JSON.parse(line); if (m.method === 'quit') { console.error('bye'); process.exit(7); } " +
      "process.stdout.write(JSON.stringify({ id: m.id, echo: m.params }) + '\\r\\n'); } });";
    const odd = 'C:\\My Folder\\ a "b" & c %PATH% ^ <d> (e)';
    const h = servers.spawn({ command: process.execPath, args: ['-e', script, odd, 'plain'] }, 1);
    servers.send(h, JSON.stringify({ id: 1, method: 'echo', params: { s: 'a "b" & c %PATH% ^ <d>' } }));
    servers.send(h, JSON.stringify({ id: 2, method: 'echo', params: 'π' }));
    for (let i = 0; i < 100 && messages.length < 3; i++) await new Promise((r) => setTimeout(r, 50));
    assert.deepEqual(messages.map((m) => JSON.parse(m)), [
      { argv: [odd, 'plain'] },
      { id: 1, echo: { s: 'a "b" & c %PATH% ^ <d>' } },
      { id: 2, echo: 'π' },
    ]);
    servers.send(h, JSON.stringify({ id: 3, method: 'quit' }));
    await exited;
    assert.deepEqual(exit, { code: 7, stderr: 'bye\n' });
    assert.throws(() => servers.send(h, '{}'), /not running/);
  });

  it('reports a command that cannot start', async () => {
    let exit: { code: number | null; stderr: string } | null = null;
    let done: () => void = () => {};
    const exited = new Promise<void>((r) => (done = r));
    const servers = new StdioServers(() => ({
      message: () => {},
      exit: (_h, code, stderr) => {
        exit = { code, stderr };
        done();
      },
    }));
    servers.spawn({ command: 'facet-no-such-command-xyz', args: ['--stdio'] }, 1);
    await exited;
    assert.notEqual(exit!.code, 0);
    assert.ok(exit!.stderr.length > 0);
  });
});
