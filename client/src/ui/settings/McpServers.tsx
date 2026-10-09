/** MCP servers on the Tools page: the server list and the "Add server" page (directory, custom, local). */
import { useLiveQuery } from 'dexie-react-hooks';
import { Link, Plus, Search, Server, Terminal, X } from 'lucide-react';
import { useMemo, useState } from 'react';
import { getApp } from '../../app';
import type { McpServerEntity } from '../../data/entities';
import { platform } from '../../platform';
import { MCP_CATEGORIES, MCP_DIRECTORY, filterDirectory, mcpCategoryLabel, type McpCategory, type McpDirectoryEntry } from '../../tools/mcpDirectory';
import { MCP_BROWSER_BLOCKED, MCP_STATUS_SIGN_IN, joinCommandLine } from '../../tools/mcpManager';
import { TOOL_APPROVAL_INFO } from '../../tools/types';
import { Divider, Group, IconButton, Row, Switch } from '../components/primitives';
import { ui } from '../nav';
import { useMcpConnecting } from './McpConnect';
import { McpAuthBadge, McpLocalDialog, McpRemoteDialog } from './McpForms';
import { ToolsRow, ToolsSubhead, plural, useStableCallback } from './ToolsShared';

/** Live list of MCP servers (undefined while loading). */
export function useMcpServers(): McpServerEntity[] | undefined {
  return useLiveQuery(() => getApp().mcp.all(), []);
}

/** The address shown under a server's name: its URL, or its command line for a local server. */
export function mcpAddress(s: McpServerEntity): string {
  return s.stdio ? joinCommandLine([s.stdio.command, ...s.stdio.args]) : s.url.replace(/^https?:\/\//, '');
}

/** One line on a server's state: off, connecting, a problem, or its tools and approval mode. */
export function mcpSummary(s: McpServerEntity, connecting: boolean): { text: string; warn?: boolean } {
  const mcp = getApp().mcp;
  if (!s.enabled) return { text: 'Off' };
  if (s.stdio && !mcp.stdioAvailable) return { text: 'Runs only in the Facet app for Windows', warn: true };
  if (connecting) return { text: 'Connecting…' };
  if (s.status === MCP_STATUS_SIGN_IN) return { text: 'Sign in required', warn: true };
  if (s.status === MCP_BROWSER_BLOCKED) return { text: 'Works in the Windows and Android apps only', warn: true };
  if (s.status) return { text: s.status, warn: true };
  // The app connects new servers (and ones synced from other devices) by itself.
  if (s.toolsFetchedAt === 0) return { text: 'Connecting…' };
  const tools = mcp.tools(s);
  const off = mcp.disabledTools(s);
  const on = tools.filter((t) => !off.has(t.name)).length;
  const count = on === tools.length ? plural(tools.length, 'tool') : `${on} of ${tools.length} tools on`;
  return { text: `${count} · ${TOOL_APPROVAL_INFO[mcp.approval(s)].label}` };
}

function McpServerRow({ server: s, connecting }: { server: McpServerEntity; connecting: boolean }) {
  const summary = mcpSummary(s, connecting);
  return (
    <ToolsRow
      icon={s.stdio ? <Terminal size={20} /> : <Server size={20} />}
      title={
        <span className="row gap-8">
          <span className="ellipsis">{s.name}</span>
          {s.stdio && <span className="badge">Local</span>}
        </span>
      }
      subtitle={
        <span className="tools-lines">
          <span className="mono tools-addr">{mcpAddress(s)}</span>
          <span className={summary.warn ? 'c-warning' : undefined}>{summary.text}</span>
        </span>
      }
      onClick={() => ui.openSettings('tools', 'mcp:' + s.id)}
      trailing={<Switch checked={s.enabled} label={`Use ${s.name}`} onChange={(v) => void getApp().mcp.setEnabled(s.id, v)} />}
    />
  );
}

/** The MCP group on the Tools overview. */
export function McpOverviewGroup() {
  const servers = useMcpServers();
  const connecting = useMcpConnecting();
  return (
    <Group
      title="MCP servers"
      footer="Connect apps and data sources through the Model Context Protocol. Their tools work with any model that supports tools, in every chat. Connection details and sign-ins are end-to-end encrypted."
    >
      {servers?.map((s, i) => (
        <div key={s.id}>
          {i > 0 && <Divider />}
          <McpServerRow server={s} connecting={connecting.has(s.id)} />
        </div>
      ))}
      {servers && servers.length === 0 && (
        <Row icon={<Server size={20} />} title="No servers yet" subtitle="Add GitHub, Notion, Linear and more from the directory, or any server by its address." />
      )}
      {servers && <Divider full={servers.length === 0} />}
      <ToolsRow icon={<Plus size={20} />} title="Add server" tone="primary" onClick={() => ui.openSettings('tools', 'mcp:add')} />
    </Group>
  );
}

type AddDialog = { kind: 'remote'; entry: McpDirectoryEntry | null } | { kind: 'local' } | null;

/** Settings → Tools → Add server. [local] opens the local command form right away (Windows app). */
export function McpAddPage({ local }: { local?: boolean }) {
  const mcp = getApp().mcp;
  const servers = useMcpServers();
  const [query, setQuery] = useState('');
  const [category, setCategory] = useState<McpCategory | null>(null);
  const [dialog, setDialog] = useState<AddDialog>(local && mcp.stdioAvailable ? { kind: 'local' } : null);
  const closeDialog = useStableCallback(() => setDialog(null));
  const q = query.trim();
  const list = useMemo(() => filterDirectory(query, category, (servers ?? []).map((s) => s.url)), [query, category, servers]);

  return (
    <div className="col gap-16 tools-page">
      <ToolsSubhead
        title="Add an MCP server"
        subtitle="Connect apps and data sources through the Model Context Protocol. Their tools work with any model that supports tools, in every chat, on all your devices."
      />

      <div className="group">
        <ToolsRow
          icon={<Link size={20} />}
          title="Custom server"
          subtitle="Any remote server by its address (Streamable HTTP or SSE)."
          onClick={() => setDialog({ kind: 'remote', entry: null })}
        />
        {mcp.stdioAvailable && (
          <>
            <Divider />
            <ToolsRow
              icon={<Terminal size={20} />}
              title="Local command"
              subtitle="Run a server on this computer, like an npx, uvx or docker command. It stays on this computer and doesn’t sync."
              onClick={() => setDialog({ kind: 'local' })}
            />
          </>
        )}
      </div>

      <section className="col gap-12">
        <h3 className="group-title" style={{ marginBottom: 0 }}>From the directory</h3>
        <div className="tools-search">
          <Search size={17} aria-hidden />
          <input
            className="input"
            type="search"
            value={query}
            placeholder={`Search ${MCP_DIRECTORY.length} servers`}
            aria-label="Search the directory"
            onChange={(e) => setQuery(e.target.value)}
          />
          {query && (
            <IconButton small label="Clear search" onClick={() => setQuery('')}>
              <X size={16} />
            </IconButton>
          )}
        </div>
        <div className="tools-chips" role="group" aria-label="Categories">
          <button
            type="button"
            className={'chip tools-chip' + (category == null && !q ? ' on' : '')}
            aria-pressed={category == null && !q}
            onClick={() => { setCategory(null); setQuery(''); }}
          >
            Popular
          </button>
          {MCP_CATEGORIES.map((c) => (
            <button
              key={c.id}
              type="button"
              className={'chip tools-chip' + (category === c.id && !q ? ' on' : '')}
              aria-pressed={category === c.id && !q}
              onClick={() => { setCategory(c.id); setQuery(''); }}
            >
              {c.label}
            </button>
          ))}
        </div>
        {servers && list.length === 0 ? (
          <p className="t-body c-3" style={{ margin: '4px 6px' }}>
            {q ? 'No matches. You can add any remote server by its address with Custom server.' : 'You’ve added everything here.'}
          </p>
        ) : (
          <div className="group">
            {list.map((e, i) => (
              <div key={e.url}>
                {i > 0 && <Divider />}
                <Row
                  icon={<Plus size={20} />}
                  title={e.name}
                  subtitle={q ? `${e.blurb} · ${mcpCategoryLabel(e.category)}` : e.blurb}
                  trailing={<McpAuthBadge auth={e.auth} />}
                  onClick={() => setDialog({ kind: 'remote', entry: e })}
                />
              </div>
            ))}
          </div>
        )}
        <p className="field-hint" style={{ margin: '0 6px' }}>
          Open servers work right away, Sign in servers ask you to sign in with your account, and Token servers need a key from the service.
          {platform().corsLimited
            ? ' On the website, a server also has to accept connections from web browsers; the rest work in the Windows and Android apps.'
            : ' Tools that change things ask before they run unless you allow them.'}
        </p>
      </section>

      {dialog?.kind === 'remote' && <McpRemoteDialog entry={dialog.entry} onClose={closeDialog} />}
      {dialog?.kind === 'local' && <McpLocalDialog onClose={closeDialog} />}
    </div>
  );
}
