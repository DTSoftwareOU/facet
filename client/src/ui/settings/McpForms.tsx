/** Dialogs that add or edit MCP servers: a remote server by URL, or a local command (Windows app). */
import { FolderOpen } from 'lucide-react';
import { useEffect, useState } from 'react';
import { getApp } from '../../app';
import type { McpAuthMode, McpServerEntity } from '../../data/entities';
import { sentences, t, tm, tn } from '../../i18n';
import { McpAuthRequiredException } from '../../mcp/types';
import { platform } from '../../platform';
import type { McpDirectoryEntry } from '../../tools/mcpDirectory';
import { MCP_BROWSER_BLOCKED, McpManager, joinCommandLine, splitCommandLine, stdioName } from '../../tools/mcpManager';
import { Segmented } from '../chat/ChatSettings';
import { Button, Dialog, Field, useToast } from '../components/primitives';
import { ui } from '../nav';
import { connectMcp } from './McpConnect';
import { ToolsKeyValues, ToolsStatus, errorText, fromPairs, sentence, toPairs, useStableCallback, type KeyValue } from './ToolsShared';

type Status = { tone: 'ok' | 'error' | 'warning'; text: string } | null;

export function authLabel(a: McpAuthMode): string {
  switch (a) {
    case 'NONE':
      return t('None');
    case 'HEADERS':
      return t('Headers');
    default:
      return t('Sign in (OAuth)');
  }
}

function authHint(a: McpAuthMode): string {
  switch (a) {
    case 'NONE':
      return t('The server needs no sign-in, or its address already includes a key.');
    case 'HEADERS':
      return t('Sent with every request, e.g. Authorization: Bearer <token>. Encrypted on this device and synced end-to-end encrypted.');
    default:
      return t('After saving, sign in on the server’s own page. Tokens refresh automatically and sync to your devices.');
  }
}

/** The browser-blocked message, as McpManager throws it (English) or translated. */
function browserBlockedText(): string {
  return t("This server doesn't accept connections from web browsers. Use it in the Facet app for Windows or Android.");
}

/** The directory's auth label: No sign-in, Sign in or Token. */
export function McpAuthBadge({ auth }: { auth: McpAuthMode }) {
  if (auth === 'NONE') return <span className="badge primary">{t('No sign-in')}</span>;
  if (auth === 'OAUTH') return <span className="badge">{t('Sign in')}</span>;
  return <span className="badge warning">{t('Token')}</span>;
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

/** "Connected to Notion. 12 tools available." */
function startedToast(kind: 'connected' | 'started', name: string, tools: number): string {
  return sentences(
    kind === 'connected' ? t('Connected to {name}.', { name }) : t('Started {name}.', { name }),
    tn('{count} tool available.', '{count} tools available.', tools),
  );
}

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
      setStatus({ tone: 'error', text: errorText(e, t('Couldn’t save the server. Try again.')) });
      setBusy(false);
      return;
    }
    try {
      const tools = await connectMcp(id);
      toast(startedToast('connected', shownName, tools.length));
      finish(id);
    } catch (e) {
      const message = errorText(e, '');
      if (e instanceof McpAuthRequiredException) {
        if (auth === 'HEADERS') {
          setStatus({ tone: 'error', text: t('The server rejected these headers. Check the token, or switch to Sign in if the server offers it.') });
        } else {
          if (auth !== 'OAUTH') await app.mcp.update(id, name, url, 'OAUTH', null);
          toast(t('{name} needs you to sign in.', { name: shownName }));
          finish(id);
        }
      } else if (message === MCP_BROWSER_BLOCKED || message === browserBlockedText()) {
        setStatus({ tone: 'warning', text: sentences(browserBlockedText(), t('It’s saved and syncs there.')) });
        setBlockedSaved(true);
      } else {
        setStatus({
          tone: 'error',
          text: sentences(sentence(errorText(e, t('Couldn’t connect. Check the address.'))), existing ? null : t('The server is saved; fix the details and try again.')),
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
      title={existing ? t('Edit {name}', { name: existing.name }) : entry ? t('Add {name}', { name: entry.name }) : t('Add a custom server')}
      onClose={close}
      footer={
        <>
          <Button variant="text" onClick={close}>{savedNew ? t('Close') : t('Cancel')}</Button>
          {blockedSaved ? (
            <Button onClick={() => finish(savedId)}>{t('Done')}</Button>
          ) : (
            <Button busy={busy} disabled={!valid} onClick={submit}>
              {existing ? t('Save and reconnect') : savedId ? t('Try again') : t('Add and connect')}
            </Button>
          )}
        </>
      }
    >
      <div className="col gap-16">
        {entry && !existing && <p className="t-body c-2" style={{ margin: 0 }}>{tm(entry.blurb)}</p>}
        <Field label={t('Server URL')} hint={t('The server’s Streamable HTTP or SSE endpoint, e.g. https://example.com/mcp')}>
          <input
            className="input mono"
            dir="ltr"
            value={url}
            inputMode="url"
            spellCheck={false}
            autoComplete="off"
            onChange={(e) => { setUrl(e.target.value.trim()); setStatus(null); }}
          />
        </Field>
        <Field label={t('Name')}>
          <input className="input" dir="auto" value={name} placeholder={McpManager.hostOf(url)} onChange={(e) => setName(e.target.value)} />
        </Field>
        <div className="col gap-8">
          <span className="field-label">{t('Authentication')}</span>
          <Segmented<McpAuthMode> options={['NONE', 'HEADERS', 'OAUTH']} selected={auth} label={authLabel} onSelect={pickAuth} />
          <span className="field-hint" style={{ marginInlineStart: 4 }}>{authHint(auth)}</span>
        </div>
        {auth === 'HEADERS' && (
          <div className="col gap-8">
            <span className="field-label">{t('Headers')}</span>
            <ToolsKeyValues
              rows={headers}
              onChange={setHeaders}
              separator=":"
              keyPlaceholder="Authorization"
              valuePlaceholder="Bearer …"
              addLabel={t('Add header')}
              keyLabel={t('Header name')}
              valueLabel={t('Header value')}
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
  const defaultName = command ? stdioName({ command, args }) : t('Local server');
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
      setStatus({ tone: 'ok', text: tn('Working. The server offers {count} tool.', 'Working. The server offers {count} tools.', tools.length) });
    } catch (e) {
      setStatus({ tone: 'error', text: errorText(e, t('The command didn’t start an MCP server. Check the command and try again.')) });
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
      setStatus({ tone: 'error', text: errorText(e, t('Couldn’t save the server. Try again.')) });
      setBusy(null);
      return;
    }
    try {
      const tools = await connectMcp(id);
      toast(startedToast('started', name.trim() || defaultName, tools.length));
      finish(id);
    } catch (e) {
      setStatus({
        tone: 'error',
        text: sentences(sentence(errorText(e, t('The server didn’t start.'))), existing ? null : t('It’s saved; fix the command and try again.')),
      });
    } finally {
      setBusy(null);
    }
  };

  const savedNew = !existing && savedId != null;
  const close = useStableCallback(() => (savedNew ? finish(savedId) : onClose()));
  return (
    <Dialog
      title={existing ? t('Edit {name}', { name: existing.name }) : t('Add a local server')}
      onClose={close}
      footer={
        <>
          <Button variant="text" onClick={close}>{savedNew ? t('Close') : t('Cancel')}</Button>
          <Button variant="tonal" busy={busy === 'test'} disabled={!valid || busy != null} onClick={test}>{t('Test')}</Button>
          <Button busy={busy === 'save'} disabled={!valid || busy != null} onClick={save}>
            {existing ? t('Save and restart') : savedId ? t('Try again') : t('Add and start')}
          </Button>
        </>
      }
    >
      <div className="col gap-16">
        <p className="t-body c-2" style={{ margin: 0 }}>
          {t('Runs a program on this computer that speaks MCP over standard input and output, such as an npx, uvx or docker command. It runs with your Windows account’s permissions. Local servers stay on this computer and don’t sync to your other devices.')}
        </p>
        <Field label={t('Command')} hint={t('For example: {example}. Put quotes around paths with spaces.', { example: 'npx -y @modelcontextprotocol/server-memory' })}>
          <input
            className="input mono"
            dir="ltr"
            value={line}
            placeholder="npx -y @modelcontextprotocol/server-memory"
            spellCheck={false}
            autoComplete="off"
            onChange={(e) => { setLine(e.target.value); setStatus(null); }}
          />
        </Field>
        <Field label={t('Name')}>
          <input className="input" dir="auto" value={name} placeholder={defaultName} onChange={(e) => setName(e.target.value)} />
        </Field>
        <div className="col gap-6">
          <span className="field-label">{t('Working folder')}</span>
          <div className="row gap-8">
            <input
              className="input mono grow"
              dir="ltr"
              value={cwd}
              placeholder={t('Optional')}
              aria-label={t('Working folder')}
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
                <FolderOpen size={16} /> {t('Choose…')}
              </Button>
            )}
          </div>
          <span className="field-hint">{t('Where the command runs. Leave empty for the app’s default.')}</span>
        </div>
        <div className="col gap-8">
          <span className="field-label">{t('Environment variables')}</span>
          <ToolsKeyValues
            rows={env}
            onChange={setEnv}
            separator="="
            keyPlaceholder="API_KEY"
            valuePlaceholder={t('Value')}
            addLabel={t('Add variable')}
            keyLabel={t('Variable name')}
            valueLabel={t('Variable value')}
          />
          <span className="field-hint">{t('Passed to the program, e.g. an API key it needs. Encrypted on this computer.')}</span>
        </div>
        {status && <ToolsStatus tone={status.tone}>{status.text}</ToolsStatus>}
      </div>
    </Dialog>
  );
}
