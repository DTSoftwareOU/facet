/** MCP servers on the Tools page: the server list and the "Add server" page (directory, custom, local). */
import { useLiveQuery } from 'dexie-react-hooks';
import { Link, Plus, Search, Server, Terminal, X } from 'lucide-react';
import { useMemo, useState } from 'react';
import { getApp } from '../../app';
import type { McpServerEntity } from '../../data/entities';
import { sentences, t, tm, tn } from '../../i18n';
import { platform } from '../../platform';
import { MCP_CATEGORIES, MCP_DIRECTORY, filterDirectory, mcpCategoryLabel, type McpCategory, type McpDirectoryEntry } from '../../tools/mcpDirectory';
import { MCP_BROWSER_BLOCKED, MCP_STATUS_SIGN_IN, joinCommandLine } from '../../tools/mcpManager';
import { TOOL_APPROVAL_INFO } from '../../tools/types';
import { Divider, Group, IconButton, Row, Switch } from '../components/primitives';
import { ui } from '../nav';
import { useMcpConnecting } from './McpConnect';
import { McpAuthBadge, McpLocalDialog, McpRemoteDialog } from './McpForms';
import { ToolsRow, ToolsSubhead, useStableCallback } from './ToolsShared';

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
  if (!s.enabled) return { text: t('Off') };
  if (s.stdio && !mcp.stdioAvailable) return { text: t('Runs only in the Facet app for Windows'), warn: true };
  if (connecting) return { text: t('Connecting…') };
  if (s.status === MCP_STATUS_SIGN_IN) return { text: t('Sign in required'), warn: true };
  if (s.status === MCP_BROWSER_BLOCKED) return { text: t('Works in the Windows and Android apps only'), warn: true };
  if (s.status) return { text: s.status, warn: true };
  // The app connects new servers (and ones synced from other devices) by itself.
  if (s.toolsFetchedAt === 0) return { text: t('Connecting…') };
  const tools = mcp.tools(s);
  const off = mcp.disabledTools(s);
  const on = tools.filter((tool) => !off.has(tool.name)).length;
  const count = on === tools.length ? tn('{count} tool', '{count} tools', tools.length) : t('{on} of {total} tools on', { on, total: tools.length });
  return { text: `${count} · ${tm(TOOL_APPROVAL_INFO[mcp.approval(s)].label)}` };
}

function McpServerRow({ server: s, connecting }: { server: McpServerEntity; connecting: boolean }) {
  const summary = mcpSummary(s, connecting);
  return (
    <ToolsRow
      icon={s.stdio ? <Terminal size={20} /> : <Server size={20} />}
      title={
        <span className="row gap-8">
          <span className="ellipsis"><bdi>{s.name}</bdi></span>
          {s.stdio && <span className="badge">{t('Local')}</span>}
        </span>
      }
      subtitle={
        <span className="tools-lines">
          <span className="mono tools-addr" dir="ltr">{mcpAddress(s)}</span>
          <span className={summary.warn ? 'c-warning' : undefined}>{summary.text}</span>
        </span>
      }
      onClick={() => ui.openSettings('tools', 'mcp:' + s.id)}
      trailing={<Switch checked={s.enabled} label={t('Use {name}', { name: s.name })} onChange={(v) => void getApp().mcp.setEnabled(s.id, v)} />}
    />
  );
}

/** The MCP group on the Tools overview. */
export function McpOverviewGroup() {
  const servers = useMcpServers();
  const connecting = useMcpConnecting();
  return (
    <Group
      title={t('MCP servers')}
      footer={t('Connect apps and data sources through the Model Context Protocol. Their tools work with any model that supports tools, in every chat. Connection details and sign-ins are end-to-end encrypted.')}
    >
      {servers?.map((s, i) => (
        <div key={s.id}>
          {i > 0 && <Divider />}
          <McpServerRow server={s} connecting={connecting.has(s.id)} />
        </div>
      ))}
      {servers && servers.length === 0 && (
        <Row icon={<Server size={20} />} title={t('No servers yet')} subtitle={t('Add GitHub, Notion, Linear and more from the directory, or any server by its address.')} />
      )}
      {servers && <Divider full={servers.length === 0} />}
      <ToolsRow icon={<Plus size={20} />} title={t('Add server')} tone="primary" onClick={() => ui.openSettings('tools', 'mcp:add')} />
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
        title={t('Add an MCP server')}
        subtitle={t('Connect apps and data sources through the Model Context Protocol. Their tools work with any model that supports tools, in every chat, on all your devices.')}
      />

      <div className="group">
        <ToolsRow
          icon={<Link size={20} />}
          title={t('Custom server')}
          subtitle={t('Any remote server by its address (Streamable HTTP or SSE).')}
          onClick={() => setDialog({ kind: 'remote', entry: null })}
        />
        {mcp.stdioAvailable && (
          <>
            <Divider />
            <ToolsRow
              icon={<Terminal size={20} />}
              title={t('Local command')}
              subtitle={t('Run a server on this computer, like an npx, uvx or docker command. It stays on this computer and doesn’t sync.')}
              onClick={() => setDialog({ kind: 'local' })}
            />
          </>
        )}
      </div>

      <section className="col gap-12">
        <h3 className="group-title" style={{ marginBottom: 0 }}>{t('From the directory')}</h3>
        <div className="tools-search">
          <Search size={17} aria-hidden />
          <input
            className="input"
            type="search"
            dir="auto"
            value={query}
            placeholder={t('Search {count} servers', { count: MCP_DIRECTORY.length })}
            aria-label={t('Search the directory')}
            onChange={(e) => setQuery(e.target.value)}
          />
          {query && (
            <IconButton small label={t('Clear search')} onClick={() => setQuery('')}>
              <X size={16} />
            </IconButton>
          )}
        </div>
        <div className="tools-chips" role="group" aria-label={t('Categories')}>
          <button
            type="button"
            className={'chip tools-chip' + (category == null && !q ? ' on' : '')}
            aria-pressed={category == null && !q}
            onClick={() => { setCategory(null); setQuery(''); }}
          >
            {t('Popular')}
          </button>
          {MCP_CATEGORIES.map((c) => (
            <button
              key={c.id}
              type="button"
              className={'chip tools-chip' + (category === c.id && !q ? ' on' : '')}
              aria-pressed={category === c.id && !q}
              onClick={() => { setCategory(c.id); setQuery(''); }}
            >
              {tm(c.label)}
            </button>
          ))}
        </div>
        {servers && list.length === 0 ? (
          <p className="t-body c-3" style={{ margin: '4px 6px' }}>
            {q ? t('No matches. You can add any remote server by its address with Custom server.') : t('You’ve added everything here.')}
          </p>
        ) : (
          <div className="group">
            {list.map((e, i) => (
              <div key={e.url}>
                {i > 0 && <Divider />}
                <Row
                  icon={<Plus size={20} />}
                  title={e.name}
                  subtitle={q ? `${tm(e.blurb)} · ${mcpCategoryLabel(e.category)}` : tm(e.blurb)}
                  trailing={<McpAuthBadge auth={e.auth} />}
                  onClick={() => setDialog({ kind: 'remote', entry: e })}
                />
              </div>
            ))}
          </div>
        )}
        <p className="field-hint" style={{ margin: '0 6px' }}>
          {sentences(
            t('Servers marked No sign-in work right away, Sign in servers ask you to sign in with your account, and Token servers need a key from the service.'),
            platform().corsLimited
              ? t('On the website, a server also has to accept connections from web browsers; the rest work in the Windows and Android apps.')
              : t('Tools that change things ask before they run unless you allow them.'),
            t('Servers are run by their owners, not by Facet; a listing doesn’t mean the owner endorses Facet.'),
          )}
        </p>
      </section>

      {dialog?.kind === 'remote' && <McpRemoteDialog entry={dialog.entry} onClose={closeDialog} />}
      {dialog?.kind === 'local' && <McpLocalDialog onClose={closeDialog} />}
    </div>
  );
}
