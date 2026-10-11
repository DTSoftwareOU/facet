/** Settings → Tools → an MCP server: connection, sign-in, approvals, per-tool switches, edit and remove. */
import { useLiveQuery } from 'dexie-react-hooks';
import { ChevronRight, CircleCheck, LogIn, Pencil, Power, RefreshCw, Search, Server, Terminal, Trash2, X } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { getApp } from '../../app';
import { Dates } from '../../core/format';
import { db } from '../../data/db';
import type { McpServerEntity } from '../../data/entities';
import { sentences, t, tm, tn } from '../../i18n';
import { McpAuthRequiredException, type McpPendingAuth, type McpTool } from '../../mcp/types';
import { platform } from '../../platform';
import { MCP_BROWSER_BLOCKED, MCP_STATUS_SIGN_IN } from '../../tools/mcpManager';
import { TOOL_APPROVAL_INFO, type ToolApproval } from '../../tools/types';
import { Segmented } from '../chat/ChatSettings';
import { Button, Confirm, Divider, Group, IconButton, Row, Spinner, Switch, SwitchRow, useToast } from '../components/primitives';
import { useSyncedPrefs } from '../hooks';
import { ui } from '../nav';
import { connectMcp, useMcpConnecting } from './McpConnect';
import { McpLocalDialog, McpRemoteDialog } from './McpForms';
import { mcpAddress } from './McpServers';
import { ToolsStatus, ToolsToggleChip, errorText, isAbort, useStableCallback } from './ToolsShared';

const APPROVALS: ToolApproval[] = ['ALWAYS', 'WRITES', 'NEVER'];

function updatedAgo(ms: number): string {
  return Dates.justNow(ms) ? t('updated just now') : t('updated {time}', { time: Dates.relative(ms) });
}

function firstLine(text: string | null | undefined, max = 180): string {
  const line = (text ?? '').split(/\r?\n/).map((l) => l.trim()).find(Boolean) ?? '';
  return line.length > max ? line.slice(0, max - 1).trimEnd() + '…' : line;
}

/** "Signed in to Notion. 12 tools available." */
function connectedToast(signedIn: boolean, name: string, tools: number): string {
  return sentences(
    signedIn ? t('Signed in to {name}.', { name }) : t('Connected to {name}.', { name }),
    tn('{count} tool available.', '{count} tools available.', tools),
  );
}

/** Sign-in for OAuth servers. On the website the sign-in is prepared ahead, so the popup opens during the click. */
function useSignIn(server: McpServerEntity | null | undefined) {
  const app = getApp();
  const mcp = app.mcp;
  const toast = useToast();
  const web = platform().corsLimited;
  const needed =
    !!server && !server.deleted && server.enabled && !server.stdio &&
    (server.status === MCP_STATUS_SIGN_IN || (server.authMode === 'OAUTH' && !mcp.isSignedIn(server)));
  const [pending, setPending] = useState<McpPendingAuth | null>(null);
  const [preparing, setPreparing] = useState(false);
  const [prepareError, setPrepareError] = useState<string | null>(null);
  const [round, setRound] = useState(0);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const abort = useRef<AbortController | null>(null);
  const id = server?.id;

  useEffect(() => {
    if (!web || !needed || !id) return;
    let live = true;
    setPending(null);
    setPrepareError(null);
    setPreparing(true);
    mcp.prepareSignIn(id).then(
      (p) => {
        if (!live) return;
        setPending(p);
        setPreparing(false);
      },
      (e) => {
        if (!live) return;
        setPrepareError(errorText(e, t('Couldn’t start sign-in. Try again.')));
        setPreparing(false);
      },
    );
    return () => {
      live = false;
    };
  }, [web, needed, id, server?.url, round]);

  /** Must run directly in a click handler: on the website it opens the sign-in popup before any await. */
  const start = () => {
    if (!server) return;
    const ctrl = new AbortController();
    let run: Promise<McpTool[]>;
    if (web) {
      if (!pending) return;
      run = mcp.finishSignIn(pending, ctrl.signal);
      setPending(null);
    } else {
      run = mcp.signIn(server.id, ctrl.signal);
    }
    abort.current = ctrl;
    setError(null);
    setRunning(true);
    run
      .then(
        (tools) => toast(connectedToast(true, server.name, tools.length)),
        (e) => {
          if (!isAbort(e) && !ctrl.signal.aborted) setError(errorText(e, t('Sign-in didn’t complete. Try again.')));
        },
      )
      .finally(() => {
        setRunning(false);
        abort.current = null;
        if (web) setRound((n) => n + 1);
      });
  };

  return {
    needed,
    web,
    ready: !web || pending != null,
    preparing,
    prepareError,
    running,
    error,
    start,
    cancel: () => abort.current?.abort(),
    retryPrepare: () => setRound((n) => n + 1),
    clearError: () => setError(null),
  };
}

export function McpServerPage({ id }: { id: string }) {
  const app = getApp();
  const mcp = app.mcp;
  const toast = useToast();
  const synced = useSyncedPrefs();
  const server = useLiveQuery(async () => (await db().mcpServers.get(id)) ?? null, [id]);
  const connecting = useMcpConnecting().has(id);
  const signIn = useSignIn(server);
  const [dialog, setDialog] = useState<'edit' | 'delete' | null>(null);
  const [filter, setFilter] = useState('');
  const [connectError, setConnectError] = useState<string | null>(null);
  const closeDialog = useStableCallback(() => setDialog(null));

  const tools = useMemo(() => (server ? mcp.tools(server) : []), [server?.toolsJson]);
  const disabled = useMemo(() => (server ? mcp.disabledTools(server) : new Set<string>()), [server?.disabledToolsJson]);
  const auto = useMemo(() => (server ? mcp.autoApproved(server) : new Set<string>()), [server?.autoApprovedJson]);

  if (server === undefined) {
    return (
      <div className="tools-page" style={{ padding: 24 }}>
        <Spinner />
      </div>
    );
  }
  if (!server || server.deleted) {
    return (
      <div className="col gap-16 tools-page">
        <ToolsStatus tone="info">{t('This server was removed.')}</ToolsStatus>
        <span>
          <Button variant="tonal" onClick={() => ui.openSettings('tools')}>{t('Back to Tools')}</Button>
        </span>
      </div>
    );
  }

  const s = server;
  const local = s.stdio != null;
  const cantRun = local && !mcp.stdioAvailable;
  const approval = mcp.approval(s);
  const yolo = synced.yoloMode;
  const signedIn = !local && s.authMode === 'OAUTH' && mcp.isSignedIn(s) && s.status !== MCP_STATUS_SIGN_IN;
  const genericProblem = s.status && s.status !== MCP_STATUS_SIGN_IN && s.status !== MCP_BROWSER_BLOCKED ? s.status : null;
  const enabledCount = tools.filter((tool) => !disabled.has(tool.name)).length;

  const state =
    !s.enabled ? { text: t('Off. Its tools aren’t offered to models.') }
      : cantRun ? { text: t('Runs only in the Facet app for Windows'), warn: true }
        : connecting ? { text: t('Connecting…') }
          : s.status === MCP_STATUS_SIGN_IN ? { text: t('Sign in required'), warn: true }
            : s.status === MCP_BROWSER_BLOCKED ? { text: t('Doesn’t work in web browsers'), warn: true }
              : s.status ? { text: t('Couldn’t connect'), warn: true }
                : s.toolsFetchedAt === 0 ? { text: t('Connecting…') }
                  : { text: `${t('Connected')} · ${tn('{count} tool', '{count} tools', tools.length)} · ${updatedAgo(s.toolsFetchedAt)}`, ok: true };

  const refresh = async () => {
    setConnectError(null);
    signIn.clearError();
    try {
      const list = await connectMcp(id);
      toast(connectedToast(false, s.name, list.length));
    } catch (e) {
      // refreshTools saves the problem as the server's status; keep only problems it didn't save.
      const msg = errorText(e, t('Couldn’t connect.'));
      const fresh = await mcp.get(id);
      if (!(e instanceof McpAuthRequiredException) && fresh?.status !== msg) setConnectError(msg);
    }
  };

  const setAllTools = async (on: boolean) => {
    for (const tool of tools) if (disabled.has(tool.name) === on) await mcp.setToolEnabled(id, tool.name, on);
  };

  const q = filter.trim().toLowerCase();
  const shown = q
    ? tools.filter((tool) => tool.name.toLowerCase().includes(q) || (tool.title ?? '').toLowerCase().includes(q) || (tool.description ?? '').toLowerCase().includes(q))
    : tools;

  return (
    <div className="col gap-16 tools-page">
      <div className="group mcp-hero">
        <span className="onboard-icon">{local ? <Terminal size={20} /> : <Server size={20} />}</span>
        <div className="col grow gap-4" style={{ minWidth: 0 }}>
          <div className="row gap-8" style={{ minWidth: 0 }}>
            <span className="t-title-m ellipsis"><bdi>{s.name}</bdi></span>
            {local && <span className="badge">{t('Local')}</span>}
          </div>
          <span className="mono mcp-hero-addr" dir="ltr">{mcpAddress(s)}</span>
          <span className={'t-label-m row gap-6 ' + (state.warn ? 'c-warning' : 'c-2')} style={{ fontWeight: 400 }}>
            {state.ok && <span className="mcp-dot" aria-hidden />}
            {state.text}
          </span>
        </div>
        {s.enabled && !cantRun && !signIn.needed && (
          <div className="tools-actions">
            <Button variant="tonal" small busy={connecting} onClick={refresh}>
              {!connecting && <RefreshCw size={15} />} {s.toolsFetchedAt === 0 || s.status ? t('Connect') : t('Refresh tools')}
            </Button>
          </div>
        )}
      </div>

      {cantRun && <ToolsStatus tone="warning">{t('Local servers run only in the Facet app for Windows.')}</ToolsStatus>}
      {s.enabled && s.status === MCP_BROWSER_BLOCKED && (
        <ToolsStatus tone="warning">
          {sentences(
            t("This server doesn't accept connections from web browsers. Use it in the Facet app for Windows or Android."),
            t('Its settings sync, so it’s ready there.'),
          )}
        </ToolsStatus>
      )}
      {s.enabled && genericProblem && !connecting && (
        <ToolsStatus tone="error" action={<Button variant="text" small onClick={() => setDialog('edit')}>{t('Edit')}</Button>}>
          {genericProblem}
        </ToolsStatus>
      )}
      {connectError && <ToolsStatus tone="error">{connectError}</ToolsStatus>}

      {signIn.needed && (
        <div className="group tools-callout">
          <div className="row gap-12" style={{ alignItems: 'flex-start' }}>
            <span className="onboard-icon"><LogIn size={20} /></span>
            <div className="col grow gap-4" style={{ minWidth: 0 }}>
              <span className="t-label-l">{t('Sign in to {name}', { name: s.name })}</span>
              <span className="t-label-m c-2" style={{ fontWeight: 400 }}>
                {sentences(
                  t('{name} needs you to sign in before its tools work.', { name: s.name }),
                  signIn.web ? t('A sign-in window opens.') : t('Your browser opens.'),
                  t('Tokens are encrypted and sync to your devices.'),
                )}
              </span>
            </div>
          </div>
          {signIn.prepareError ? (
            <ToolsStatus tone="error" action={<Button variant="text" small onClick={signIn.retryPrepare}>{t('Try again')}</Button>}>
              {signIn.prepareError}
            </ToolsStatus>
          ) : signIn.running ? (
            <div className="row gap-12 tools-callout-actions">
              <Spinner />
              <span className="t-body c-2 grow">{t('Waiting for you to finish signing in…')}</span>
              <Button variant="text" onClick={signIn.cancel}>{t('Cancel')}</Button>
            </div>
          ) : (
            <div className="row gap-8 tools-callout-actions">
              <Button busy={signIn.preparing} disabled={!signIn.ready} onClick={signIn.start}>
                <LogIn size={16} className="flip-rtl" /> {t('Sign in')}
              </Button>
            </div>
          )}
          {signIn.error && <ToolsStatus tone="error">{signIn.error}</ToolsStatus>}
        </div>
      )}

      <div className="group">
        <SwitchRow
          icon={<Power size={20} />}
          title={t('Use this server')}
          subtitle={
            s.enabled
              ? t('Its tools are offered to every model that supports tools.')
              : local ? t('Off: its tools aren’t offered and the program isn’t running.') : t('Off: its tools aren’t offered to models.')
          }
          checked={s.enabled}
          onChange={(v) => void mcp.setEnabled(id, v)}
        />
      </div>

      {signedIn && (
        <Group title={t('Account')}>
          <Row
            icon={<CircleCheck size={20} />}
            title={t('Signed in')}
            subtitle={t('Tokens refresh automatically and sync to your devices.')}
            trailing={
              <Button
                variant="text"
                small
                onClick={async () => {
                  await mcp.signOut(id);
                  toast(t('Signed out of {name}.', { name: s.name }));
                }}
              >
                {t('Sign out')}
              </Button>
            }
          />
        </Group>
      )}

      <section className="col gap-8">
        <h3 className="group-title" style={{ margin: '6px 4px 0' }}>{t('When to ask first')}</h3>
        <Segmented options={APPROVALS} selected={approval} label={(a) => tm(TOOL_APPROVAL_INFO[a].label)} onSelect={(a) => void mcp.setApproval(id, a)} />
        {yolo ? (
          <span className="field-hint c-warning row gap-8" style={{ marginInlineStart: 4, flexWrap: 'wrap' }}>
            {t('YOLO mode is on, so these tools run without asking.')}
            <button type="button" className="tools-link" onClick={() => void app.settings.updateSynced((p) => ({ ...p, yoloMode: false }))}>
              {t('Turn off YOLO mode')}
            </button>
          </span>
        ) : (
          <span className="field-hint" style={{ marginInlineStart: 4 }}>
            {sentences(tm(TOOL_APPROVAL_INFO[approval].blurb), t('“Always allow” on a tool skips the question for that tool.'))}
          </span>
        )}
      </section>

      {tools.length > 0 ? (
        <section>
          <div className="tools-group-head">
            <h3 className="group-title grow">
              {enabledCount === tools.length
                ? t('Tools ({count})', { count: tools.length })
                : t('Tools ({on} of {total} on)', { on: enabledCount, total: tools.length })}
            </h3>
            {tools.length > 1 && (
              <div className="tools-actions">
                <Button variant="text" small disabled={enabledCount === tools.length} onClick={() => void setAllTools(true)}>{t('Turn all on')}</Button>
                <Button variant="text" small disabled={enabledCount === 0} onClick={() => void setAllTools(false)}>{t('Turn all off')}</Button>
              </div>
            )}
          </div>
          {tools.length > 8 && (
            <div className="tools-search" style={{ marginBottom: 10 }}>
              <Search size={17} aria-hidden />
              <input className="input" type="search" dir="auto" value={filter} placeholder={t('Filter tools')} aria-label={t('Filter tools')} onChange={(e) => setFilter(e.target.value)} />
              {filter && (
                <IconButton small label={t('Clear filter')} onClick={() => setFilter('')}>
                  <X size={16} />
                </IconButton>
              )}
            </div>
          )}
          <div className="group">
            {shown.map((tool, i) => {
              const on = !disabled.has(tool.name);
              const always = auto.has(tool.name);
              const asks = approval === 'ALWAYS' || (approval === 'WRITES' && tool.readOnlyHint !== true);
              const desc = firstLine(tool.description);
              return (
                <div key={tool.name}>
                  {i > 0 && <Divider full />}
                  <div className={'srow mcp-tool' + (on ? '' : ' off')}>
                    <span className="srow-text">
                      <span className="srow-title" dir="auto">{tool.title || tool.name}</span>
                      {tool.title && tool.title !== tool.name && <span className="mono mcp-tool-name" dir="ltr">{tool.name}</span>}
                      {desc && <span className="srow-sub mcp-tool-desc" dir="auto">{desc}</span>}
                      {(tool.readOnlyHint === true || tool.destructiveHint === true) && (
                        <span className="row gap-6" style={{ marginTop: 4 }}>
                          {tool.readOnlyHint === true ? <span className="badge">{t('Read-only')}</span> : <span className="badge warning">{t('Can delete or overwrite data')}</span>}
                        </span>
                      )}
                    </span>
                    <div className="mcp-tool-controls">
                      <ToolsToggleChip
                        on={always}
                        disabled={!on || (!asks && !always)}
                        title={!asks && !always ? t('This tool already runs without asking.') : always ? t('Runs without asking. Click to ask again.') : t('Run this tool without asking')}
                        icon={always ? <CircleCheck size={14} /> : undefined}
                        onChange={(v) => void mcp.setAutoApprove(id, tool.name, v)}
                      >
                        {t('Always allow')}
                      </ToolsToggleChip>
                      <Switch checked={on} label={t('Use {name}', { name: tool.title || tool.name })} onChange={(v) => void mcp.setToolEnabled(id, tool.name, v)} />
                    </div>
                  </div>
                </div>
              );
            })}
            {shown.length === 0 && <div className="srow t-body c-3">{t('No tools match “{query}”.', { query: filter.trim() })}</div>}
          </div>
        </section>
      ) : (
        s.toolsFetchedAt > 0 && <ToolsStatus tone="info">{t('This server offers no tools.')}</ToolsStatus>
      )}

      {s.instructions?.trim() && (
        <details className="group tools-details">
          <summary>
            <ChevronRight size={18} className="tools-details-chev flip-rtl" aria-hidden />
            <span className="grow">{t('Server instructions')}</span>
            <span className="field-hint">{t('Shown to models with the tools')}</span>
          </summary>
          <div className="tools-details-body" dir="auto">{s.instructions.trim()}</div>
        </details>
      )}

      <div className="group">
        <Row icon={<Pencil size={20} />} title={t('Edit connection')} subtitle={local ? t('Command, folder and environment') : t('Address, name and authentication')} onClick={() => setDialog('edit')} />
        <Divider />
        <Row icon={<Trash2 size={20} />} title={t('Remove server')} danger chevron={false} onClick={() => setDialog('delete')} />
      </div>

      {dialog === 'edit' && (local ? <McpLocalDialog existing={s} onClose={closeDialog} /> : <McpRemoteDialog existing={s} onClose={closeDialog} />)}
      {dialog === 'delete' && (
        <Confirm
          title={t('Remove {name}?', { name: s.name })}
          body={local ? t('It’s removed from this computer and its program stops.') : t('Its tools and sign-in are removed from all your devices.')}
          confirm={t('Remove')}
          danger
          onConfirm={async () => {
            await mcp.delete(id);
            toast(t('Removed {name}.', { name: s.name }));
            ui.openSettings('tools');
          }}
          onClose={closeDialog}
        />
      )}
    </div>
  );
}
