/** Dialogs that add or edit MCP servers: a remote server by URL, or a local command (Windows app). */
import { FolderOpen } from 'lucide-react';
import { useEffect, useState } from 'react';
import { getApp } from '../../app';
import type { McpAuthMode, McpServerEntity } from '../../data/entities';
import { McpAuthRequiredException } from '../../mcp/types';
import { platform } from '../../platform';
import type { McpDirectoryEntry } from '../../tools/mcpDirectory';
import { MCP_BROWSER_BLOCKED, McpManager, joinCommandLine, splitCommandLine, stdioName } from '../../tools/mcpManager';
import { Segmented } from '../chat/ChatSettings';
import { Button, Dialog, Field, useToast } from '../components/primitives';
import { ui } from '../nav';
import { connectMcp } from './McpConnect';
import { ToolsKeyValues, ToolsStatus, errorText, fromPairs, plural, sentence, toPairs, useStableCallback, type KeyValue } from './ToolsShared';

type Status = { tone: 'ok' | 'error' | 'warning'; text: string } | null;

export const AUTH_LABEL: Record<McpAuthMode, string> = { NONE: 'None', HEADERS: 'Headers', OAUTH: 'Sign in (OAuth)' };

const AUTH_HINT: Record<McpAuthMode, string> = {
  NONE: 'The server needs no sign-in, or its address already includes a key.',
  HEADERS: 'Sent with every request, e.g. Authorization: Bearer <token>. Encrypted on this device and synced end-to-end encrypted.',
  OAUTH: 'After saving, sign in on the server’s own page. Tokens refresh automatically and sync to your devices.',
};

/** The directory's auth label: Open, Sign in or Token. */
export function McpAuthBadge({ auth }: { auth: McpAuthMode }) {
  if (auth === 'NONE') return <span className="badge primary">Open</span>;
  if (auth === 'OAUTH') return <span className="badge">Sign in</span>;
  return <span className="badge warning">Token</span>;
}

function validUrl(url: string): boolean {
  try {
    const u = new URL(url.trim());
    return (u.protocol === 'https:' || u.protocol === 'http:') && u.hostname.length > 0;
  } catch {
    return false;
  }
}

const openServer = (id: string) => ui.openSettings('tools', 'mcp:' + id);

/** Adds a remote server (from the directory or by URL) or edits one. New servers open their page once saved. */
export function McpRemoteDialog({ existing, entry, onClose }: {
  existing?: McpServerEntity | null;
  /** A directory entry to prefill. */
  entry?: McpDirectoryEntry | null;
  onClose: () => void;
}) {
  const app = getApp();
  const toast = useToast();
  const [url, setUrl] = useState(existing?.url ?? entry?.url ?? 'https://');
  const [name, setName] = useState(existing?.name ?? entry?.name ?? '');
  const [auth, setAuth] = useState<McpAuthMode>(existing?.authMode ?? entry?.auth ?? 'NONE');
  const [headers, setHeaders] = useState<KeyValue[]>(entry?.auth === 'HEADERS' ? [{ key: 'Authorization', value: '' }] : []);
  const [loaded, setLoaded] = useState(!existing);
  const [savedId, setSavedId] = useState<string | null>(existing?.id ?? null);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<Status>(null);
  const [blockedSaved, setBlockedSaved] = useState(false);

  useEffect(() => {
    if (!existing) return;
    let live = true;
    void app.mcp.headers(existing).then((h) => {
      if (!live) return;
      const pairs = toPairs(h);
      setHeaders(pairs.length > 0 ? pairs : existing.authMode === 'HEADERS' ? [{ key: 'Authorization', value: '' }] : []);
      setLoaded(true);
    });
    return () => {
      live = false;
    };
  }, [existing?.id]);

  const pickAuth = (a: McpAuthMode) => {
    setAuth(a);
    setStatus(null);
    if (a === 'HEADERS' && headers.length === 0) setHeaders([{ key: 'Authorization', value: '' }]);
  };

  const shownName = name.trim() || McpManager.hostOf(url);
  const valid = loaded && validUrl(url) && (auth !== 'HEADERS' || Object.keys(fromPairs(headers)).length > 0);

  /** Closes the dialog; a server added here opens its page. */
  const finish = (id: string | null) => {
    onClose();
    if (!existing && id) openServer(id);
  };

  const submit = async () => {
    setBusy(true);
    setStatus(null);
    setBlockedSaved(false);
    const h = auth === 'HEADERS' ? fromPairs(headers) : {};
    let id = savedId;
    try {
      if (id) await app.mcp.update(id, name, url, auth, h);
      else {
        id = (await app.mcp.add(name, url, auth, h)).id;
        setSavedId(id);
      }
    } catch (e) {
      setStatus({ tone: 'error', text: errorText(e, 'Couldn’t save the server. Try again.') });
      setBusy(false);
      return;
    }
    try {
      const tools = await connectMcp(id);
      toast(`Connected to ${shownName}. ${plural(tools.length, 'tool')} available.`);
      finish(id);
    } catch (e) {
      if (e instanceof McpAuthRequiredException) {
        if (auth === 'HEADERS') {
          setStatus({ tone: 'error', text: 'The server rejected these headers. Check the token, or switch to Sign in if the server offers it.' });
        } else {
          if (auth !== 'OAUTH') await app.mcp.update(id, name, url, 'OAUTH', null);
          toast(`${shownName} needs you to sign in.`);
          finish(id);
        }
      } else if (errorText(e, '') === MCP_BROWSER_BLOCKED) {
        setStatus({ tone: 'warning', text: `${MCP_BROWSER_BLOCKED} It’s saved and syncs there.` });
        setBlockedSaved(true);
      } else {
        setStatus({
          tone: 'error',
          text: sentence(errorText(e, 'Couldn’t connect. Check the address.')) + (existing ? '' : ' The server is saved; fix the details and try again.'),
        });
      }
    } finally {
      setBusy(false);
    }
  };

  const savedNew = !existing && savedId != null;
  const close = useStableCallback(() => (savedNew ? finish(savedId) : onClose()));
  return (
    <Dialog
      title={existing ? `Edit ${existing.name}` : entry ? `Add ${entry.name}` : 'Add a custom server'}
      onClose={close}
      footer={
        <>
          <Button variant="text" onClick={close}>{savedNew ? 'Close' : 'Cancel'}</Button>
          {blockedSaved ? (
            <Button onClick={() => finish(savedId)}>Done</Button>
          ) : (
            <Button busy={busy} disabled={!valid} onClick={submit}>
              {existing ? 'Save and reconnect' : savedId ? 'Try again' : 'Add and connect'}
            </Button>
          )}
        </>
      }
    >
      <div className="col gap-16">
        {entry && !existing && <p className="t-body c-2" style={{ margin: 0 }}>{entry.blurb}</p>}
        <Field label="Server URL" hint="The server’s Streamable HTTP or SSE endpoint, e.g. https://example.com/mcp">
          <input
            className="input mono"
            value={url}
            inputMode="url"
            spellCheck={false}
            autoComplete="off"
            onChange={(e) => { setUrl(e.target.value.trim()); setStatus(null); }}
          />
        </Field>
        <Field label="Name">
          <input className="input" value={name} placeholder={McpManager.hostOf(url)} onChange={(e) => setName(e.target.value)} />
        </Field>
        <div className="col gap-8">
          <span className="field-label">Authentication</span>
          <Segmented<McpAuthMode> options={['NONE', 'HEADERS', 'OAUTH']} selected={auth} label={(a) => AUTH_LABEL[a]} onSelect={pickAuth} />
          <span className="field-hint" style={{ marginLeft: 4 }}>{AUTH_HINT[auth]}</span>
        </div>
        {auth === 'HEADERS' && (
          <div className="col gap-8">
            <span className="field-label">Headers</span>
            <ToolsKeyValues
              rows={headers}
              onChange={setHeaders}
              separator=":"
              keyPlaceholder="Authorization"
              valuePlaceholder="Bearer …"
              addLabel="Add header"
              keyLabel="Header name"
              valueLabel="Header value"
            />
          </div>
        )}
        {status && <ToolsStatus tone={status.tone}>{status.text}</ToolsStatus>}
      </div>
    </Dialog>
  );
}

/** Adds or edits a local (stdio) server: a command that speaks MCP. Windows app only; these stay on this computer. */
export function McpLocalDialog({ existing, onClose }: { existing?: McpServerEntity | null; onClose: () => void }) {
  const app = getApp();
  const toast = useToast();
  const computer = platform().computer;
  const spec = existing?.stdio ?? null;
  const [line, setLine] = useState(spec ? joinCommandLine([spec.command, ...spec.args]) : '');
  const [name, setName] = useState(existing?.name ?? '');
  const [cwd, setCwd] = useState(spec?.cwd ?? '');
  const [env, setEnv] = useState<KeyValue[]>([]);
  const [loaded, setLoaded] = useState(!existing);
  const [savedId, setSavedId] = useState<string | null>(existing?.id ?? null);
  const [busy, setBusy] = useState<'test' | 'save' | null>(null);
  const [status, setStatus] = useState<Status>(null);

  useEffect(() => {
    if (!existing) return;
    let live = true;
    void app.mcp.headers(existing).then((h) => {
      if (!live) return;
      setEnv(toPairs(h));
      setLoaded(true);
    });
    return () => {
      live = false;
    };
  }, [existing?.id]);

  const words = splitCommandLine(line);
  const command = words[0] ?? '';
  const args = words.slice(1);
  const defaultName = command ? stdioName({ command, args }) : 'Local server';
  const valid = loaded && command.trim() !== '';
  const input = () => ({ name, command, args, cwd: cwd.trim() || null, env: fromPairs(env) });

  const finish = (id: string | null) => {
    onClose();
    if (!existing && id) openServer(id);
  };

  const test = async () => {
    setBusy('test');
    setStatus(null);
    try {
      const { tools } = await app.mcp.test({
        name: name.trim() || defaultName,
        url: '',
        authMode: 'NONE',
        headers: fromPairs(env),
        stdio: { command, args, cwd: cwd.trim() || null },
      });
      setStatus({ tone: 'ok', text: `Working. The server offers ${plural(tools.length, 'tool')}.` });
    } catch (e) {
      setStatus({ tone: 'error', text: errorText(e, 'The command didn’t start an MCP server. Check the command and try again.') });
    } finally {
      setBusy(null);
    }
  };

  const save = async () => {
    setBusy('save');
    setStatus(null);
    let id = savedId;
    try {
      if (id) await app.mcp.updateStdio(id, input());
      else {
        id = (await app.mcp.addStdio(input())).id;
        setSavedId(id);
      }
    } catch (e) {
      setStatus({ tone: 'error', text: errorText(e, 'Couldn’t save the server. Try again.') });
      setBusy(null);
      return;
    }
    try {
      const tools = await connectMcp(id);
      toast(`Started ${name.trim() || defaultName}. ${plural(tools.length, 'tool')} available.`);
      finish(id);
    } catch (e) {
      setStatus({
        tone: 'error',
        text: sentence(errorText(e, 'The server didn’t start.')) + (existing ? '' : ' It’s saved; fix the command and try again.'),
      });
    } finally {
      setBusy(null);
    }
  };

  const savedNew = !existing && savedId != null;
  const close = useStableCallback(() => (savedNew ? finish(savedId) : onClose()));
  return (
    <Dialog
      title={existing ? `Edit ${existing.name}` : 'Add a local server'}
      onClose={close}
      footer={
        <>
          <Button variant="text" onClick={close}>{savedNew ? 'Close' : 'Cancel'}</Button>
          <Button variant="tonal" busy={busy === 'test'} disabled={!valid || busy != null} onClick={test}>Test</Button>
          <Button busy={busy === 'save'} disabled={!valid || busy != null} onClick={save}>
            {existing ? 'Save and restart' : savedId ? 'Try again' : 'Add and start'}
          </Button>
        </>
      }
    >
      <div className="col gap-16">
        <p className="t-body c-2" style={{ margin: 0 }}>
          Runs a program on this computer that speaks MCP over standard input and output, such as an npx, uvx or docker command. It runs with
          your Windows account’s permissions. Local servers stay on this computer and don’t sync to your other devices.
        </p>
        <Field label="Command" hint="For example: npx -y @modelcontextprotocol/server-memory. Put quotes around paths with spaces.">
          <input
            className="input mono"
            value={line}
            placeholder="npx -y @modelcontextprotocol/server-memory"
            spellCheck={false}
            autoComplete="off"
            onChange={(e) => { setLine(e.target.value); setStatus(null); }}
          />
        </Field>
        <Field label="Name">
          <input className="input" value={name} placeholder={defaultName} onChange={(e) => setName(e.target.value)} />
        </Field>
        <div className="col gap-6">
          <span className="field-label">Working folder</span>
          <div className="row gap-8">
            <input
              className="input mono grow"
              value={cwd}
              placeholder="Optional"
              aria-label="Working folder"
              spellCheck={false}
              onChange={(e) => setCwd(e.target.value)}
            />
            {computer && (
              <Button
                variant="tonal"
                onClick={async () => {
                  const picked = await computer.pickFolder(cwd.trim() || undefined);
                  if (picked) setCwd(picked);
                }}
              >
                <FolderOpen size={16} /> Choose…
              </Button>
            )}
          </div>
          <span className="field-hint">Where the command runs. Leave empty for the app’s default.</span>
        </div>
        <div className="col gap-8">
          <span className="field-label">Environment variables</span>
          <ToolsKeyValues
            rows={env}
            onChange={setEnv}
            separator="="
            keyPlaceholder="API_KEY"
            valuePlaceholder="Value"
            addLabel="Add variable"
            keyLabel="Variable name"
            valueLabel="Variable value"
          />
          <span className="field-hint">Passed to the program, e.g. an API key it needs. Encrypted on this computer.</span>
        </div>
        {status && <ToolsStatus tone={status.tone}>{status.text}</ToolsStatus>}
      </div>
    </Dialog>
  );
}
