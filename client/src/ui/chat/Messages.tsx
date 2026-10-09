import {
  AlertCircle,
  Brain,
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ChevronUp,
  CircleX,
  Copy,
  FileText,
  Globe,
  Image as ImageIcon,
  Monitor,
  MoreHorizontal,
  Pencil,
  RefreshCw,
  Server,
  ShieldQuestion,
  Sparkles,
  Square,
  Trash2,
  Volume2,
  Wand2,
} from 'lucide-react';
import { memo, useEffect, useMemo, useState } from 'react';
import { getApp } from '../../app';
import { Format } from '../../core/format';
import { parseJson } from '../../core/json';
import { messageAttachments, messageCitations, messageError, messageUsage } from '../../data/conversations';
import type { MessageEntity } from '../../data/entities';
import type { ModelRef } from '../../data/prefs';
import type { LiveTurn, ToolActivity } from '../../domain/chat';
import type { Citation } from '../../llm/types';
import type { ToolTrace } from '../../tools/types';
import { Gem } from '../components/Gem';
import { Button, Dialog, IconButton, Menu, Spinner, useMenu, useToast } from '../components/primitives';
import { useLocalPrefs } from '../hooks';
import { Markdown, useSmoothedText } from '../markdown/Markdown';
import { markdownToPlain } from '../markdown/render';
import { AttachmentStrip } from './Attachments';
import { useReadAloud } from './speech';

export interface ThreadItem {
  message: MessageEntity;
  siblingIds: string[];
  siblingIndex: number;
}

export interface MessageActions {
  regenerate: (id: string, model?: ModelRef) => void;
  regenerateWith: (id: string) => void;
  editAndResend: (id: string, text: string) => void;
  switchBranch: (siblingId: string) => void;
  deleteMessage: (m: MessageEntity) => void;
  continueReply: () => void;
}

function BranchSwitcher({ item, actions }: { item: ThreadItem; actions: MessageActions }) {
  if (item.siblingIds.length < 2) return null;
  const i = item.siblingIndex;
  return (
    <span className="branch">
      <IconButton label="Previous version" small disabled={i === 0} onClick={() => actions.switchBranch(item.siblingIds[i - 1])}>
        <ChevronLeft size={16} />
      </IconButton>
      {i + 1}/{item.siblingIds.length}
      <IconButton label="Next version" small disabled={i === item.siblingIds.length - 1} onClick={() => actions.switchBranch(item.siblingIds[i + 1])}>
        <ChevronRight size={16} />
      </IconButton>
    </span>
  );
}

export const UserMessage = memo(function UserMessage({ item, actions, busy }: { item: ThreadItem; actions: MessageActions; busy: boolean }) {
  const m = item.message;
  const toast = useToast();
  const atts = useMemo(() => messageAttachments(m), [m.attachmentsJson]);
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(m.content);
  const local = useLocalPrefs();

  if (editing) {
    return (
      <div className="user-msg turn">
        <div className="edit-box">
          <textarea
            autoFocus
            rows={Math.min(12, Math.max(2, text.split('\n').length))}
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Escape') setEditing(false);
              if (e.key === 'Enter' && (e.ctrlKey || e.metaKey || (local.sendOnEnter && !e.shiftKey))) {
                e.preventDefault();
                if (text.trim()) {
                  setEditing(false);
                  actions.editAndResend(m.id, text);
                }
              }
            }}
            aria-label="Edit message"
          />
          <div className="row gap-8" style={{ justifyContent: 'flex-end' }}>
            <Button variant="text" small onClick={() => setEditing(false)}>Cancel</Button>
            <Button small disabled={!text.trim() || busy} onClick={() => { setEditing(false); actions.editAndResend(m.id, text); }}>Send</Button>
          </div>
        </div>
      </div>
    );
  }
  return (
    <div className="user-msg turn">
      {atts.length > 0 && <AttachmentStrip atts={atts} />}
      {m.content.trim() && <div className="user-bubble">{m.content}</div>}
      <div className="row gap-4">
        <BranchSwitcher item={item} actions={actions} />
        <div className="user-actions">
          <IconButton label="Copy" small onClick={() => { void navigator.clipboard.writeText(m.content); toast('Copied.'); }}>
            <Copy size={15} />
          </IconButton>
          <IconButton label="Edit and resend" small disabled={busy} onClick={() => { setText(m.content); setEditing(true); }}>
            <Pencil size={15} />
          </IconButton>
        </div>
      </div>
    </div>
  );
});

function useElapsed(since: number | null, active: boolean): number {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!active) return;
    const t = setInterval(() => setNow(Date.now()), 500);
    return () => clearInterval(t);
  }, [active]);
  return since ? Math.max(0, now - since) : 0;
}

function ThinkingPanel({ text, active, startedAt, ms, showText }: { text: string; active: boolean; startedAt: number | null; ms: number | null; showText: boolean }) {
  const local = useLocalPrefs();
  const [open, setOpen] = useState(local.expandThinking);
  const elapsed = useElapsed(startedAt, active);
  if (!active && !text && !ms) return null;
  const label = active ? 'Thinking' : ms ? `Thought for ${Format.seconds(ms)}` : 'Thought';
  const canOpen = showText && !!text.trim();
  return (
    <div className="thinking">
      <button type="button" className="thinking-toggle" onClick={() => canOpen && setOpen(!open)} aria-expanded={canOpen ? open : undefined}>
        {active ? <Gem size={18} thinking /> : <Brain size={18} />}
        <span>{label}{active && elapsed > 1500 ? ` · ${Format.seconds(elapsed)}` : ''}</span>
        {canOpen && (open ? <ChevronUp size={16} /> : <ChevronDown size={16} />)}
      </button>
      {canOpen && (open || (active && local.expandThinking)) && <div className={'thinking-body' + (active ? '' : ' done')}>{text}</div>}
      {canOpen && active && !open && !local.expandThinking && (
        <div className="thinking-body" style={{ maxHeight: 66, overflow: 'hidden', maskImage: 'linear-gradient(transparent, black 60%)' }}>
          {text.slice(-400)}
        </div>
      )}
    </div>
  );
}

function toolIcon(t: ToolActivity) {
  switch (t.kind) {
    case 'SEARCH':
      return <Globe size={16} />;
    case 'FETCH':
      return <FileText size={16} />;
    case 'SKILL':
      return <Wand2 size={16} />;
    case 'MEDIA':
      return <ImageIcon size={16} />;
    case 'COMPUTER':
      return <Monitor size={16} />;
    default:
      return <Server size={16} />;
  }
}

function statusIcon(t: ToolActivity) {
  switch (t.status) {
    case 'PREPARING':
    case 'RUNNING':
      return <Spinner size={14} />;
    case 'AWAITING_APPROVAL':
      return <ShieldQuestion size={16} className="c-warning" />;
    case 'DONE':
      return <Check size={16} className="c-success" />;
    case 'DENIED':
      return <CircleX size={16} className="c-3" />;
    default:
      return <AlertCircle size={16} className="c-error" />;
  }
}

function prettyArgs(json: string): string {
  const obj = parseJson<Record<string, unknown> | null>(json, null);
  if (!obj) return json;
  return JSON.stringify(obj, null, 2);
}

/** What the model wants to do, in words, for the approval card. */
function approvalSummary(t: ToolActivity): { title: string; detail: string | null } {
  const args = parseJson<Record<string, any>>(t.argumentsJson, {});
  if (t.kind === 'COMPUTER') {
    switch (t.name) {
      case 'run_command':
        return { title: 'Run this command?', detail: String(args.command ?? '') };
      case 'write_file':
        return { title: `Write ${args.path}?`, detail: String(args.content ?? '').slice(0, 2000) };
      case 'edit_file':
        return { title: `Edit ${args.path}?`, detail: `- ${String(args.old_string ?? '').split('\n').join('\n- ')}\n+ ${String(args.new_string ?? '').split('\n').join('\n+ ')}`.slice(0, 3000) };
      case 'stop_process':
        return { title: 'Stop this background process?', detail: String(args.id ?? '') };
      case 'open_path':
        return { title: `Open ${args.path}?`, detail: null };
      default:
        return { title: `Allow ${t.name.replace(/_/g, ' ')}?`, detail: prettyArgs(t.argumentsJson) };
    }
  }
  if (t.kind === 'MEDIA') return { title: 'Create this video?', detail: String(args.prompt ?? '') };
  return { title: `Allow ${t.label}?`, detail: t.argumentsJson && t.argumentsJson !== '{}' ? prettyArgs(t.argumentsJson) : null };
}

function ToolItem({ t, live }: { t: ToolActivity; live: boolean }) {
  const [open, setOpen] = useState(false);
  const app = getApp();
  const waiting = live && t.status === 'AWAITING_APPROVAL';
  const summary = waiting ? approvalSummary(t) : null;
  return (
    <div className="tool-item">
      <button type="button" className="tool-line" onClick={() => setOpen(!open)} aria-expanded={open}>
        {toolIcon(t)}
        <span className="label">{t.label}</span>
        {statusIcon(t)}
        {open ? <ChevronUp size={15} /> : <ChevronDown size={15} />}
      </button>
      {waiting && summary && (
        <div className="approval">
          <span className="t-label-l">{summary.title}</span>
          {summary.detail && <div className="tool-detail" style={{ borderRadius: 10, border: 0 }}>{summary.detail}</div>}
          <div className="approval-actions">
            <Button small onClick={() => app.chat.respondToApproval(t.id, 'ALLOW')}>Allow</Button>
            {(t.kind === 'MCP' || t.kind === 'COMPUTER') && (
              <Button small variant="tonal" onClick={() => app.chat.respondToApproval(t.id, 'ALWAYS')}>
                {t.kind === 'MCP' ? 'Always allow this tool' : 'Allow for this chat'}
              </Button>
            )}
            <Button small variant="outline" onClick={() => app.chat.respondToApproval(t.id, 'DENY')}>Deny</Button>
          </div>
        </div>
      )}
      {open && (
        <div className="tool-detail">
          {t.serverName && <div className="k">{t.serverName} · {t.name}</div>}
          {t.argumentsJson && t.argumentsJson !== '{}' && (
            <>
              <div className="k">Input</div>
              {prettyArgs(t.argumentsJson)}
              {'\n\n'}
            </>
          )}
          {t.result != null && (
            <>
              <div className="k">Result</div>
              {t.result}
            </>
          )}
        </div>
      )}
    </div>
  );
}

function storedTools(m: MessageEntity): ToolActivity[] {
  const trace = parseJson<ToolTrace | null>(m.stepsJson, null);
  if (!trace?.steps) return [];
  return trace.steps.flatMap((s) =>
    s.calls.map((c) => ({
      id: c.id, name: c.name, kind: (c.kind as ToolActivity['kind']) ?? 'MCP', label: c.label, argumentsJson: c.argumentsJson,
      result: c.result.slice(0, 2000), serverName: c.serverName ?? null,
      status: c.isError ? (c.result.startsWith('The user declined') ? 'DENIED' : 'ERROR') : 'DONE',
    }) as ToolActivity),
  );
}

function hostOf(url: string) {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return url;
  }
}

function Citations({ list }: { list: Citation[] }) {
  if (!list.length) return null;
  return (
    <div className="citations">
      {list.map((c, i) => (
        <a key={c.url} className="citation" href={c.url} target="_blank" rel="noopener noreferrer" title={c.snippet ?? c.url}>
          <span className="num">{i + 1}</span>
          <span className="col" style={{ minWidth: 0 }}>
            <span className="t ellipsis">{c.title || hostOf(c.url)}</span>
            <span className="h ellipsis">{hostOf(c.url)}</span>
          </span>
        </a>
      ))}
    </div>
  );
}

function UsageDialog({ m, onClose }: { m: MessageEntity; onClose: () => void }) {
  const u = messageUsage(m);
  if (!u) return null;
  const rows: [string, string][] = [
    ['Input tokens', u.inputTokens.toLocaleString()],
    ['  of which cached', u.cacheReadTokens.toLocaleString()],
    ['  of which written to cache', u.cacheWriteTokens.toLocaleString()],
    ['Output tokens', u.outputTokens.toLocaleString()],
    ['  of which reasoning', u.reasoningTokens.toLocaleString()],
    ['Estimated cost', m.costUsd != null ? Format.cost(m.costUsd) : 'Unknown (no price for this model)'],
    ['Model', m.modelName ?? m.modelId ?? ''],
  ];
  return (
    <Dialog title="Usage" onClose={onClose} size="narrow">
      <div className="col gap-8">
        {rows.map(([k, v]) => (
          <div key={k} className="row" style={{ justifyContent: 'space-between', gap: 16 }}>
            <span className={k.startsWith('  ') ? 'c-3' : 'c-2'} style={{ paddingLeft: k.startsWith('  ') ? 14 : 0 }}>{k.trim()}</span>
            <span>{v}</span>
          </div>
        ))}
        <p className="field-hint">Estimates from the provider's token counts and published prices.</p>
      </div>
    </Dialog>
  );
}

export const AssistantMessage = memo(function AssistantMessage({ item, live, actions, last }: {
  item: ThreadItem;
  live: LiveTurn | undefined;
  actions: MessageActions;
  last: boolean;
}) {
  const m = item.message;
  const toast = useToast();
  const local = useLocalPrefs();
  const more = useMenu();
  const [usageOpen, setUsageOpen] = useState(false);
  const read = useReadAloud();
  const streaming = !!live;
  const rawText = live ? live.text : m.content;
  const text = useSmoothedText(rawText, streaming, local.reducedMotion);
  const thinking = live ? live.thinking : m.thinking ?? '';
  const tools = live ? live.tools : storedTools(m);
  const citations = live ? live.citations : messageCitations(m);
  const atts = live ? live.attachments : messageAttachments(m);
  const err = messageError(m);
  const usage = messageUsage(m);
  const showThinking = true;
  const status = m.status;
  const waitingForFirst = streaming && !text && !live!.thinkingActive && !thinking && tools.length === 0;

  const copy = () => {
    void navigator.clipboard.writeText(m.content);
    toast('Copied.');
  };

  return (
    <div className="turn">
      <div className="assistant-head">
        <Gem size={20} thinking={streaming && (live!.thinkingActive || waitingForFirst || live!.searching)} />
        <span>{m.modelName || m.modelId || 'Assistant'}</span>
        {live?.searching && <span className="served">Searching{live.searchQuery ? ` “${live.searchQuery}”` : ' the web'}…</span>}
      </div>
      {(thinking || live?.thinkingActive || m.thinkingMs) && (
        <ThinkingPanel text={thinking} active={!!live?.thinkingActive} startedAt={live?.thinkingStartedAt ?? null} ms={live ? live.thinkingMs || null : m.thinkingMs ?? null} showText={showThinking} />
      )}
      {tools.length > 0 && (
        <div className="tool-list">
          {tools.map((t) => <ToolItem key={t.id} t={t} live={streaming} />)}
        </div>
      )}
      {text ? <Markdown text={text} streaming={streaming} /> : waitingForFirst ? <div className="c-3 t-body">Waiting for {m.modelName ?? 'the model'}…</div> : null}
      {atts.length > 0 && <AttachmentStrip atts={atts} align="start" />}
      <Citations list={citations} />
      {live?.notice && <div className="notice"><Sparkles size={16} /><span className="grow">{live.notice}</span></div>}
      {!streaming && status === 'ERROR' && err && (
        <div className="notice error" role="alert">
          <AlertCircle size={18} style={{ flex: 'none', marginTop: 2 }} />
          <div className="grow col gap-4">
            <span>{err.message}</span>
            {err.detail && <span className="t-label-s" style={{ opacity: 0.8, fontWeight: 400 }}>{err.detail}</span>}
          </div>
          {last && <Button small variant="outline" onClick={() => actions.regenerate(m.id)}>Try again</Button>}
        </div>
      )}
      {!streaming && status === 'REFUSED' && <div className="notice">The model declined to answer this request.</div>}
      {!streaming && status === 'STOPPED' && !m.content && <div className="notice">Stopped.</div>}
      {!streaming && status === 'TRUNCATED' && last && (
        <div className="notice">
          <span className="grow">The reply reached the output limit.</span>
          <Button small variant="tonal" onClick={actions.continueReply}>Continue</Button>
        </div>
      )}
      {!streaming && (
        <div className="msg-actions">
          <IconButton label="Copy" small onClick={copy} disabled={!m.content}>
            <Copy size={16} />
          </IconButton>
          <IconButton label="Regenerate" small onClick={() => actions.regenerate(m.id)}>
            <RefreshCw size={16} />
          </IconButton>
          <IconButton
            label={read.speaking === m.id ? 'Stop reading' : 'Read aloud'}
            small
            active={read.speaking === m.id}
            disabled={!m.content}
            onClick={() => read.toggle(m.id, m.content).catch((e) => toast((e as Error).message))}
          >
            {read.loading === m.id ? <Spinner size={14} /> : read.speaking === m.id ? <Square size={14} /> : <Volume2 size={16} />}
          </IconButton>
          <IconButton label="More" small onClick={more.open}>
            <MoreHorizontal size={16} />
          </IconButton>
          <BranchSwitcher item={item} actions={actions} />
          {local.showUsage && usage && (
            <button type="button" className="msg-meta" onClick={() => setUsageOpen(true)} title="Usage details">
              {Format.tokens(usage.inputTokens)} in · {Format.tokens(usage.outputTokens)} out
              {local.showCost && m.costUsd != null ? ` · ${Format.cost(m.costUsd)}` : ''}
            </button>
          )}
        </div>
      )}
      {more.anchor && (
        <Menu
          anchor={more.anchor}
          onClose={more.close}
          items={[
            { label: 'Regenerate with another model', icon: <RefreshCw size={17} />, onSelect: () => actions.regenerateWith(m.id) },
            { label: 'Copy as plain text', icon: <Copy size={17} />, onSelect: () => { void navigator.clipboard.writeText(markdownToPlain(m.content)); toast('Copied.'); } },
            { label: 'Delete', icon: <Trash2 size={17} />, danger: true, separatorBefore: true, onSelect: () => actions.deleteMessage(m) },
          ]}
        />
      )}
      {usageOpen && <UsageDialog m={m} onClose={() => setUsageOpen(false)} />}
    </div>
  );
});
