/**
 * Settings → Assistants (port of the assistant screens in LibraryScreens.kt). `detail` is "new",
 * a custom assistant's id (edit), or a built-in's id (read-only, with "Make a copy").
 */
import { useLiveQuery } from 'dexie-react-hooks';
import { Copy, Cpu, MessageSquare, MessageSquarePlus, Plus, Trash2, X } from 'lucide-react';
import { useCallback, useState } from 'react';
import { getApp } from '../../app';
import { db } from '../../data/db';
import { builtinAssistant, DEFAULT_ASSISTANT_ID, toAssistant, type Assistant } from '../../data/library';
import type { ModelRef } from '../../data/prefs';
import { EFFORT_INFO, type Effort } from '../../llm/types';
import { effortHint, Segmented } from '../chat/ChatSettings';
import { ModelPicker, resolveModel } from '../chat/ModelPicker';
import { ACCENTS, AssistantAvatar } from '../components/Avatars';
import { Button, Confirm, Divider, Field, Group, IconButton, Row, Spinner, useToast } from '../components/primitives';
import { useAssistants, useCatalog, useSyncedPrefs } from '../hooks';
import { navigate, ui } from '../nav';
import type { PageProps } from './SettingsDialog';
import { ActionRow, SectionLabel, Sep } from './common';

const EMOJI = ['✨', '🧠', '💻', '✍️', '📚', '🌍', '📈', '🎨', '🔬', '🩺', '⚖️', '🍳', '🎵', '🧭', '🛠️', '🤝'];
/** Emoji for a copy of a built-in (built-ins draw an icon instead). */
const BUILTIN_EMOJI: Record<string, string> = { gem: '✨', code: '💻', writer: '✍️', tutor: '📚', languages: '🌍', analyst: '📈' };
const MAX_STARTERS = 4;

export function AssistantsPage({ detail }: PageProps) {
  if (detail === 'new') return <AssistantEditor key="new" initial={null} />;
  if (detail) {
    const b = builtinAssistant(detail);
    if (b) return <BuiltinView key={detail} assistant={b} />;
    return <EditExisting key={detail} id={detail} />;
  }
  return <AssistantList />;
}

function summary(a: Assistant): string {
  const first = a.instructions.split('\n').find((l) => l.trim())?.trim() ?? '';
  if (!first) return 'General-purpose assistant';
  return first.length > 90 ? first.slice(0, 89).trimEnd() + '…' : first;
}

// ---------------------------------------------------------------- list

function AssistantList() {
  const assistants = useAssistants();
  if (!assistants) return <Spinner />;
  const custom = assistants.filter((a) => !a.builtin);
  const builtins = assistants.filter((a) => a.builtin);
  const rows = (list: Assistant[]) =>
    list.map((a, i) => (
      <div key={a.id}>
        {i > 0 && <Sep inset={66} />}
        <ActionRow
          leading={<AssistantAvatar assistant={a} size={36} />}
          title={a.name}
          subtitle={summary(a)}
          subLines={1}
          chevron
          onClick={() => ui.openSettings('assistants', a.id)}
        />
      </div>
    ));
  return (
    <div className="col gap-16">
      <p className="settings-intro t-body">
        Assistants are reusable personas: instructions, a default model and conversation starters. Pick one when you start a chat.
      </p>
      <div className="row">
        <Button onClick={() => ui.openSettings('assistants', 'new')}>
          <Plus size={18} />
          Create an assistant
        </Button>
      </div>
      {custom.length > 0 && <Group title="Yours">{rows(custom)}</Group>}
      <Group title="Built in">{rows(builtins)}</Group>
    </div>
  );
}

// ---------------------------------------------------------------- built-in (read-only)

function BuiltinView({ assistant: a }: { assistant: Assistant }) {
  const app = getApp();
  const toast = useToast();
  const [copying, setCopying] = useState(false);
  const start = () => {
    ui.closeSettings();
    navigate({ name: 'home', assistantId: a.id === DEFAULT_ASSISTANT_ID ? null : a.id });
  };
  const copy = async () => {
    setCopying(true);
    try {
      const id = await app.assistants.save({
        id: null,
        name: `${a.name} (copy)`,
        emoji: BUILTIN_EMOJI[a.icon ?? 'gem'] ?? '✨',
        colorIndex: a.colorIndex,
        instructions: a.instructions,
        model: null,
        params: null,
        starters: a.starters,
      });
      ui.openSettings('assistants', id);
      toast('Copy created. Change anything you like.');
    } finally {
      setCopying(false);
    }
  };
  return (
    <div className="col gap-16">
      <div className="row gap-16 page-hero">
        <AssistantAvatar assistant={a} size={56} />
        <div className="col grow">
          <span className="t-title-m">{a.name}</span>
          <span className="t-label-m c-2" style={{ fontWeight: 400 }}>Built in. Make a copy to change it.</span>
        </div>
      </div>
      <div className="form-actions" style={{ marginTop: 0 }}>
        <Button onClick={start}>
          <MessageSquarePlus size={18} />
          Start a chat
        </Button>
        <Button variant="tonal" onClick={copy} busy={copying}>
          {!copying && <Copy size={17} />}
          Make a copy
        </Button>
      </div>
      <section className="col gap-8">
        <h3 className="group-title" style={{ margin: '14px 4px 0' }}>Instructions</h3>
        {a.instructions ? (
          <div className="group read-box">{a.instructions}</div>
        ) : (
          <p className="t-body c-2" style={{ margin: '0 4px' }}>None. Facet uses only your custom instructions from Settings → Chat.</p>
        )}
      </section>
      {a.starters.length > 0 && (
        <Group title="Conversation starters">
          {a.starters.map((s, i) => (
            <div key={i}>
              {i > 0 && <Divider />}
              <Row icon={<MessageSquare size={18} />} title={<span style={{ fontWeight: 400 }}>{s}</span>} />
            </div>
          ))}
        </Group>
      )}
    </div>
  );
}

// ---------------------------------------------------------------- create and edit

function EditExisting({ id }: { id: string }) {
  // undefined while loading, null when it doesn't exist.
  const e = useLiveQuery(async () => (await db().assistants.get(id)) ?? null, [id]);
  const [initial, setInitial] = useState<Assistant | null>(null);
  // Snapshot once: a sync landing mid-edit shouldn't reset the form.
  if (e && !e.deleted && !initial) setInitial(toAssistant(e));
  if (e === null || (e?.deleted && !initial)) {
    return (
      <div className="empty">
        <span className="t-body">This assistant was deleted, maybe from another device.</span>
        <Button variant="tonal" onClick={() => ui.openSettings('assistants', null)}>Back to assistants</Button>
      </div>
    );
  }
  if (!initial) return <Spinner />;
  return <AssistantEditor initial={initial} />;
}

function AssistantEditor({ initial }: { initial: Assistant | null }) {
  const app = getApp();
  const toast = useToast();
  const synced = useSyncedPrefs();
  const catalog = useCatalog();
  const [name, setName] = useState(initial?.name ?? '');
  const [emoji, setEmoji] = useState(initial?.emoji || '✨');
  const [color, setColor] = useState(initial?.colorIndex ?? 0);
  const [instructions, setInstructions] = useState(initial?.instructions ?? '');
  const [model, setModel] = useState<ModelRef | null>(initial?.model ?? null);
  const [effort, setEffort] = useState<Effort | null>(initial?.params?.effort ?? null);
  const [starters, setStarters] = useState<string[]>(() => {
    const list = [...(initial?.starters ?? [])];
    while (list.length < 3) list.push('');
    return list;
  });
  // An emoji picked elsewhere (e.g. on Android) stays selectable.
  const [emojiChoices] = useState(() => (initial?.emoji && !EMOJI.includes(initial.emoji) ? [initial.emoji, ...EMOJI.slice(0, EMOJI.length - 1)] : EMOJI));
  const [picker, setPicker] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [saving, setSaving] = useState(false);
  const closePicker = useCallback(() => setPicker(false), []);
  const closeConfirm = useCallback(() => setConfirmDelete(false), []);

  const resolved = resolveModel(catalog, model);
  const efforts = resolved?.model.caps.reasoning.kind !== 'NONE' ? resolved?.model.caps.reasoning.efforts ?? [] : [];
  // A model that isn't available right now (provider off or loading) keeps its saved effort.
  const effectiveEffort = !model ? null : !resolved ? effort : effort && efforts.includes(effort) ? effort : null;

  const preview: Assistant = {
    id: 'preview', name: name || 'Assistant', emoji, icon: null, colorIndex: color, instructions, model, params: null, starters: [], builtin: false,
  };
  const back = () => ui.openSettings('assistants', null);

  const save = async () => {
    if (!name.trim()) return;
    setSaving(true);
    try {
      const prior = initial?.params ?? null;
      // Assistant params replace the chat defaults, so start from them when there were none.
      const params = effectiveEffort != null || prior ? { ...(prior ?? synced.defaultParams), effort: effectiveEffort } : null;
      await app.assistants.save({ id: initial?.id ?? null, name, emoji, colorIndex: color, instructions, model, params, starters });
      toast(initial ? 'Assistant saved.' : `${name.trim()} is ready. Pick it when you start a chat.`);
      back();
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="col gap-16">
      <div className="row gap-16 page-hero" style={{ alignItems: 'center' }}>
        <AssistantAvatar assistant={preview} size={64} />
        <div className="col gap-8" style={{ minWidth: 0 }}>
          <span className="field-label">Color</span>
          <div className="row gap-8 row-wrap" role="radiogroup" aria-label="Color">
            {ACCENTS.map((c, i) => (
              <button key={c} type="button" role="radio" aria-checked={color === i} aria-label={`Color ${i + 1}`} className="swatch" style={{ background: c }} onClick={() => setColor(i)} />
            ))}
          </div>
        </div>
      </div>

      <section className="col gap-8">
        <SectionLabel>Emoji</SectionLabel>
        <div className="emoji-grid" role="radiogroup" aria-label="Emoji">
          {emojiChoices.map((e) => (
            <button key={e} type="button" role="radio" aria-checked={emoji === e} aria-label={e} className="emoji-cell" onClick={() => setEmoji(e)}>
              {e}
            </button>
          ))}
        </div>
      </section>

      <Field label="Name">
        <input className="input" value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Travel planner" maxLength={60} />
      </Field>
      <Field label="Instructions" hint="Sent at the start of every chat with this assistant, before your own custom instructions.">
        <textarea
          className="textarea"
          rows={8}
          value={instructions}
          onChange={(e) => setInstructions(e.target.value)}
          placeholder="Describe the role, tone, and anything it should always or never do."
        />
      </Field>

      <Group title="Default model">
        <ActionRow
          icon={<Cpu size={20} />}
          title={resolved ? resolved.model.displayName : model ? model.modelId : 'Use the chat’s current model'}
          subtitle={resolved ? resolved.providerLabel : model ? 'This provider is off or was removed.' : 'Or pick one this assistant always starts with.'}
          chevron={!model}
          onClick={() => setPicker(true)}
          trailing={
            model ? (
              <IconButton small label="Clear default model" onClick={() => setModel(null)}>
                <X size={17} />
              </IconButton>
            ) : undefined
          }
        />
      </Group>

      {model && efforts.length > 0 && (
        <section className="col gap-8">
          <SectionLabel>Reasoning</SectionLabel>
          <Segmented
            options={[null, ...efforts] as (Effort | null)[]}
            selected={effectiveEffort}
            label={(e) => (e ? EFFORT_INFO[e].label : 'Auto')}
            onSelect={setEffort}
          />
          <span className="field-hint section-label">{effortHint(effectiveEffort)}</span>
        </section>
      )}

      <section className="col gap-8">
        <SectionLabel>Conversation starters</SectionLabel>
        {starters.map((s, i) => (
          <input
            key={i}
            className="input"
            value={s}
            onChange={(e) => setStarters((list) => list.map((x, j) => (j === i ? e.target.value : x)))}
            placeholder={`Starter ${i + 1}`}
            aria-label={`Conversation starter ${i + 1}`}
          />
        ))}
        <span className="field-hint section-label">Shown as suggestions when a chat with this assistant is empty.</span>
        {starters.length < MAX_STARTERS && (
          <button type="button" className="link-btn" style={{ marginTop: 0 }} onClick={() => setStarters((list) => [...list, ''])}>
            <Plus size={15} aria-hidden />
            Add another
          </button>
        )}
      </section>

      <div className="form-actions">
        {initial && (
          <Button variant="danger" onClick={() => setConfirmDelete(true)}>
            <Trash2 size={17} />
            Delete
          </Button>
        )}
        <span className="grow" />
        <Button variant="text" onClick={back}>Cancel</Button>
        <Button onClick={save} busy={saving} disabled={!name.trim()}>
          {initial ? 'Save changes' : 'Create assistant'}
        </Button>
      </div>

      {picker && <ModelPicker title="Default model" current={model} onPick={setModel} onClose={closePicker} />}
      {confirmDelete && initial && (
        <Confirm
          title="Delete this assistant?"
          body="Existing chats keep working with their instructions removed."
          confirm="Delete"
          danger
          onConfirm={async () => {
            await app.assistants.delete(initial.id);
            back();
            toast(`Deleted ${initial.name}.`);
          }}
          onClose={closeConfirm}
        />
      )}
    </div>
  );
}
