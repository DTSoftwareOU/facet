import { describe, expect, it } from 'vitest';
import { ConversationRepository, MessageTree } from '../src/data/conversations';
import { db } from '../src/data/db';
import { importAgentSession, resumeInstructions } from '../src/domain/resume';
import { defaultParams } from '../src/llm/types';
import { RemoteHub, type HostHandler, type RelayPeer, type RelayTransport } from '../src/remote/hub';
import { RemoteError, type RemoteMessage } from '../src/remote/protocol';
import { relayKey } from '../src/sync/relay';

/** An in-memory relay between hubs: the server's role, minus HTTP. */
class FakeRelay {
  readonly hubs = new Map<string, RemoteHub>();
  readonly names = new Map<string, string>();
  readonly sent: { from: string; to: string; msg: string }[] = [];
  private key = relayKey(new Uint8Array(32).fill(9));

  transport(me: string): RelayTransport {
    return {
      me: async () => me,
      key: () => this.key,
      send: async (to, msg) => {
        const target = this.hubs.get(to);
        if (!target) throw new RemoteError('offline', 'That device is offline.');
        this.sent.push({ from: me, to, msg });
        setTimeout(() => target.streamEvent('relay', JSON.stringify({ from: me, msg }), true), 0);
      },
      peers: async (): Promise<RelayPeer[]> =>
        [...this.hubs.keys()].filter((id) => id !== me).map((id) => ({ sessionId: id, deviceName: this.names.get(id) ?? id, platform: 'other' })),
    };
  }

  join(sessionId: string, name: string, handler?: (hub: RemoteHub) => HostHandler): RemoteHub {
    const hub = new RemoteHub(this.transport(sessionId));
    if (handler) hub.handler = handler(hub);
    this.hubs.set(sessionId, hub);
    this.names.set(sessionId, name);
    return hub;
  }

  leave(sessionId: string): void {
    this.hubs.delete(sessionId);
    for (const hub of this.hubs.values()) hub.streamEvent('presence', JSON.stringify({ sessionId, online: false }), true);
  }
}

/** A minimal PC: announces itself and answers a few methods. */
function fakeHost(hostId: string, opts: { remote?: boolean; slow?: boolean } = {}) {
  const cancelled: string[] = [];
  const make = (hub: RemoteHub): HostHandler => ({
    async handle(from: string, m: RemoteMessage) {
      if (m.type === 'hello') {
        await hub.send(from, { type: 'host', re: m.id, hostId, name: 'OFFICE-PC', os: 'Windows 11', version: '1.1.0', remote: opts.remote ?? true, home: 'C:\\Users\\alex', defaultFolder: 'C:\\Users\\alex\\Documents', recentFolders: [], features: ['computer'] });
        return;
      }
      if (m.type === 'cancel') {
        cancelled.push(String(m.re));
        return;
      }
      if (m.type !== 'call') return;
      if (opts.slow) return; // never answers
      if (m.method === 'computer.info') {
        await hub.send(from, { type: 'result', re: m.id, ok: true, value: { os: 'Windows 11', shell: 'PowerShell', home: 'C:\\Users\\alex', user: 'alex', hostname: 'OFFICE-PC' } });
      } else {
        await hub.send(from, { type: 'result', re: m.id, ok: false, error: { code: 'unknown_method', message: 'Nope.' } });
      }
    },
  });
  return { make, cancelled };
}

const tick = (ms = 150) => new Promise((r) => setTimeout(r, ms));

describe('RemoteHub', () => {
  it('discovers a PC and calls it', async () => {
    const relay = new FakeRelay();
    const host = fakeHost('host-1');
    relay.join('pc-session', 'Facet for Windows · OFFICE-PC', host.make);
    const phone = relay.join('phone-session', 'Pixel 9');
    let changes = 0;
    phone.subscribe(() => changes++);
    await phone.discover();
    await tick();
    expect(phone.hosts.map((h) => [h.hostId, h.sessionId, h.name, h.remote])).toEqual([['host-1', 'pc-session', 'OFFICE-PC', true]]);
    expect(changes).toBeGreaterThan(0);

    const info = await phone.call<{ hostname: string }>('host-1', 'computer.info');
    expect(info.hostname).toBe('OFFICE-PC');
    await expect(phone.call('host-1', 'files.list', { path: null })).rejects.toMatchObject({ code: 'unknown_method', message: 'Nope.' });
  });

  it('never sends plaintext through the relay', async () => {
    const relay = new FakeRelay();
    relay.join('pc', 'PC', fakeHost('host-1').make);
    const phone = relay.join('phone', 'Phone');
    await phone.discover();
    await tick();
    await phone.call('host-1', 'computer.info');
    expect(relay.sent.length).toBeGreaterThan(2);
    for (const m of relay.sent) {
      const text = atob(m.msg);
      expect(text).not.toContain('OFFICE-PC');
      expect(text).not.toContain('computer.info');
      expect(text).not.toContain('hello');
    }
  });

  it('drops replays and messages relabeled with another sender', async () => {
    const relay = new FakeRelay();
    const phone = relay.join('phone', 'Phone');
    const seen: string[] = [];
    const pc = relay.join('pc', 'PC', () => ({
      async handle(_from, m) {
        seen.push(m.type);
      },
    }));
    void pc;
    await phone.send('pc', { type: 'hello' });
    await tick();
    expect(seen).toEqual(['hello']);
    const env = relay.sent[0];
    relay.hubs.get('pc')!.streamEvent('relay', JSON.stringify({ from: 'phone', msg: env.msg }), true);
    relay.hubs.get('pc')!.streamEvent('relay', JSON.stringify({ from: 'mallory', msg: env.msg }), true);
    await tick();
    expect(seen).toEqual(['hello']);
  });

  it('fails calls at once when the PC goes away, and forgets it', async () => {
    const relay = new FakeRelay();
    relay.join('pc', 'PC', fakeHost('host-1', { slow: true }).make);
    const phone = relay.join('phone', 'Phone');
    await phone.discover();
    await tick();
    const pending = phone.call('host-1', 'computer.info');
    await tick();
    relay.leave('pc');
    await expect(pending).rejects.toMatchObject({ code: 'offline' });
    expect(phone.hosts).toEqual([]);
    await expect(phone.call('host-1', 'computer.info')).rejects.toMatchObject({ code: 'offline' });
  });

  it('times out, and cancels on abort', async () => {
    const relay = new FakeRelay();
    const host = fakeHost('host-1', { slow: true });
    relay.join('pc', 'PC', host.make);
    const phone = relay.join('phone', 'Phone');
    await phone.discover();
    await tick();
    await expect(phone.call('host-1', 'computer.info', {}, { timeoutMs: 100 })).rejects.toMatchObject({ code: 'timeout' });

    const abort = new AbortController();
    const call = phone.call('host-1', 'computer.call', { name: 'run_command' }, { signal: abort.signal });
    await tick();
    abort.abort();
    await expect(call).rejects.toBeTruthy();
    await tick();
    expect(host.cancelled.length).toBe(1);
  });

  it('a send to an offline session drops its hosts', async () => {
    const relay = new FakeRelay();
    relay.join('pc', 'PC', fakeHost('host-1').make);
    const phone = relay.join('phone', 'Phone');
    await phone.discover();
    await tick();
    relay.hubs.delete('pc'); // gone without a presence event
    await expect(phone.call('host-1', 'computer.info')).rejects.toMatchObject({ code: 'offline' });
    expect(phone.hosts).toEqual([]);
  });

  it('ignores results from a session other than the one called', async () => {
    const relay = new FakeRelay();
    relay.join('pc', 'PC', fakeHost('host-1', { slow: true }).make);
    const mallory = relay.join('mallory', 'Mallory');
    const phone = relay.join('phone', 'Phone');
    await phone.discover();
    await tick();
    const call = phone.call('host-1', 'computer.info', {}, { timeoutMs: 600 });
    await tick();
    // Mallory can't know the call id, but even a right guess must come from the host's session.
    for (const p of [...(phone as unknown as { pending: Map<string, unknown> }).pending.keys()]) {
      await mallory.send('phone', { type: 'result', re: p, ok: true, value: 'forged' });
    }
    await expect(call).rejects.toMatchObject({ code: 'timeout' });
  });

  it('shows PCs with remote use off, and resets on sign-out', async () => {
    const relay = new FakeRelay();
    relay.join('pc', 'PC', fakeHost('host-1', { remote: false }).make);
    const phone = relay.join('phone', 'Phone');
    await phone.discover();
    await tick();
    expect(phone.host('host-1')?.remote).toBe(false);
    phone.reset();
    expect(phone.hosts).toEqual([]);
  });
});

describe('importAgentSession', () => {
  it('creates a chat in the same PC folder with the session as one branch', async () => {
    const conversations = new ConversationRepository();
    const id = await importAgentSession(
      conversations,
      'claude',
      {
        id: 's1',
        title: 'Fix the login bug',
        cwd: 'C:\\Users\\alex\\app',
        updatedAt: 1_760_000_000_000,
        truncated: true,
        messages: [
          { role: 'user', text: 'Fix the login bug', at: 1_760_000_000_000 },
          { role: 'assistant', text: 'Looking.\n› Ran `npm test`', at: 1_760_000_000_000 },
          { role: 'user', text: '   ' },
          { role: 'user', text: 'Thanks' },
        ],
      },
      { computer: { host: 'host-1', folder: 'C:\\Users\\alex\\app' }, assistantId: null, providerId: 'p1', modelId: 'm1', params: defaultParams() },
    );
    const conv = (await db().conversations.get(id))!;
    expect(conv.title).toBe('Fix the login bug');
    expect(conv.titleSet).toBe(true);
    expect(conv.computerHost).toBe('host-1');
    expect(conv.computerFolder).toBe('C:\\Users\\alex\\app');
    expect(conv.providerId).toBe('p1');
    expect(conv.systemPrompt).toContain(resumeInstructions('claude', 'C:\\Users\\alex\\app'));
    expect(conv.systemPrompt).toContain('left out');
    const messages = await conversations.messages(id);
    const path = new MessageTree(messages).activePath(conv.currentLeafId);
    expect(path.map((m) => [m.role, m.content, m.modelName ?? null])).toEqual([
      ['user', 'Fix the login bug', null],
      ['assistant', 'Looking.\n› Ran `npm test`', 'Claude Code'],
      ['user', 'Thanks', null],
    ]);
    // Strictly increasing times keep the order even when the source repeats timestamps.
    expect(path[1].createdAt).toBeGreaterThan(path[0].createdAt);
    expect(path.every((m) => m.status === 'DONE' && m.dirty === 1)).toBe(true);
  });
});

describe('hasContentCredentials', () => {
  it('finds C2PA boxes and PNG caBX chunks', async () => {
    const { hasContentCredentials } = await import('../src/data/attachments');
    const enc = (s: string) => new TextEncoder().encode(s);
    expect(hasContentCredentials(enc('....jumb....c2pa.claim....'))).toBe(true);
    expect(hasContentCredentials(enc('\u0089PNG....caBX....'))).toBe(true);
    expect(hasContentCredentials(enc('\u0089PNG....IDAT....IEND'))).toBe(false);
    expect(hasContentCredentials(new Uint8Array(0))).toBe(false);
  });
});
