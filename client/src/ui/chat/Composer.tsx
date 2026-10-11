import { useLiveQuery } from 'dexie-react-hooks';
import { ArrowUp, Brain, FolderOpen, Globe, Library, Mic, Monitor, MonitorOff, Paperclip, Plus, Rocket, Square, X } from 'lucide-react';
import { forwardRef, useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState, type ClipboardEvent, type DragEvent, type KeyboardEvent, type ReactNode } from 'react';
import { getApp } from '../../app';
import type { AttachmentEntity } from '../../data/entities';
import { t, tm } from '../../i18n';
import { EFFORT_INFO, type GenParams } from '../../llm/types';
import type { ComputerState } from '../../remote/computers';
import { isSearchKind } from '../../tools/types';
import { db } from '../../data/db';
import { IconButton, Menu, Spinner, useMenu, useToast } from '../components/primitives';
import { useLocalPrefs, usePrompts, useSyncedPrefs } from '../hooks';
import { ui } from '../nav';
import { FileChip } from './Attachments';
import { folderName } from './ComputerDialog';
import type { ResolvedModel } from './ModelPicker';
import { useDictation } from './speech';

/** A slash command in the message box (docs/REMOTE.md). */
export interface SlashCommand {
  /** Without the slash, e.g. "resume-from-claude". */
  name: string;
  description: string;
  icon: ReactNode;
  run: () => void;
}

/**
 * "Code review" → "code-review", for saved prompts as commands. Latin accents are dropped
 * ("Café" → "cafe"); other scripts keep their letters, so a Hindi or Japanese title still makes a command.
 */
export function commandName(title: string): string {
  return (
    title.toLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g, '').normalize('NFC')
      .replace(/[^\p{L}\p{M}\p{N}]+/gu, '-').replace(/^-+|-+$/g, '') || 'prompt'
  );
}

type SlashItem =
  | { kind: 'command'; key: string; name: string; description: string; icon: ReactNode; run: () => void }
  | { kind: 'prompt'; key: string; name: string; description: string; body: string };

export interface ComposerHandle {
  focus(): void;
  setText(text: string): void;
  addFiles(files: File[]): void;
}

function draftKey(conversationId: string | null) {
  return 'facet.draft.' + (conversationId ?? 'new');
}

function readDraft(conversationId: string | null): string {
  try {
    return localStorage.getItem(draftKey(conversationId)) ?? '';
  } catch {
    return '';
  }
}

function writeDraft(conversationId: string | null, text: string) {
  try {
    if (text) localStorage.setItem(draftKey(conversationId), text);
    else localStorage.removeItem(draftKey(conversationId));
  } catch {
    // Storage unavailable: drafts just don't survive a reload.
  }
}

function DraftThumb({ a, onRemove }: { a: AttachmentEntity; onRemove: () => void }) {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    if (a.kind === 'image') void getApp().attachments.url(a.id).then(setUrl);
  }, [a.id, a.kind]);
  return (
    <div className="composer-att">
      {a.kind === 'image' && url ? <img src={url} alt={a.name} /> : <FileChip att={a} />}
      <button type="button" className="x" aria-label={t('Remove {name}', { name: a.name })} onClick={onRemove}>
        <X size={13} />
      </button>
    </div>
  );
}

export const Composer = forwardRef<ComposerHandle, {
  conversationId: string | null;
  model: ResolvedModel | null;
  params: GenParams;
  onParams: (p: GenParams) => void;
  busy: boolean;
  onSend: (text: string, attachmentIds: string[]) => Promise<boolean>;
  onStop: () => void;
  /** The chat's computer, for the PC chip; null while loading. */
  computer: ComputerState | null;
  /** Some PC of the account is online (shows "Use a PC" on chats without one). */
  pcsOnline: boolean;
  /** Opens the folder or PC chooser. */
  onComputer: (() => void) | null;
  commands: SlashCommand[];
}>(function Composer({ conversationId, model, params, onParams, busy, onSend, onStop, computer, pcsOnline, onComputer, commands }, ref) {
  const app = getApp();
  const toast = useToast();
  const local = useLocalPrefs();
  const synced = useSyncedPrefs();
  const prompts = usePrompts() ?? [];
  const [text, setText] = useState(() => readDraft(conversationId));
  const [atts, setAtts] = useState<AttachmentEntity[]>([]);
  const [importing, setImporting] = useState(0);
  const [drag, setDrag] = useState(false);
  const [slashIndex, setSlashIndex] = useState(0);
  const area = useRef<HTMLTextAreaElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const effortMenu = useMenu();
  const plusMenu = useMenu();
  const caps = model?.model.caps;
  const searchAvailable = useLiveQuery(async () => (await db().providers.filter((p) => p.deleted === 0 && p.enabled && isSearchKind(p.kind)).count()) > 0, []) ?? false;
  const canSearch = !!caps && (caps.webSearch || (caps.tools && searchAvailable));

  useEffect(() => {
    setText(readDraft(conversationId));
    setAtts([]);
  }, [conversationId]);
  useEffect(() => writeDraft(conversationId, text), [conversationId, text]);

  // Grow with the text up to 40% of the window.
  useEffect(() => {
    const el = area.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = Math.min(el.scrollHeight, window.innerHeight * 0.4) + 'px';
  }, [text]);

  const addFiles = useCallback(async (files: File[]) => {
    for (const f of files) {
      setImporting((n) => n + 1);
      try {
        const a = await app.attachments.import(f);
        setAtts((list) => [...list, a]);
      } catch (e) {
        toast((e as Error).message);
      } finally {
        setImporting((n) => n - 1);
      }
    }
  }, [app, toast]);

  useImperativeHandle(ref, () => ({
    focus: () => area.current?.focus(),
    setText: (value) => {
      setText(value);
      setTimeout(() => area.current?.focus(), 0);
    },
    addFiles: (files) => void addFiles(files),
  }), [addFiles]);

  const dictation = useDictation(
    useCallback((spoken: string) => setText((cur) => (cur.trim() ? cur.replace(/\s*$/, ' ') + spoken : spoken)), []),
    useCallback((m: string) => toast(m), [toast]),
  );

  const slash = useMemo((): SlashItem[] | null => {
    const m = /^\/(\S*)$/.exec(text);
    if (!m) return null;
    const q = m[1].toLowerCase();
    const cmds: SlashItem[] = commands
      .filter((c) => c.name.includes(q))
      .sort((a, b) => Number(!a.name.startsWith(q)) - Number(!b.name.startsWith(q)))
      .map((c) => ({ kind: 'command', key: 'c:' + c.name, name: c.name, description: c.description, icon: c.icon, run: c.run }));
    const saved: SlashItem[] = prompts
      .map((p) => ({ p, name: commandName(p.title) }))
      .filter(({ p, name }) => name.includes(q) || p.title.toLowerCase().includes(q) || p.body.toLowerCase().includes(q))
      .map(({ p, name }) => ({ kind: 'prompt', key: 'p:' + p.id, name, description: p.title, body: p.body }));
    return [...cmds, ...saved].slice(0, 10);
  }, [text, prompts, commands]);

  const pick = (item: SlashItem) => {
    if (item.kind === 'prompt') {
      setText(item.body);
      return;
    }
    setText('');
    item.run();
  };

  const canSend = !busy && importing === 0 && (text.trim().length > 0 || atts.length > 0);

  const send = async () => {
    if (!canSend) return;
    const ok = await onSend(text, atts.map((a) => a.id));
    if (ok) {
      setText('');
      setAtts([]);
      writeDraft(conversationId, '');
    }
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (slash && slash.length) {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        setSlashIndex((i) => (i + (e.key === 'ArrowDown' ? 1 : -1) + slash.length) % slash.length);
        return;
      }
      if (e.key === 'Enter' || e.key === 'Tab') {
        e.preventDefault();
        pick(slash[Math.min(slashIndex, slash.length - 1)]);
        return;
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        setText('');
        return;
      }
    }
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing && (local.sendOnEnter || e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      void send();
    }
  };

  const onPaste = (e: ClipboardEvent) => {
    const files = [...e.clipboardData.files];
    if (files.length) {
      e.preventDefault();
      void addFiles(files);
    }
  };

  const onDrop = (e: DragEvent) => {
    e.preventDefault();
    setDrag(false);
    const files = [...e.dataTransfer.files];
    if (files.length) void addFiles(files);
  };

  const effortLabel = params.effort ? tm(EFFORT_INFO[params.effort].label) : t('Auto');

  return (
    <div className="composer-wrap">
      <div
        className={'composer' + (drag ? ' drag' : '')}
        onDragOver={(e) => {
          if (e.dataTransfer.types.includes('Files')) {
            e.preventDefault();
            setDrag(true);
          }
        }}
        onDragLeave={() => setDrag(false)}
        onDrop={onDrop}
      >
        {slash && slash.length > 0 && (
          <div className="slash-menu" role="listbox" aria-label={t('Commands and saved prompts')}>
            {slash.map((item, i) => (
              <button
                key={item.key}
                type="button"
                role="option"
                aria-selected={i === slashIndex}
                className="menu-item"
                style={i === slashIndex ? { background: 'var(--surface-high)' } : undefined}
                onMouseEnter={() => setSlashIndex(i)}
                onMouseDown={(e) => {
                  e.preventDefault();
                  pick(item);
                }}
              >
                {item.kind === 'command' ? item.icon : <Library size={16} />}
                <span className="col" style={{ minWidth: 0 }}>
                  <span className="t-label-l ellipsis"><bdi>/{item.name}</bdi></span>
                  <span className="t-label-s c-3 ellipsis" style={{ fontWeight: 400 }}><bdi>{item.kind === 'command' ? item.description : item.body}</bdi></span>
                </span>
              </button>
            ))}
          </div>
        )}
        {(atts.length > 0 || importing > 0) && (
          <div className="composer-atts">
            {atts.map((a) => (
              <DraftThumb key={a.id} a={a} onRemove={() => { void app.attachments.discardDraft(a.id); setAtts((l) => l.filter((x) => x.id !== a.id)); }} />
            ))}
            {importing > 0 && <Spinner />}
          </div>
        )}
        <textarea
          ref={area}
          rows={1}
          value={text}
          placeholder={dictation.state === 'recording' ? t('Listening…') : dictation.state === 'transcribing' ? t('Transcribing…') : t('Ask anything')}
          onChange={(e) => {
            setText(e.target.value);
            setSlashIndex(0);
          }}
          onKeyDown={onKeyDown}
          onPaste={onPaste}
          aria-label={t('Message')}
          dir="auto"
        />
        <div className="composer-bar">
          <IconButton label={t('Add files and more')} onClick={plusMenu.open}>
            <Plus size={20} />
          </IconButton>
          {canSearch && (
            <button type="button" className={'chip' + (params.webSearch ? ' on' : '')} onClick={() => onParams({ ...params, webSearch: !params.webSearch })} aria-pressed={params.webSearch}>
              <Globe size={17} /> {t('Search')}
            </button>
          )}
          {caps && caps.reasoning.kind !== 'NONE' && caps.reasoning.efforts.length > 0 && (
            <button type="button" className={'chip' + (params.effort && params.effort !== 'NONE' ? ' on' : '')} onClick={effortMenu.open} aria-haspopup="menu">
              <Brain size={17} /> {effortLabel}
            </button>
          )}
          {local.computerTools && caps?.tools && params.tools && computer && <ComputerChip state={computer} pcsOnline={pcsOnline} onClick={onComputer} />}
          {synced.yoloMode && caps?.tools && (
            <button type="button" className="yolo-badge" title={t('YOLO mode is on: tools run without asking. Click to turn it off.')} onClick={() => app.settings.updateSynced((s) => ({ ...s, yoloMode: false }))}>
              <Rocket size={15} /> YOLO
            </button>
          )}
          <span className="grow" />
          {dictation.available && (
            <IconButton
              label={dictation.state === 'recording' ? t('Stop dictation') : t('Dictate')}
              active={dictation.state !== 'idle'}
              disabled={dictation.state === 'transcribing'}
              onClick={() => (dictation.state === 'recording' ? dictation.stop() : void dictation.start())}
            >
              {dictation.state === 'transcribing' ? <Spinner size={16} /> : dictation.state === 'recording' ? <Square size={16} /> : <Mic size={20} />}
            </IconButton>
          )}
          {busy ? (
            <button type="button" className="send-btn stop" aria-label={t('Stop')} title={t('Stop (Esc)')} onClick={onStop}>
              <Square size={16} fill="currentColor" />
            </button>
          ) : (
            <button type="button" className={'send-btn' + (canSend ? ' ready' : '')} aria-label={t('Send')} title={t('Send')} disabled={!canSend} onClick={send}>
              <ArrowUp size={21} />
            </button>
          )}
        </div>
        <input
          ref={fileInput}
          type="file"
          multiple
          hidden
          accept="image/*,application/pdf,text/*,.md,.json,.csv,.ts,.tsx,.js,.py,.kt,.java,.go,.rs,.c,.cpp,.cs,.rb,.php,.sql,.yaml,.yml,.toml,.xml,.html,.css,.sh,.ps1"
          onChange={(e) => {
            void addFiles([...(e.target.files ?? [])]);
            e.target.value = '';
          }}
        />
      </div>
      {effortMenu.anchor && caps && (
        <Menu
          anchor={effortMenu.anchor}
          onClose={effortMenu.close}
          items={[
            { label: t('Auto'), onSelect: () => onParams({ ...params, effort: null }) },
            ...caps.reasoning.efforts.map((e) => ({ label: tm(EFFORT_INFO[e].label), onSelect: () => onParams({ ...params, effort: e }) })),
          ]}
        />
      )}
      {plusMenu.anchor && (
        <Menu
          anchor={plusMenu.anchor}
          onClose={plusMenu.close}
          items={[
            { label: t('Attach files'), icon: <Paperclip size={17} />, onSelect: () => fileInput.current?.click() },
            { label: t('Commands and saved prompts'), icon: <Library size={17} />, onSelect: () => setText('/') },
            ...(onComputer && local.computerTools ? [{ label: computer?.kind === 'ready' ? t('Choose working folder') : t('Work on a PC'), icon: <FolderOpen size={17} />, onSelect: onComputer }] : []),
          ]}
        />
      )}
    </div>
  );
});

/** Where the chat's tools run: a folder on this PC, a folder on another PC, or why it can't. */
function ComputerChip({ state, pcsOnline, onClick }: { state: ComputerState; pcsOnline: boolean; onClick: (() => void) | null }) {
  let icon: ReactNode;
  let label: string;
  let title: string;
  let muted = false;
  switch (state.kind) {
    case 'ready':
      icon = state.computer.local ? <FolderOpen size={16} /> : <Monitor size={16} />;
      label = state.computer.local ? folderName(state.computer.folder) : `${state.computer.name} · ${folderName(state.computer.folder)}`;
      title = state.computer.local
        ? t('Working folder: {path}', { path: state.computer.folder })
        : t('Working folder: {path} on {pc}', { path: state.computer.folder, pc: state.computer.name });
      break;
    case 'disabled':
      icon = <MonitorOff size={16} />;
      label = t('{pc}: remote use is off', { pc: state.host.name });
      title = t('Turn on “Let your other devices use this PC” in Facet on {pc}: Settings → Computer access.', { pc: state.host.name });
      muted = true;
      break;
    case 'offline':
      icon = <MonitorOff size={16} />;
      label = t('PC offline');
      title = t('The PC this chat works on isn’t online. Open Facet on it to use its files and commands again.');
      muted = true;
      break;
    case 'none':
      if (!pcsOnline) return null;
      icon = <Monitor size={16} />;
      label = t('Use a PC');
      title = t('Let the model work in a folder on one of your PCs.');
      break;
  }
  return (
    <button type="button" className={'chip' + (muted ? ' muted' : '')} onClick={onClick ?? undefined} disabled={!onClick} title={title}>
      {icon} <span className="ellipsis" style={{ maxWidth: 180 }}><bdi>{label}</bdi></span>
    </button>
  );
}
