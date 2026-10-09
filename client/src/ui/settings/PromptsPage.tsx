/** Settings → Prompt library (port of PromptsScreen in LibraryScreens.kt). Type / in a message to insert one. */
import { Library, Plus, Trash2 } from 'lucide-react';
import { useCallback, useState } from 'react';
import { getApp } from '../../app';
import type { PromptEntity } from '../../data/entities';
import { Button, Dialog, Field, Spinner, useToast } from '../components/primitives';
import { usePrompts } from '../hooks';
import type { PageProps } from './SettingsDialog';
import { ActionRow, FilterBox, Sep, useStableCallback } from './common';

export function PromptsPage(_props: PageProps) {
  const prompts = usePrompts();
  const [editing, setEditing] = useState<PromptEntity | 'new' | null>(null);
  const [query, setQuery] = useState('');
  const close = useCallback(() => setEditing(null), []);

  if (!prompts) return <Spinner />;
  const q = query.trim().toLowerCase();
  const shown = q ? prompts.filter((p) => p.title.toLowerCase().includes(q) || p.body.toLowerCase().includes(q)) : prompts;

  return (
    <div className="col gap-16">
      <p className="settings-intro t-body">Save prompts you use often. In any chat, type / to search and insert one.</p>
      <div className="row gap-12 row-wrap">
        <Button onClick={() => setEditing('new')}>
          <Plus size={18} />
          New prompt
        </Button>
        {prompts.length > 8 && (
          <div className="grow" style={{ minWidth: 200 }}>
            <FilterBox value={query} onChange={setQuery} placeholder="Search prompts" />
          </div>
        )}
      </div>
      {prompts.length === 0 ? (
        <div className="empty">
          <div className="empty-icon"><Library size={24} /></div>
          <div className="t-title-m" style={{ color: 'var(--text)' }}>No saved prompts</div>
          <div className="t-body">Try one like “Summarize this in five bullet points”.</div>
        </div>
      ) : shown.length === 0 ? (
        <div className="empty t-body">No prompts match “{query.trim()}”.</div>
      ) : (
        <div className="group">
          {shown.map((p, i) => (
            <div key={p.id}>
              {i > 0 && <Sep inset={16} />}
              <ActionRow title={p.title || 'Untitled'} subtitle={p.body} subLines={2} onClick={() => setEditing(p)} />
            </div>
          ))}
        </div>
      )}
      {editing && <PromptDialog prompt={editing === 'new' ? null : editing} onClose={close} />}
    </div>
  );
}

function PromptDialog({ prompt, onClose }: { prompt: PromptEntity | null; onClose: () => void }) {
  const app = getApp();
  const toast = useToast();
  const close = useStableCallback(onClose);
  const [title, setTitle] = useState(prompt?.title ?? '');
  const [body, setBody] = useState(prompt?.body ?? '');
  const [busy, setBusy] = useState(false);

  const save = async () => {
    if (!body.trim() || busy) return;
    setBusy(true);
    try {
      await app.prompts.save(prompt?.id ?? null, title, body);
      close();
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    if (!prompt) return;
    await app.prompts.delete(prompt.id);
    close();
    toast('Prompt deleted.', { label: 'Undo', run: () => void app.prompts.save(prompt.id, prompt.title, prompt.body) });
  };

  return (
    <Dialog
      title={prompt ? 'Edit prompt' : 'New prompt'}
      onClose={close}
      closeOnScrim={false}
      footer={
        <>
          {prompt && (
            <Button variant="text" style={{ marginRight: 'auto', color: 'var(--error)' }} onClick={remove}>
              <Trash2 size={17} />
              Delete
            </Button>
          )}
          <Button variant="text" onClick={close}>Cancel</Button>
          <Button onClick={save} busy={busy} disabled={!body.trim()}>Save</Button>
        </>
      }
    >
      <div className="col gap-16">
        <Field label="Title" hint="Shown when you type / in a chat. Leave it empty to use the start of the prompt.">
          <input className="input" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="e.g. Five-bullet summary" maxLength={80} />
        </Field>
        <Field label="Prompt" hint="Ctrl+Enter saves.">
          <textarea
            className="textarea"
            rows={8}
            value={body}
            onChange={(e) => setBody(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
                e.preventDefault();
                void save();
              }
            }}
            placeholder="Summarize the following in five bullet points:"
          />
        </Field>
      </div>
    </Dialog>
  );
}
