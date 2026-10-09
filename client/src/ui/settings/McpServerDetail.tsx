/** Settings → Tools → an MCP server: connection, sign-in, approvals, per-tool switches, edit and remove. */
import { useLiveQuery } from 'dexie-react-hooks';
import { ChevronRight, CircleCheck, LogIn, Pencil, Power, RefreshCw, Search, Server, Terminal, Trash2, X } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { getApp } from '../../app';
import { Dates } from '../../core/format';
import { db } from '../../data/db';
import type { McpServerEntity } from '../../data/entities';
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
import { ToolsStatus, ToolsToggleChip, errorText, isAbort, plural, useStableCallback } from './ToolsShared';

const APPROVALS: ToolApproval[] = ['ALWAYS', 'WRITES', 'NEVER'];

function updatedAgo(ms: number): string {
  const r = Dates.relative(ms);
  return r === 'Just now' ? 'updated just now' : `updated ${r}`;
}

function firstLine(text: string | null | undefined, max = 180): string {
  const line = (text ?? '').split(/\r?\n/).map((l) => l.trim()).find(Boolean) ?? '';
  return line.length > max ? line.slice(0, max - 1).trimEnd() + '…' : line;
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
        setPrepareError(errorText(e, 'Couldn’t start sign-in. Try again.'));
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
        (tools) => toast(`Signed in to ${server.name}. ${plural(tools.length, 'tool')} available.`),
        (e) => {
          if (!isAbort(e) && !ctrl.signal.aborted) setError(errorText(e, 'Sign-in didn’t complete. Try again.'));
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
        <ToolsStatus tone="info">This server was removed.</ToolsStatus>
        <span>
          <Button variant="tonal" onClick={() => ui.openSettings('tools')}>Back to Tools</Button>
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
  const enabledCount = tools.filter((t) => !disabled.has(t.name)).length;

  const state =
    !s.enabled ? { text: 'Off. Its tools aren’t offered to models.' }
      : cantRun ? { text: 'Runs only in the Facet app for Windows', warn: true }
        : connecting ? { text: 'Connecting…' }
          : s.status === MCP_STATUS_SIGN_IN ? { text: 'Sign in required', warn: true }
            : s.status === MCP_BROWSER_BLOCKED ? { text: 'Doesn’t work in web browsers', warn: true }
              : s.status ? { text: 'Couldn’t connect', warn: true }
                : s.toolsFetchedAt === 0 ? { text: 'Connecting…' }
                  : { text: `Connected · ${plural(tools.length, 'tool')} · ${updatedAgo(s.toolsFetchedAt)}`, ok: true };

  const refresh = async () => {
    setConnectError(null);
    signIn.clearError();
    try {
      const list = await connectMcp(id);
      toast(`Connected to ${s.name}. ${plural(list.length, 'tool')} available.`);
    } catch (e) {
      // refreshTools saves the problem as the server's status; keep only problems it didn't save.
      const msg = errorText(e, 'Couldn’t connect.');
      const fresh = await mcp.get(id);
      if (!(e instanceof McpAuthRequiredException) && fresh?.status !== msg) setConnectError(msg);
    }
  };

  const setAllTools = async (on: boolean) => {
    for (const t of tools) if (disabled.has(t.name) === on) await mcp.setToolEnabled(id, t.name, on);
  };

  const q = filter.trim().toLowerCase();
  const shown = q
    ? tools.filter((t) => t.name.toLowerCase().includes(q) || (t.title ?? '').toLowerCase().includes(q) || (t.description ?? '').toLowerCase().includes(q))
    : tools;

  return (
    <div className="col gap-16 tools-page">
      <div className="group mcp-hero">
        <span className="onboard-icon">{local ? <Terminal size={20} /> : <Server size={20} />}</span>
        <div className="col grow gap-4" style={{ minWidth: 0 }}>
          <div className="row gap-8" style={{ minWidth: 0 }}>
            <span className="t-title-m ellipsis">{s.name}</span>
            {local && <span className="badge">Local</span>}
          </div>
          <span className="mono mcp-hero-addr">{mcpAddress(s)}</span>
          <span className={'t-label-m row gap-6 ' + (state.warn ? 'c-warning' : 'c-2')} style={{ fontWeight: 400 }}>
            {state.ok && <span className="mcp-dot" aria-hidden />}
            {state.text}
          </span>
        </div>
        {s.enabled && !cantRun && !signIn.needed && (
          <div className="tools-actions">
            <Button variant="tonal" small busy={connecting} onClick={refresh}>
              {!connecting && <RefreshCw size={15} />} {s.toolsFetchedAt === 0 || s.status ? 'Connect' : 'Refresh tools'}
            </Button>
          </div>
        )}
      </div>

      {cantRun && <ToolsStatus tone="warning">Local servers run only in the Facet app for Windows.</ToolsStatus>}
      {s.enabled && s.status === MCP_BROWSER_BLOCKED && (
        <ToolsStatus tone="warning">{MCP_BROWSER_BLOCKED} Its settings sync, so it’s ready there.</ToolsStatus>
      )}
      {s.enabled && genericProblem && !connecting && (
        <ToolsStatus tone="error" action={<Button variant="text" small onClick={() => setDialog('edit')}>Edit</Button>}>
          {genericProblem}
        </ToolsStatus>
      )}
      {connectError && <ToolsStatus tone="error">{connectError}</ToolsStatus>}

      {signIn.needed && (
        <div className="group tools-callout">
          <div className="row gap-12" style={{ alignItems: 'flex-start' }}>
            <span className="onboard-icon"><LogIn size={20} /></span>
            <div className="col grow gap-4" style={{ minWidth: 0 }}>
              <span className="t-label-l">Sign in to {s.name}</span>
              <span className="t-label-m c-2" style={{ fontWeight: 400 }}>
                {s.name} needs you to sign in before its tools work. {signIn.web ? 'A sign-in window opens.' : 'Your browser opens.'} Tokens
                are encrypted and sync to your devices.
              </span>
            </div>
          </div>
          {signIn.prepareError ? (
            <ToolsStatus tone="error" action={<Button variant="text" small onClick={signIn.retryPrepare}>Try again</Button>}>
              {signIn.prepareError}
            </ToolsStatus>
          ) : signIn.running ? (
            <div className="row gap-12 tools-callout-actions">
              <Spinner />
              <span className="t-body c-2 grow">Waiting for you to finish signing in…</span>
              <Button variant="text" onClick={signIn.cancel}>Cancel</Button>
            </div>
          ) : (
            <div className="row gap-8 tools-callout-actions">
              <Button busy={signIn.preparing} disabled={!signIn.ready} onClick={signIn.start}>
                <LogIn size={16} /> Sign in
              </Button>
            </div>
          )}
          {signIn.error && <ToolsStatus tone="error">{signIn.error}</ToolsStatus>}
        </div>
      )}

      <div className="group">
        <SwitchRow
          icon={<Power size={20} />}
          title="Use this server"
          subtitle={
            s.enabled
              ? 'Its tools are offered to every model that supports tools.'
              : local ? 'Off: its tools aren’t offered and the program isn’t running.' : 'Off: its tools aren’t offered to models.'
          }
          checked={s.enabled}
          onChange={(v) => void mcp.setEnabled(id, v)}
        />
      </div>

      {signedIn && (
        <Group title="Account">
          <Row
            icon={<CircleCheck size={20} />}
            title="Signed in"
            subtitle="Tokens refresh automatically and sync to your devices."
            trailing={
              <Button
                variant="text"
                small
                onClick={async () => {
                  await mcp.signOut(id);
                  toast(`Signed out of ${s.name}.`);
                }}
              >
                Sign out
              </Button>
            }
          />
        </Group>
      )}

      <section className="col gap-8">
        <h3 className="group-title" style={{ margin: '6px 4px 0' }}>When to ask first</h3>
        <Segmented options={APPROVALS} selected={approval} label={(a) => TOOL_APPROVAL_INFO[a].label} onSelect={(a) => void mcp.setApproval(id, a)} />
        {yolo ? (
          <span className="field-hint c-warning row gap-8" style={{ marginLeft: 4, flexWrap: 'wrap' }}>
            YOLO mode is on, so these tools run without asking.
            <button type="button" className="tools-link" onClick={() => void app.settings.updateSynced((p) => ({ ...p, yoloMode: false }))}>
              Turn off YOLO mode
            </button>
          </span>
        ) : (
          <span className="field-hint" style={{ marginLeft: 4 }}>
            {TOOL_APPROVAL_INFO[approval].blurb} “Always allow” on a tool skips the question for that tool.
          </span>
        )}
      </section>

      {tools.length > 0 ? (
        <section>
          <div className="tools-group-head">
            <h3 className="group-title grow">
              Tools ({enabledCount === tools.length ? tools.length : `${enabledCount} of ${tools.length} on`})
            </h3>
            {tools.length > 1 && (
              <div className="tools-actions">
                <Button variant="text" small disabled={enabledCount === tools.length} onClick={() => void setAllTools(true)}>Turn all on</Button>
                <Button variant="text" small disabled={enabledCount === 0} onClick={() => void setAllTools(false)}>Turn all off</Button>
              </div>
            )}
          </div>
          {tools.length > 8 && (
            <div className="tools-search" style={{ marginBottom: 10 }}>
              <Search size={17} aria-hidden />
              <input className="input" type="search" value={filter} placeholder="Filter tools" aria-label="Filter tools" onChange={(e) => setFilter(e.target.value)} />
              {filter && (
                <IconButton small label="Clear filter" onClick={() => setFilter('')}>
                  <X size={16} />
                </IconButton>
              )}
            </div>
          )}
          <div className="group">
            {shown.map((t, i) => {
              const on = !disabled.has(t.name);
              const always = auto.has(t.name);
              const asks = approval === 'ALWAYS' || (approval === 'WRITES' && t.readOnlyHint !== true);
              const desc = firstLine(t.description);
              return (
                <div key={t.name}>
                  {i > 0 && <Divider full />}
                  <div className={'srow mcp-tool' + (on ? '' : ' off')}>
                    <span className="srow-text">
                      <span className="srow-title">{t.title || t.name}</span>
                      {t.title && t.title !== t.name && <span className="mono mcp-tool-name">{t.name}</span>}
                      {desc && <span className="srow-sub mcp-tool-desc">{desc}</span>}
                      {(t.readOnlyHint === true || t.destructiveHint === true) && (
                        <span className="row gap-6" style={{ marginTop: 4 }}>
                          {t.readOnlyHint === true ? <span className="badge">Read-only</span> : <span className="badge warning">Can delete or overwrite data</span>}
                        </span>
                      )}
                    </span>
                    <div className="mcp-tool-controls">
                      <ToolsToggleChip
                        on={always}
                        disabled={!on || (!asks && !always)}
                        title={!asks && !always ? 'This tool already runs without asking.' : always ? 'Runs without asking. Click to ask again.' : 'Run this tool without asking'}
                        icon={always ? <CircleCheck size={14} /> : undefined}
                        onChange={(v) => void mcp.setAutoApprove(id, t.name, v)}
                      >
                        Always allow
                      </ToolsToggleChip>
                      <Switch checked={on} label={`Use ${t.title || t.name}`} onChange={(v) => void mcp.setToolEnabled(id, t.name, v)} />
                    </div>
                  </div>
                </div>
              );
            })}
            {shown.length === 0 && <div className="srow t-body c-3">No tools match “{filter.trim()}”.</div>}
          </div>
        </section>
      ) : (
        s.toolsFetchedAt > 0 && <ToolsStatus tone="info">This server offers no tools.</ToolsStatus>
      )}

      {s.instructions?.trim() && (
        <details className="group tools-details">
          <summary>
            <ChevronRight size={18} className="tools-details-chev" aria-hidden />
            <span className="grow">Server instructions</span>
            <span className="field-hint">Shown to models with the tools</span>
          </summary>
          <div className="tools-details-body">{s.instructions.trim()}</div>
        </details>
      )}

      <div className="group">
        <Row icon={<Pencil size={20} />} title="Edit connection" subtitle={local ? 'Command, folder and environment' : 'Address, name and authentication'} onClick={() => setDialog('edit')} />
        <Divider />
        <Row icon={<Trash2 size={20} />} title="Remove server" danger chevron={false} onClick={() => setDialog('delete')} />
      </div>

      {dialog === 'edit' && (local ? <McpLocalDialog existing={s} onClose={closeDialog} /> : <McpRemoteDialog existing={s} onClose={closeDialog} />)}
      {dialog === 'delete' && (
        <Confirm
          title={`Remove ${s.name}?`}
          body={local ? 'It’s removed from this computer and its program stops.' : 'Its tools and sign-in are removed from all your devices.'}
          confirm="Remove"
          danger
          onConfirm={async () => {
            await mcp.delete(id);
            toast(`Removed ${s.name}.`);
            ui.openSettings('tools');
          }}
          onClose={closeDialog}
        />
      )}
    </div>
  );
}
