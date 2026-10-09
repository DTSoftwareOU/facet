import { useLiveQuery } from 'dexie-react-hooks';
import { ArrowUp, Brain, FolderOpen, Globe, Library, Mic, Paperclip, Plus, Rocket, Square, X } from 'lucide-react';
import { forwardRef, useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState, type ClipboardEvent, type DragEvent, type KeyboardEvent } from 'react';
import { getApp } from '../../app';
import type { AttachmentEntity } from '../../data/entities';
import { EFFORT_INFO, type GenParams } from '../../llm/types';
import { platform } from '../../platform';
import { isSearchKind } from '../../tools/types';
import { db } from '../../data/db';
import { IconButton, Menu, Spinner, useMenu, useToast } from '../components/primitives';
import { useLocalPrefs, usePrompts, useSyncedPrefs } from '../hooks';
import { ui } from '../nav';
import { FileChip } from './Attachments';
import type { ResolvedModel } from './ModelPicker';
import { useDictation } from './speech';

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

function folderName(path: string): string {
  const parts = path.replace(/[\\/]+$/, '').split(/[\\/]/);
  return parts[parts.length - 1] || path;
}

function DraftThumb({ a, onRemove }: { a: AttachmentEntity; onRemove: () => void }) {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    if (a.kind === 'image') void getApp().attachments.url(a.id).then(setUrl);
  }, [a.id, a.kind]);
  return (
    <div className="composer-att">
      {a.kind === 'image' && url ? <img src={url} alt={a.name} /> : <FileChip att={a} />}
      <button type="button" className="x" aria-label={`Remove ${a.name}`} onClick={onRemove}>
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
  workspace: string | null;
  onPickWorkspace: (() => void) | null;
}>(function Composer({ conversationId, model, params, onParams, busy, onSend, onStop, workspace, onPickWorkspace }, ref) {
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
  const computer = platform().computer;

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
    setText: (t) => {
      setText(t);
      setTimeout(() => area.current?.focus(), 0);
    },
    addFiles: (files) => void addFiles(files),
  }), [addFiles]);

  const dictation = useDictation(
    useCallback((t: string) => setText((cur) => (cur.trim() ? cur.replace(/\s*$/, ' ') + t : t)), []),
    useCallback((m: string) => toast(m), [toast]),
  );

  const slash = useMemo(() => {
    const m = /^\/(\S*)$/.exec(text);
    if (!m) return null;
    const q = m[1].toLowerCase();
    return prompts.filter((p) => p.title.toLowerCase().includes(q) || p.body.toLowerCase().includes(q)).slice(0, 8);
  }, [text, prompts]);

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
        setText(slash[Math.min(slashIndex, slash.length - 1)].body);
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

  const effortLabel = params.effort ? EFFORT_INFO[params.effort].label : 'Auto';

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
          <div className="slash-menu" role="listbox" aria-label="Saved prompts">
            {slash.map((p, i) => (
              <button
                key={p.id}
                type="button"
                role="option"
                aria-selected={i === slashIndex}
                className="menu-item"
                style={i === slashIndex ? { background: 'var(--surface-high)' } : undefined}
                onMouseDown={(e) => {
                  e.preventDefault();
                  setText(p.body);
                }}
              >
                <Library size={16} />
                <span className="col" style={{ minWidth: 0 }}>
                  <span className="t-label-l ellipsis">{p.title}</span>
                  <span className="t-label-s c-3 ellipsis" style={{ fontWeight: 400 }}>{p.body}</span>
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
          placeholder={dictation.state === 'recording' ? 'Listening…' : dictation.state === 'transcribing' ? 'Transcribing…' : 'Ask anything'}
          onChange={(e) => {
            setText(e.target.value);
            setSlashIndex(0);
          }}
          onKeyDown={onKeyDown}
          onPaste={onPaste}
          aria-label="Message"
        />
        <div className="composer-bar">
          <IconButton label="Add files and more" onClick={plusMenu.open}>
            <Plus size={20} />
          </IconButton>
          {canSearch && (
            <button type="button" className={'chip' + (params.webSearch ? ' on' : '')} onClick={() => onParams({ ...params, webSearch: !params.webSearch })} aria-pressed={params.webSearch}>
              <Globe size={17} /> Search
            </button>
          )}
          {caps && caps.reasoning.kind !== 'NONE' && caps.reasoning.efforts.length > 0 && (
            <button type="button" className={'chip' + (params.effort && params.effort !== 'NONE' ? ' on' : '')} onClick={effortMenu.open} aria-haspopup="menu">
              <Brain size={17} /> {effortLabel}
            </button>
          )}
          {computer && local.computerTools && caps?.tools && params.tools && workspace && onPickWorkspace && (
            <button type="button" className="chip" onClick={onPickWorkspace} title={`Working folder: ${workspace}`}>
              <FolderOpen size={16} /> <span className="ellipsis" style={{ maxWidth: 140 }}>{folderName(workspace)}</span>
            </button>
          )}
          {synced.yoloMode && caps?.tools && (
            <button type="button" className="yolo-badge" title="YOLO mode is on: tools run without asking. Click to turn it off." onClick={() => app.settings.updateSynced((s) => ({ ...s, yoloMode: false }))}>
              <Rocket size={15} /> YOLO
            </button>
          )}
          <span className="grow" />
          {dictation.available && (
            <IconButton
              label={dictation.state === 'recording' ? 'Stop dictation' : 'Dictate'}
              active={dictation.state !== 'idle'}
              disabled={dictation.state === 'transcribing'}
              onClick={() => (dictation.state === 'recording' ? dictation.stop() : void dictation.start())}
            >
              {dictation.state === 'transcribing' ? <Spinner size={16} /> : dictation.state === 'recording' ? <Square size={16} /> : <Mic size={20} />}
            </IconButton>
          )}
          {busy ? (
            <button type="button" className="send-btn stop" aria-label="Stop" title="Stop (Esc)" onClick={onStop}>
              <Square size={16} fill="currentColor" />
            </button>
          ) : (
            <button type="button" className={'send-btn' + (canSend ? ' ready' : '')} aria-label="Send" title="Send" disabled={!canSend} onClick={send}>
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
            { label: 'Auto', onSelect: () => onParams({ ...params, effort: null }) },
            ...caps.reasoning.efforts.map((e) => ({ label: EFFORT_INFO[e].label, onSelect: () => onParams({ ...params, effort: e }) })),
          ]}
        />
      )}
      {plusMenu.anchor && (
        <Menu
          anchor={plusMenu.anchor}
          onClose={plusMenu.close}
          items={[
            { label: 'Attach files', icon: <Paperclip size={17} />, onSelect: () => fileInput.current?.click() },
            { label: 'Insert a saved prompt', icon: <Library size={17} />, onSelect: () => (prompts.length ? setText('/') : ui.openSettings('prompts')) },
            ...(computer && onPickWorkspace && local.computerTools ? [{ label: 'Choose working folder', icon: <FolderOpen size={17} />, onSelect: onPickWorkspace }] : []),
          ]}
        />
      )}
    </div>
  );
});
