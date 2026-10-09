import { beforeEach, describe, expect, it } from 'vitest';
import { McpClient } from '../../src/mcp/client';
import { McpException, type McpServerConfig } from '../../src/mcp/types';
import { FakeNet, FakeStdio, installPlatform, mcpBehavior, sleep } from './fakes';

const config = (over: Partial<McpServerConfig> = {}): McpServerConfig => ({
  id: 'local',
  name: 'Files',
  url: '',
  authMode: 'NONE',
  headers: { TOKEN: 'abc' },
  stdio: { command: 'npx', args: ['-y', '@modelcontextprotocol/server-filesystem', 'C:\\Users\\me'], cwd: 'C:\\work' },
  ...over,
});

async function rejects(p: Promise<unknown>): Promise<Error> {
  try {
    await p;
  } catch (e) {
    return e as Error;
  }
  throw new Error('expected a rejection');
}

let net: FakeNet;
let stdio: FakeStdio;

beforeEach(() => {
  net = new FakeNet();
  stdio = new FakeStdio();
  installPlatform(net, { stdio });
});

describe('stdio transport', () => {
  it('spawns the command with its environment and runs the same MCP flow', async () => {
    const client = new McpClient(config());
    const info = await client.connect();
    expect(info).toEqual({ name: 'local-fs', version: '0.1.0', protocolVersion: '2025-06-18', instructions: 'Local tools.' });
    expect(stdio.processes).toHaveLength(1);
    const proc = stdio.processes[0];
    expect(proc.spec).toEqual({ command: 'npx', args: ['-y', '@modelcontextprotocol/server-filesystem', 'C:\\Users\\me'], env: { TOKEN: 'abc' }, cwd: 'C:\\work' });
    expect(proc.received.map((m) => m.method)).toEqual(['initialize', 'notifications/initialized']);
    expect(proc.received[0].params.clientInfo.name).toBe('Facet');

    const tools = await client.listTools();
    expect(tools.map((t) => t.name)).toEqual(['read_file', 'write_file']);
    expect(tools[0].readOnlyHint).toBe(true);

    const r = await client.callTool('read_file', '{"path":"a.txt"}');
    expect(r.text).toBe('read_file in C:\\work with TOKEN=abc');
    await sleep(5);
    // The server's ping was answered on stdin; no HTTP was used.
    expect(proc.received.some((m) => m.id === 'srv-ping' && m.result && typeof m.result === 'object')).toBe(true);
    expect(net.requests).toHaveLength(0);
    client.close();
    expect(stdio.killed).toEqual(['h1']);
  });

  it('restarts a server that exited and retries the call', async () => {
    const client = new McpClient(config());
    await client.connect();
    stdio.processes[0].exit(1, 'crashed');
    const r = await client.callTool('read_file', '{}');
    expect(r.text).toContain('read_file');
    expect(stdio.processes).toHaveLength(2);
    client.close();
  });

  it('restarts when the process dies while a call is running', async () => {
    let calls = 0;
    const normal = mcpBehavior();
    stdio.behavior = (proc, msg) => {
      if (msg.method === 'tools/call' && calls++ === 0) {
        proc.exit(137, 'killed');
        return;
      }
      normal(proc, msg);
    };
    const client = new McpClient(config());
    const r = await client.callTool('read_file', '{}');
    expect(r.text).toContain('read_file');
    expect(stdio.processes).toHaveLength(2);
    client.close();
  });

  it('shows the exit code and stderr when the server stops before it is ready', async () => {
    stdio.behavior = (proc) => proc.exit(1, "npm ERR! 404 Not Found\nnpm ERR! '@nope/server' is not in this registry.");
    const e = await rejects(new McpClient(config({ name: 'Nope' })).connect());
    expect(e).toBeInstanceOf(McpException);
    expect(e.message).toContain('Nope stopped before it was ready (exit code 1:');
    expect(e.message).toContain('is not in this registry');
    expect(e.message).toContain('Check the command and its settings.');
  });

  it('reports a command that could not start', async () => {
    stdio.spawn = async () => {
      throw new Error('spawn npx ENOENT');
    };
    const e = await rejects(new McpClient(config()).connect());
    expect(e.message).toBe("Couldn't start Files: spawn npx ENOENT");
  });

  it('explains that local servers need the Windows app', async () => {
    installPlatform(net, { stdio: undefined });
    const e = await rejects(new McpClient(config()).connect());
    expect(e.message).toBe('Local servers run only in the Facet app for Windows.');
  });

  it('turns JSON-RPC errors into readable messages', async () => {
    const normal = mcpBehavior();
    stdio.behavior = (proc, msg) => {
      if (msg.method === 'tools/call') proc.emit({ jsonrpc: '2.0', id: msg.id, error: { code: -32602, message: 'No such file' } });
      else normal(proc, msg);
    };
    const client = new McpClient(config());
    const e = await rejects(client.callTool('read_file', '{}'));
    expect(e.message).toBe('Files: No such file (-32602)');
    client.close();
  });
});
