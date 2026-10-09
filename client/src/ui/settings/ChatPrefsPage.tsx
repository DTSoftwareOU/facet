import { Bot, Heading, MessageSquareText, Type } from 'lucide-react';
import { useEffect, useState } from 'react';
import { getApp } from '../../app';
import type { ModelRef } from '../../data/prefs';
import { ModelPicker, resolveModel } from '../chat/ModelPicker';
import { Divider, Field, Group, Row, SwitchRow } from '../components/primitives';
import { useCatalog, useSyncedPrefs } from '../hooks';
import type { PageProps } from './SettingsDialog';

/** Saves a text field after typing pauses, so every keystroke doesn't create a synced change. */
function useDebouncedSave(value: string, save: (v: string) => void, delay = 700) {
  const [draft, setDraft] = useState(value);
  useEffect(() => setDraft(value), [value]);
  useEffect(() => {
    if (draft === value) return;
    const t = setTimeout(() => save(draft), delay);
    return () => clearTimeout(t);
  }, [draft]);
  return [draft, setDraft] as const;
}

export function ChatPrefsPage(_props: PageProps) {
  const app = getApp();
  const synced = useSyncedPrefs();
  const catalog = useCatalog();
  const [picking, setPicking] = useState<null | 'default' | 'title'>(null);
  const update = (patch: Partial<typeof synced>) => app.settings.updateSynced((s) => ({ ...s, ...patch }));
  const [about, setAbout] = useDebouncedSave(synced.aboutMe, (v) => update({ aboutMe: v }));
  const [style, setStyle] = useDebouncedSave(synced.responseStyle, (v) => update({ responseStyle: v }));
  const defaultModel = resolveModel(catalog, synced.defaultModel);
  const titleModel = resolveModel(catalog, synced.titleModel);

  const pick = (ref: ModelRef) => {
    if (picking === 'default') update({ defaultModel: ref });
    if (picking === 'title') update({ titleModel: ref });
  };

  return (
    <div className="col gap-16">
      <Group title="Custom instructions" footer="Added to every chat, on every device. Assistants and per-chat instructions add to these.">
        <SwitchRow icon={<MessageSquareText size={20} />} title="Use custom instructions" checked={synced.customInstructionsEnabled} onChange={(v) => update({ customInstructionsEnabled: v })} />
      </Group>
      {synced.customInstructionsEnabled && (
        <div className="col gap-12">
          <Field label="About you" hint="Your work, interests, location, anything that helps.">
            <textarea className="textarea" rows={4} value={about} onChange={(e) => setAbout(e.target.value)} placeholder="e.g. I'm a product designer in Lisbon. I prefer metric units." />
          </Field>
          <Field label="How to respond" hint="Tone, length, format.">
            <textarea className="textarea" rows={4} value={style} onChange={(e) => setStyle(e.target.value)} placeholder="e.g. Be direct. Use short paragraphs and tables for comparisons." />
          </Field>
        </div>
      )}
      <Group title="Models">
        <Row
          icon={<Bot size={20} />}
          title="Default model for new chats"
          subtitle={defaultModel ? `${defaultModel.model.displayName} · ${defaultModel.providerLabel}` : 'The model you used last'}
          onClick={() => setPicking('default')}
          trailing={synced.defaultModel ? <button type="button" className="btn btn-text btn-sm" onClick={(e) => { e.stopPropagation(); update({ defaultModel: null }); }}>Reset</button> : undefined}
          chevron
        />
        <Divider />
        <SwitchRow icon={<Heading size={20} />} title="Name chats automatically" subtitle="A short title from the first exchange." checked={synced.autoTitle} onChange={(v) => update({ autoTitle: v })} />
        {synced.autoTitle && (
          <>
            <Divider />
            <Row
              icon={<Type size={20} />}
              title="Model for titles"
              subtitle={titleModel ? `${titleModel.model.displayName} · ${titleModel.providerLabel}` : 'The chat’s own model'}
              onClick={() => setPicking('title')}
              trailing={synced.titleModel ? <button type="button" className="btn btn-text btn-sm" onClick={(e) => { e.stopPropagation(); update({ titleModel: null }); }}>Reset</button> : undefined}
              chevron
            />
          </>
        )}
      </Group>
      <p className="field-hint" style={{ margin: '0 6px' }}>
        To change reasoning, search and length defaults, open a chat's settings and choose “Use these settings for new chats”.
      </p>
      {picking && (
        <ModelPicker
          current={picking === 'default' ? synced.defaultModel ?? null : synced.titleModel ?? null}
          onPick={pick}
          onClose={() => setPicking(null)}
          title={picking === 'default' ? 'Default model' : 'Model for titles'}
        />
      )}
    </div>
  );
}
