import { useLiveQuery } from 'dexie-react-hooks';
import { ArrowDown, ArrowUp, ChevronDown, Download, Menu as MenuIcon, MoreVertical, PanelLeftOpen, Pencil, Pin, PinOff, SlidersHorizontal, SquarePen, Trash2 } from 'lucide-react';
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { getApp } from '../../app';
import { parseJson, toJson } from '../../core/json';
import { MessageTree } from '../../data/conversations';
import { db } from '../../data/db';
import type { ConversationEntity, MessageEntity } from '../../data/entities';
import { DEFAULT_ASSISTANT_ID, builtinAssistant, type Assistant } from '../../data/library';
import type { ModelRef } from '../../data/prefs';
import { ChatError } from '../../domain/chat';
import { defaultParams, parseParams, type GenParams } from '../../llm/types';
import { platform } from '../../platform';
import { AssistantAvatar } from '../components/Avatars';
import { Gem } from '../components/Gem';
import { Confirm, IconButton, Menu, TextPrompt, useMenu, useToast } from '../components/primitives';
import { useActiveChats, useAssistants, useCatalog, useLiveTurns, useLocalPrefs, useNarrow, useSyncedPrefs } from '../hooks';
import { navigate, ui, type Route } from '../nav';
import { ChatSettings } from './ChatSettings';
import { Composer, type ComposerHandle } from './Composer';
import { AssistantMessage, UserMessage, type MessageActions, type ThreadItem } from './Messages';
import { ModelPicker, firstModel, resolveModel } from './ModelPicker';

function useNewChatDefaults(route: Route, assistants: Assistant[] | undefined) {
  const synced = useSyncedPrefs();
  const local = useLocalPrefs();
  const catalog = useCatalog();
  const assistantId = (route.name === 'home' && route.assistantId) || DEFAULT_ASSISTANT_ID;
  const assistant = assistants?.find((a) => a.id === assistantId) ?? builtinAssistant(DEFAULT_ASSISTANT_ID)!;
  const usable = (ref: ModelRef | null | undefined) => (ref && catalog?.some((p) => p.provider.id === ref.providerId) ? ref : null);
  const last = local.lastProviderId && local.lastModelId ? { providerId: local.lastProviderId, modelId: local.lastModelId } : null;
  const model = usable(assistant.model) ?? usable(synced.defaultModel) ?? usable(last) ?? firstModel(catalog);
  const params = assistant.params ?? synced.defaultParams ?? defaultParams();
  return { assistant, model, params };
}

function exportMarkdown(conv: ConversationEntity, path: MessageEntity[]): string {
  const lines = [`# ${conv.title || 'Chat'}`, ''];
  for (const m of path) {
    lines.push(m.role === 'user' ? '## You' : `## ${m.modelName ?? 'Assistant'}`, '', m.content, '');
  }
  return lines.join('\n');
}

export function ChatScreen({ route }: { route: Route }) {
  const app = getApp();
  const toast = useToast();
  const narrow = useNarrow();
  const local = useLocalPrefs();
  const assistants = useAssistants();
  const catalog = useCatalog();
  const liveTurns = useLiveTurns();
  const active = useActiveChats();
  const conversationId = route.name === 'chat' ? route.id : null;
  const conv = useLiveQuery(() => (conversationId ? db().conversations.get(conversationId) : undefined), [conversationId]);
  const messages = useLiveQuery(
    async () => (conversationId ? (await db().messages.where('conversationId').equals(conversationId).toArray()).filter((m) => m.deleted === 0) : []),
    [conversationId],
  );
  const defaults = useNewChatDefaults(route, assistants);
  const [draftModel, setDraftModel] = useState<ModelRef | null>(null);
  const [draftParams, setDraftParams] = useState<GenParams | null>(null);
  const [draftAssistant, setDraftAssistant] = useState<string | null>(null);
  const [draftWorkspace, setDraftWorkspace] = useState<string | null>(null);
  const [picker, setPicker] = useState<null | { regenerate?: string }>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const more = useMenu();
  const composer = useRef<ComposerHandle>(null);

  // Reset the new-chat choices when navigating to a fresh "new chat".
  useEffect(() => {
    setDraftModel(null);
    setDraftParams(null);
    setDraftAssistant(route.name === 'home' ? route.assistantId ?? null : null);
    composer.current?.focus();
  }, [route.name, route.name === 'home' ? route.assistantId : route.name === 'chat' ? route.id : '']);

  const missing = conversationId && conv === undefined && messages !== undefined;
  useEffect(() => {
    // The chat was deleted (here or on another device): go back to a new chat.
    if (missing) {
      const t = setTimeout(() => navigate({ name: 'home' }, true), 400);
      return () => clearTimeout(t);
    }
  }, [missing]);

  const assistantId = conv ? conv.assistantId ?? DEFAULT_ASSISTANT_ID : draftAssistant ?? defaults.assistant.id;
  const assistant = assistants?.find((a) => a.id === assistantId) ?? defaults.assistant;
  const modelRef: ModelRef | null = conv
    ? conv.providerId && conv.modelId ? { providerId: conv.providerId, modelId: conv.modelId } : null
    : draftModel ?? (draftAssistant ? assistant.model : null) ?? defaults.model;
  const model = resolveModel(catalog, modelRef);
  const params: GenParams = conv ? parseParams(conv.paramsJson) : draftParams ?? (draftAssistant ? assistant.params : null) ?? defaults.params;

  const [workspace, setWorkspace] = useState<string | null>(null);
  useEffect(() => {
    if (!platform().computer) return;
    void app.workspaceFor(conversationId).then((w) => setWorkspace(conv?.workspace ?? draftWorkspace ?? w));
  }, [conversationId, conv?.workspace, draftWorkspace, local.defaultWorkspace]);

  const pickWorkspace = useCallback(async () => {
    const picked = await platform().computer?.pickFolder(workspace ?? undefined);
    if (!picked) return;
    if (conversationId) await app.conversations.setWorkspace(conversationId, picked);
    else setDraftWorkspace(picked);
    setWorkspace(picked);
  }, [workspace, conversationId]);

  const items: ThreadItem[] = useMemo(() => {
    if (!messages || !conv) return [];
    const tree = new MessageTree(messages);
    return tree.activePath(conv.currentLeafId).map((m) => {
      const sibs = tree.siblings(m);
      return { message: m, siblingIds: sibs.map((s) => s.id), siblingIndex: Math.max(0, sibs.findIndex((s) => s.id === m.id)) };
    });
  }, [messages, conv?.currentLeafId]);

  // A reply another window is still writing counts as busy here too.
  const lastMessage = items.at(-1)?.message;
  const remoteStreaming = !!lastMessage && lastMessage.status === 'STREAMING' && !liveTurns.has(lastMessage.id);
  const busy = conversationId ? active.has(conversationId) || remoteStreaming : false;
  const stop = () => {
    if (!conversationId) return;
    if (active.has(conversationId)) app.chat.stop(conversationId);
    else if (remoteStreaming && lastMessage) void app.conversations.updateMessage({ ...lastMessage, status: 'STOPPED' });
  };

  const setParams = (p: GenParams) => {
    if (conv) void app.conversations.setParams(conv.id, p);
    else setDraftParams(p);
  };

  const pickModel = (ref: ModelRef) => {
    if (picker?.regenerate) {
      void run(() => app.chat.regenerate(picker.regenerate!, ref));
      return;
    }
    if (conv) void app.conversations.setModel(conv.id, ref.providerId, ref.modelId);
    else setDraftModel(ref);
  };

  const run = async (fn: () => Promise<unknown>) => {
    try {
      await fn();
    } catch (e) {
      toast(e instanceof ChatError ? e.message : (e as Error).message || 'Something went wrong.');
    }
  };

  const send = async (text: string, attachmentIds: string[]): Promise<boolean> => {
    if (!modelRef) {
      if (!catalog?.length) ui.openSettings('providers');
      else setPicker({});
      toast('Choose a model to start chatting.');
      return false;
    }
    try {
      const id = await app.chat.send(
        conversationId,
        text,
        attachmentIds,
        conversationId ? null : { assistantId: assistant.id === DEFAULT_ASSISTANT_ID ? null : assistant.id, model: modelRef, params, folderId: route.name === 'home' ? route.folderId ?? null : null },
        conversationId ? null : draftWorkspace ?? workspace,
      );
      if (!conversationId) navigate({ name: 'chat', id }, true);
      return true;
    } catch (e) {
      toast(e instanceof ChatError ? e.message : (e as Error).message || 'Couldn’t send this message.');
      return false;
    }
  };

  const actions: MessageActions = useMemo(() => ({
    regenerate: (id, model) => void run(() => app.chat.regenerate(id, model)),
    regenerateWith: (id) => setPicker({ regenerate: id }),
    editAndResend: (id, text) => void run(() => app.chat.editAndResend(id, text)),
    switchBranch: (siblingId) => conversationId && void app.chat.switchBranch(conversationId, siblingId),
    deleteMessage: (m) => void app.conversations.deleteMessage(m),
    continueReply: () => conversationId && void run(() => app.chat.continueReply(conversationId)),
  }), [conversationId]);

  // ---- scrolling: follow the reply while it streams, unless the reader scrolled up ----
  const thread = useRef<HTMLDivElement>(null);
  const pinned = useRef(true);
  const [showDown, setShowDown] = useState(false);
  const onScroll = () => {
    const el = thread.current;
    if (!el) return;
    const gap = el.scrollHeight - el.scrollTop - el.clientHeight;
    pinned.current = gap < 80;
    setShowDown(gap > 400);
  };
  useLayoutEffect(() => {
    const el = thread.current;
    if (el && pinned.current) el.scrollTop = el.scrollHeight;
  });
  useEffect(() => {
    pinned.current = true;
    const el = thread.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [conversationId, items.length]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && busy && !document.querySelector('.scrim')) stop();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [busy, conversationId]);

  const empty = !conversationId || (messages && messages.length === 0 && conv);
  const sidebarHidden = narrow || !local.sidebarOpen;

  return (
    <div className="main">
      <header className="topbar">
        {sidebarHidden && (
          <IconButton label="Show chats" onClick={() => (narrow ? ui.set({ drawer: true }) : app.settings.updateLocal((l) => ({ ...l, sidebarOpen: true })))}>
            {narrow ? <MenuIcon size={21} /> : <PanelLeftOpen size={20} />}
          </IconButton>
        )}
        <button type="button" className="model-title" onClick={() => setPicker({})} aria-haspopup="dialog">
          <span className="col" style={{ minWidth: 0 }}>
            <span className="name ellipsis">{model?.model.displayName ?? (catalog?.length ? 'Choose a model' : 'Add a provider')}</span>
            {model && <span className="provider ellipsis">{model.providerLabel}</span>}
          </span>
          <ChevronDown size={18} className="c-2" />
        </button>
        <span className="topbar-spacer" />
        {sidebarHidden && (
          <IconButton label="New chat" onClick={() => navigate({ name: 'home' })}>
            <SquarePen size={20} />
          </IconButton>
        )}
        <IconButton label="Chat settings" onClick={() => setSettingsOpen(true)}>
          <SlidersHorizontal size={20} />
        </IconButton>
        {conv && (
          <IconButton label="More" onClick={more.open}>
            <MoreVertical size={20} />
          </IconButton>
        )}
      </header>

      {empty ? (
        <Welcome
          assistant={assistant}
          assistants={assistants ?? []}
          onAssistant={(a) => {
            if (conv) return;
            setDraftAssistant(a.id);
            setDraftModel(null);
            setDraftParams(null);
          }}
          onStarter={(s) => void send(s, [])}
          modelName={model?.model.displayName ?? null}
          noProviders={catalog !== undefined && catalog.length === 0}
        />
      ) : (
        <div className="thread" ref={thread} onScroll={onScroll}>
          <div className="thread-inner">
            {items.map((item, i) =>
              item.message.role === 'user' ? (
                <UserMessage key={item.message.id} item={item} actions={actions} busy={busy} />
              ) : (
                <AssistantMessage key={item.message.id} item={item} live={liveTurns.get(item.message.id)} actions={actions} last={i === items.length - 1} />
              ),
            )}
          </div>
        </div>
      )}
      {showDown && !empty && (
        <button type="button" className="scroll-down" style={{ bottom: 120 }} aria-label="Scroll to the latest message" onClick={() => { pinned.current = true; thread.current?.scrollTo({ top: thread.current.scrollHeight, behavior: 'smooth' }); }}>
          <ArrowDown size={18} />
        </button>
      )}
      <Composer
        ref={composer}
        conversationId={conversationId}
        model={model}
        params={params}
        onParams={setParams}
        busy={busy}
        onSend={send}
        onStop={stop}
        workspace={workspace}
        onPickWorkspace={platform().computer ? pickWorkspace : null}
      />
      <div className="composer-hint" style={{ marginTop: -10, marginBottom: 8 }}>
        {platform().kind === 'web' ? 'End-to-end encrypted. Replies come straight from the provider you choose.' : ''}
      </div>

      {picker && <ModelPicker current={picker.regenerate ? null : modelRef} onPick={pickModel} onClose={() => setPicker(null)} title={picker.regenerate ? 'Regenerate with' : 'Choose a model'} />}
      {settingsOpen && (
        <ChatSettings
          model={model}
          params={params}
          onParams={setParams}
          systemPrompt={conv?.systemPrompt ?? null}
          onSystemPrompt={conv ? (s) => void app.conversations.setSystemPrompt(conv.id, s) : null}
          workspace={workspace}
          onWorkspace={platform().computer ? (p) => { if (conv) void app.conversations.setWorkspace(conv.id, p); else setDraftWorkspace(p); setWorkspace(p); } : null}
          onChangeModel={() => setPicker({})}
          onClose={() => setSettingsOpen(false)}
        />
      )}
      {more.anchor && conv && (
        <Menu
          anchor={more.anchor}
          align="end"
          onClose={more.close}
          items={[
            {
              label: 'Rename',
              icon: <Pencil size={17} />,
              onSelect: () => setRenaming(true),
            },
            { label: conv.pinned ? 'Unpin' : 'Pin', icon: conv.pinned ? <PinOff size={17} /> : <Pin size={17} />, onSelect: () => app.conversations.setPinned(conv.id, !conv.pinned) },
            {
              label: 'Export as Markdown',
              icon: <Download size={17} />,
              onSelect: () => void platform().saveFile(`${(conv.title || 'chat').replace(/[\\/:*?"<>|]+/g, '_')}.md`, new Blob([exportMarkdown(conv, items.map((i) => i.message))], { type: 'text/markdown' })),
            },
            {
              label: 'Export as JSON',
              icon: <ArrowUp size={17} style={{ transform: 'rotate(180deg)' }} />,
              onSelect: () =>
                void platform().saveFile(
                  `${(conv.title || 'chat').replace(/[\\/:*?"<>|]+/g, '_')}.json`,
                  new Blob([JSON.stringify({ conversation: { ...conv, params: parseJson(conv.paramsJson, {}) }, messages: (messages ?? []).map((m) => JSON.parse(toJson(m))) }, null, 2)], { type: 'application/json' }),
                ),
            },
            { label: 'Delete chat', icon: <Trash2 size={17} />, danger: true, separatorBefore: true, onSelect: () => setConfirmDelete(true) },
          ]}
        />
      )}
      {renaming && conv && (
        <TextPrompt title="Rename chat" initial={conv.title} confirm="Rename" onSubmit={(t) => app.conversations.rename(conv.id, t)} onClose={() => setRenaming(false)} />
      )}
      {confirmDelete && conv && (
        <Confirm
          title="Delete this chat?"
          body="It's removed from all your devices."
          confirm="Delete"
          danger
          onConfirm={async () => {
            await app.conversations.delete(conv.id);
            navigate({ name: 'home' }, true);
          }}
          onClose={() => setConfirmDelete(false)}
        />
      )}
    </div>
  );
}

function Welcome({ assistant, assistants, onAssistant, onStarter, modelName, noProviders }: {
  assistant: Assistant;
  assistants: Assistant[];
  onAssistant: (a: Assistant) => void;
  onStarter: (s: string) => void;
  modelName: string | null;
  noProviders: boolean;
}) {
  return (
    <div className="welcome">
      <div className="welcome-inner">
        {assistant.id === DEFAULT_ASSISTANT_ID ? <Gem size={64} /> : <AssistantAvatar assistant={assistant} size={64} />}
        <h1 className="t-display">{assistant.id === DEFAULT_ASSISTANT_ID ? 'What can I help with?' : assistant.name}</h1>
        {noProviders ? (
          <div className="col gap-12" style={{ alignItems: 'center', textAlign: 'center', maxWidth: 440 }}>
            <p className="t-body c-2" style={{ margin: 0 }}>
              Add an API key from OpenAI, Anthropic, Google or any other provider. It's encrypted on this device before it syncs.
            </p>
            <button type="button" className="btn btn-primary" onClick={() => ui.openSettings('providers')}>Add a provider</button>
          </div>
        ) : (
          assistant.starters.length > 0 && (
            <div className="starters">
              {assistant.starters.slice(0, 4).map((s) => (
                <button key={s} type="button" className="starter" onClick={() => onStarter(s)}>
                  <span>{s}</span>
                  <ArrowUp size={17} />
                </button>
              ))}
            </div>
          )
        )}
        <div className="assistant-chips">
          {assistants.slice(0, 8).map((a) => (
            <button key={a.id} type="button" className={'assistant-chip' + (a.id === assistant.id ? ' sel' : '')} onClick={() => onAssistant(a)}>
              <AssistantAvatar assistant={a} size={28} />
              {a.name}
            </button>
          ))}
        </div>
        {modelName && <div className="t-label-m c-3">{modelName}</div>}
      </div>
    </div>
  );
}
