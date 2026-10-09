import { useLiveQuery } from 'dexie-react-hooks';
import {
  Archive,
  ArchiveRestore,
  FolderInput,
  FolderPlus,
  MoreHorizontal,
  PanelLeftClose,
  Pencil,
  Pin,
  PinOff,
  Search,
  Settings,
  SquarePen,
  Trash2,
} from 'lucide-react';
import { useMemo, useState, type KeyboardEvent } from 'react';
import { getApp } from '../app';
import { Dates } from '../core/format';
import { db } from '../data/db';
import type { ConversationEntity, FolderEntity } from '../data/entities';
import { shownName } from '../sync/auth';
import { AssistantAvatar, UserAvatar, accent } from './components/Avatars';
import { Gem } from './components/Gem';
import { Button, Dialog, Field, IconButton, Menu, useMenu, useToast, type MenuItem } from './components/primitives';
import { useAccount, useActiveChats, useAssistants, useFolders, useLocalPrefs, useSyncState, useSyncedPrefs } from './hooks';
import { navigate, ui, useRoute, useUi } from './nav';

export function Sidebar({ narrow }: { narrow: boolean }) {
  const app = getApp();
  const local = useLocalPrefs();
  const { drawer } = useUi();
  const route = useRoute();
  const assistants = useAssistants() ?? [];
  const folders = useFolders() ?? [];
  const [folderFilter, setFolderFilter] = useState<string | null>(null);
  const [showArchived, setShowArchived] = useState(false);
  const [folderDialog, setFolderDialog] = useState<FolderEntity | 'new' | null>(null);
  const active = useActiveChats();

  const conversations = useLiveQuery(
    () => db().conversations.where('[deleted+archived]').equals([0, showArchived ? 1 : 0]).toArray(),
    [showArchived],
  );
  const archivedCount = useLiveQuery(() => db().conversations.where('[deleted+archived]').equals([0, 1]).count(), []);

  const sections = useMemo(() => {
    const list = (conversations ?? [])
      .filter((c) => !folderFilter || c.folderId === folderFilter)
      .sort((a, b) => Number(b.pinned) - Number(a.pinned) || b.lastActivityAt - a.lastActivityAt);
    const out: { label: string; items: ConversationEntity[] }[] = [];
    for (const c of list) {
      const label = c.pinned && !showArchived ? 'Pinned' : Dates.bucketLabel(c.lastActivityAt);
      const last = out[out.length - 1];
      if (last && last.label === label) last.items.push(c);
      else out.push({ label, items: [c] });
    }
    return out;
  }, [conversations, folderFilter, showArchived]);

  const collapsed = !narrow && !local.sidebarOpen;
  const activeId = route.name === 'chat' ? route.id : null;

  return (
    <>
      {narrow && drawer && <div className="drawer-scrim" onClick={() => ui.set({ drawer: false })} />}
      <aside className={'sidebar' + (collapsed ? ' collapsed' : '') + (narrow && drawer ? ' open' : '')} aria-label="Chats">
        <div className="sidebar-head">
          <div className="wordmark">
            <Gem size={26} />
            <span>facet</span>
          </div>
          <IconButton label="New chat (Ctrl+Shift+O)" onClick={() => navigate({ name: 'home', folderId: folderFilter })}>
            <SquarePen size={20} />
          </IconButton>
          {!narrow && (
            <IconButton label="Hide sidebar" onClick={() => app.settings.updateLocal((l) => ({ ...l, sidebarOpen: false }))}>
              <PanelLeftClose size={20} />
            </IconButton>
          )}
        </div>
        <button type="button" className="sidebar-search" onClick={() => navigate({ name: 'search' })}>
          <Search size={17} />
          <span>Search chats</span>
          <kbd>Ctrl K</kbd>
        </button>
        <div className="assistant-strip">
          {assistants.map((a) => (
            <button key={a.id} type="button" className="assistant-tile" title={a.name} onClick={() => navigate({ name: 'home', assistantId: a.id, folderId: folderFilter })}>
              <AssistantAvatar assistant={a} size={38} />
              <span>{a.name}</span>
            </button>
          ))}
        </div>
        <div className="folder-row">
          <button type="button" className={'chip' + (!folderFilter ? ' sel' : '')} onClick={() => setFolderFilter(null)}>
            All chats
          </button>
          {folders.map((f) => (
            <button
              key={f.id}
              type="button"
              className={'chip' + (folderFilter === f.id ? ' sel' : '')}
              onClick={() => setFolderFilter(folderFilter === f.id ? null : f.id)}
              onDoubleClick={() => setFolderDialog(f)}
              onContextMenu={(e) => {
                e.preventDefault();
                setFolderDialog(f);
              }}
              title="Double-click to edit"
            >
              <span className="folder-dot" style={{ background: accent(f.colorIndex) }} />
              {f.name}
            </button>
          ))}
          <IconButton label="New folder" small onClick={() => setFolderDialog('new')}>
            <FolderPlus size={17} />
          </IconButton>
        </div>
        <nav className="chat-list">
          {showArchived && (
            <button type="button" className="chat-item" onClick={() => setShowArchived(false)}>
              <ArchiveRestore size={17} className="c-2" />
              <span className="title c-2">Back to chats</span>
            </button>
          )}
          {sections.map((s) => (
            <div key={s.label}>
              <div className="chat-section">{s.label}</div>
              {s.items.map((c) => (
                <ChatItem key={c.id} chat={c} active={c.id === activeId} generating={active.has(c.id)} folders={folders} />
              ))}
            </div>
          ))}
          {conversations && sections.length === 0 && (
            <div className="empty" style={{ padding: '32px 12px' }}>
              <span className="t-label-m">{showArchived ? 'No archived chats.' : folderFilter ? 'No chats in this folder yet.' : 'Your chats appear here.'}</span>
            </div>
          )}
          {!showArchived && (archivedCount ?? 0) > 0 && (
            <button type="button" className="chat-item" style={{ marginTop: 12 }} onClick={() => setShowArchived(true)}>
              <Archive size={17} className="c-2" />
              <span className="title c-2">Archived chats</span>
              <span className="c-3 t-label-s">{archivedCount}</span>
            </button>
          )}
        </nav>
        <AccountFooter />
      </aside>
      {folderDialog && <FolderDialog folder={folderDialog === 'new' ? null : folderDialog} onClose={() => setFolderDialog(null)} />}
    </>
  );
}

function ChatItem({ chat, active, generating, folders }: { chat: ConversationEntity; active: boolean; generating: boolean; folders: FolderEntity[] }) {
  const app = getApp();
  const menu = useMenu();
  const folderMenu = useMenu();
  const toast = useToast();
  const [renaming, setRenaming] = useState(false);
  const [title, setTitle] = useState(chat.title);

  const remove = async () => {
    await app.conversations.delete(chat.id);
    if (active) navigate({ name: 'home' }, true);
    toast('Chat deleted.', {
      label: 'Undo',
      run: () => {
        void db().transaction('rw', db().conversations, db().messages, db().attachments, async () => {
          const now = Date.now();
          await db().conversations.update(chat.id, { ...chat, deleted: 0, dirty: 1, updatedAt: now });
          await db().messages.where('conversationId').equals(chat.id).modify({ deleted: 0, dirty: 1, updatedAt: now });
          await db().attachments.where('conversationId').equals(chat.id).modify({ deleted: 0, dirty: 1, updatedAt: now });
        }).then(() => app.sync.requestSync());
      },
    });
  };

  const items: MenuItem[] = [
    { label: 'Rename', icon: <Pencil size={17} />, onSelect: () => { setTitle(chat.title); setRenaming(true); } },
    { label: chat.pinned ? 'Unpin' : 'Pin', icon: chat.pinned ? <PinOff size={17} /> : <Pin size={17} />, onSelect: () => app.conversations.setPinned(chat.id, !chat.pinned) },
    {
      label: 'Move to folder',
      icon: <FolderInput size={17} />,
      onSelect: () => {
        const a = menu.anchor;
        if (a instanceof HTMLElement) {
          const r = a.getBoundingClientRect();
          folderMenu.openAt(r.left, r.bottom + 4);
        } else if (a) folderMenu.openAt(a.x, a.y);
      },
    },
    { label: chat.archived ? 'Unarchive' : 'Archive', icon: chat.archived ? <ArchiveRestore size={17} /> : <Archive size={17} />, onSelect: () => app.conversations.setArchived(chat.id, !chat.archived) },
    { label: 'Delete', icon: <Trash2 size={17} />, danger: true, separatorBefore: true, onSelect: remove },
  ];

  const finishRename = (save: boolean) => {
    setRenaming(false);
    if (save && title.trim() && title.trim() !== chat.title) void app.conversations.rename(chat.id, title);
  };

  if (renaming) {
    return (
      <div className="chat-item active">
        <input
          autoFocus
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          onBlur={() => finishRename(true)}
          onKeyDown={(e: KeyboardEvent) => {
            if (e.key === 'Enter') finishRename(true);
            if (e.key === 'Escape') finishRename(false);
          }}
          aria-label="Chat title"
        />
      </div>
    );
  }
  return (
    <>
      <div
        className={'chat-item' + (active ? ' active' : '')}
        role="link"
        tabIndex={0}
        onClick={() => navigate({ name: 'chat', id: chat.id })}
        onKeyDown={(e) => e.key === 'Enter' && navigate({ name: 'chat', id: chat.id })}
        onContextMenu={(e) => {
          e.preventDefault();
          menu.openAt(e.clientX, e.clientY);
        }}
        onDoubleClick={() => {
          setTitle(chat.title);
          setRenaming(true);
        }}
      >
        <span className="title">{chat.title || 'New chat'}</span>
        {generating && <span className="live-dot" title="Writing a reply" />}
        {chat.pinned && !generating && <Pin size={14} className="c-3" />}
        <IconButton label="Chat options" small className="more" onClick={(e) => { e.stopPropagation(); menu.open(e); }}>
          <MoreHorizontal size={17} />
        </IconButton>
      </div>
      {menu.anchor && <Menu anchor={menu.anchor} items={items} onClose={menu.close} />}
      {folderMenu.anchor && (
        <Menu
          anchor={folderMenu.anchor}
          onClose={folderMenu.close}
          items={[
            { label: 'No folder', onSelect: () => app.conversations.moveToFolder(chat.id, null) },
            ...folders.map((f) => ({ label: f.name, icon: <span className="folder-dot" style={{ background: accent(f.colorIndex) }} />, onSelect: () => app.conversations.moveToFolder(chat.id, f.id) })),
          ]}
        />
      )}
    </>
  );
}

function FolderDialog({ folder, onClose }: { folder: FolderEntity | null; onClose: () => void }) {
  const app = getApp();
  const [name, setName] = useState(folder?.name ?? '');
  const [color, setColor] = useState(folder?.colorIndex ?? 0);
  const save = async () => {
    await app.folders.save(folder?.id ?? null, name, color);
    onClose();
  };
  return (
    <Dialog
      title={folder ? 'Edit folder' : 'New folder'}
      onClose={onClose}
      size="narrow"
      footer={
        <>
          {folder && (
            <Button variant="text" style={{ marginRight: 'auto', color: 'var(--error)' }} onClick={async () => { await app.folders.delete(folder.id); onClose(); }}>
              Delete
            </Button>
          )}
          <Button variant="text" onClick={onClose}>Cancel</Button>
          <Button onClick={save} disabled={!name.trim()}>{folder ? 'Save' : 'Create folder'}</Button>
        </>
      }
    >
      <div className="col gap-16">
        <Field label="Name">
          <input className="input" value={name} onChange={(e) => setName(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && name.trim() && save()} placeholder="e.g. Work" />
        </Field>
        <div className="row gap-8" role="radiogroup" aria-label="Color">
          {[0, 1, 2, 3, 4, 5, 6, 7].map((i) => (
            <button
              key={i}
              type="button"
              role="radio"
              aria-checked={color === i}
              aria-label={`Color ${i + 1}`}
              onClick={() => setColor(i)}
              style={{ width: 30, height: 30, borderRadius: '50%', background: accent(i), outline: color === i ? '2px solid var(--text)' : 'none', outlineOffset: 2 }}
            />
          ))}
        </div>
      </div>
    </Dialog>
  );
}

function AccountFooter() {
  const account = useAccount();
  const sync = useSyncState();
  const synced = useSyncedPrefs();
  let name = synced.profileName || 'Facet';
  let status: { cls: string; text: string };
  if (account.kind === 'signedIn') {
    name = shownName(account, synced.profileName);
    if (sync.phase === 'SYNCING') status = { cls: 'busy', text: 'Syncing…' };
    else if (sync.storageFull) status = { cls: 'warn', text: 'Sync storage full' };
    else if (sync.phase === 'OFFLINE') status = { cls: 'warn', text: 'Offline' };
    else if (sync.phase === 'ERROR') status = { cls: 'err', text: 'Sync problem' };
    else status = { cls: 'ok', text: sync.lastSyncAt ? `Synced ${Dates.relative(sync.lastSyncAt).toLowerCase()}` : 'Synced' };
  } else if (account.kind === 'expired') {
    status = { cls: 'err', text: 'Sign in again to sync' };
  } else {
    status = { cls: '', text: 'On this device only' };
  }
  return (
    <div className="sidebar-foot">
      <UserAvatar name={name} size={36} />
      <button type="button" className="who" onClick={() => ui.openSettings(account.kind === 'guest' ? 'account' : 'home')} title={sync.message ?? undefined}>
        <span className="t-label-l ellipsis">{name}</span>
        <span className="t-label-s c-2 ellipsis" style={{ fontWeight: 400 }}>
          <span className={'sync-dot ' + status.cls} />
          {status.text}
        </span>
      </button>
      <IconButton label="Settings" onClick={() => ui.openSettings('home')}>
        <Settings size={20} />
      </IconButton>
    </div>
  );
}
