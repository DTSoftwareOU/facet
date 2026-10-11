/** Settings → Media models (port of MediaScreens.kt): which model makes images, video, speech, music and transcripts. */
import { AudioLines, Film, Image as ImageIcon, Mic, Music, Plus, Sparkles, Speech } from 'lucide-react';
import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { getApp } from '../../app';
import { mediaRef, withMediaRef, type MediaPrefs, type ModelRef } from '../../data/prefs';
import { MEDIA_OUTPUTS, type MediaChoice } from '../../domain/media/service';
import { formatNumber, sentences, t, tm } from '../../i18n';
import { ASPECT_INFO, ASPECTS, type Aspect, type Voice } from '../../llm/media/gen';
import { providerKind } from '../../llm/providers';
import { MODEL_OUTPUT_INFO, type ModelOutput } from '../../llm/types';
import { Segmented } from '../chat/ChatSettings';
import { ProviderBadge } from '../components/Avatars';
import { Button, Dialog, Divider, Group, Row, Spinner, SwitchRow } from '../components/primitives';
import { useProviders, useSyncedPrefs } from '../hooks';
import { ui } from '../nav';
import type { PageProps } from './SettingsDialog';
import { BlockedBadge, ChoiceRow, FilterBox, Notice, OutlinedGroup, Sep, useStableCallback } from './common';

type MediaOutput = (typeof MEDIA_OUTPUTS)[number];

const ICONS: Record<ModelOutput, ReactNode> = {
  TEXT: null,
  IMAGE: <ImageIcon size={20} />,
  VIDEO: <Film size={20} />,
  SPEECH: <Speech size={20} />,
  MUSIC: <Music size={20} />,
  TRANSCRIPTION: <Mic size={20} />,
};

/** Who makes each kind, for the empty picker. */
function whoMakes(o: ModelOutput): string {
  switch (o) {
    case 'IMAGE': return t('OpenAI, Google, OpenRouter, xAI, Together, Stability AI and Black Forest Labs do.');
    case 'VIDEO': return t('Google (Gemini API) does.');
    case 'SPEECH': return t('OpenAI, Google, Mistral, ElevenLabs and Deepgram do.');
    case 'MUSIC': return t('Google, ElevenLabs and Stability AI do.');
    case 'TRANSCRIPTION': return t('OpenAI, Mistral, Groq, Together, ElevenLabs and Deepgram do.');
    default: return '';
  }
}

/** Row subtitle when nothing makes this kind. */
function noneMakes(o: ModelOutput): string {
  switch (o) {
    case 'IMAGE': return t('None of your providers makes images');
    case 'VIDEO': return t('None of your providers makes video');
    case 'SPEECH': return t('None of your providers makes speech');
    case 'MUSIC': return t('None of your providers makes music');
    case 'TRANSCRIPTION': return t('None of your providers makes transcripts');
    default: return '';
  }
}

/** The empty picker's first sentence. */
function noneMakesYet(o: ModelOutput): string {
  switch (o) {
    case 'IMAGE': return t('None of your providers makes images yet.');
    case 'VIDEO': return t('None of your providers makes video yet.');
    case 'SPEECH': return t('None of your providers makes speech yet.');
    case 'MUSIC': return t('None of your providers makes music yet.');
    case 'TRANSCRIPTION': return t('None of your providers makes transcripts yet.');
    default: return '';
  }
}

/** The picker's title. */
function pickerTitle(o: ModelOutput): string {
  switch (o) {
    case 'IMAGE': return t('Image model');
    case 'VIDEO': return t('Video model');
    case 'SPEECH': return t('Speech model');
    case 'MUSIC': return t('Music & sound model');
    case 'TRANSCRIPTION': return t('Transcription model');
    default: return t('Model');
  }
}

/** A music length: "15s", "1 min" in the interface language. */
function musicLength(s: number): string {
  return s < 60
    ? formatNumber(s, { style: 'unit', unit: 'second', unitDisplay: 'narrow' })
    : formatNumber(s / 60, { style: 'unit', unit: 'minute', unitDisplay: 'short' });
}

const VIDEO_ASPECTS: Aspect[] = ['LANDSCAPE', 'PORTRAIT'];
const MUSIC_LENGTHS = [15, 30, 60, 120];

interface MediaState {
  available: Record<MediaOutput, MediaChoice[]>;
  resolved: Record<MediaOutput, MediaChoice | null>;
}

const sameRef = (ref: ModelRef | null | undefined, c: MediaChoice) => !!ref && ref.providerId === c.provider.id && ref.modelId === c.model.id;

export function MediaPage(_props: PageProps) {
  const app = getApp();
  const providers = useProviders();
  const prefs = useSyncedPrefs().media;
  const [state, setState] = useState<MediaState | null>(null);
  const [picking, setPicking] = useState<MediaOutput | null>(null);
  const [pickingVoice, setPickingVoice] = useState(false);
  const closePicker = useCallback(() => setPicking(null), []);
  const closeVoice = useCallback(() => setPickingVoice(false), []);

  useEffect(() => {
    if (!providers) return;
    let cancelled = false;
    void (async () => {
      const entries = await Promise.all(
        MEDIA_OUTPUTS.map(async (o) => [o, await app.media.available(o), await app.media.resolve(o)] as const),
      );
      if (cancelled) return;
      const next = { available: {}, resolved: {} } as MediaState;
      for (const [o, available, resolved] of entries) {
        next.available[o] = available;
        next.resolved[o] = resolved;
      }
      setState(next);
    })();
    return () => {
      cancelled = true;
    };
  }, [providers, prefs]);

  const update = (change: (m: MediaPrefs) => MediaPrefs) => void app.settings.updateSynced((s) => ({ ...s, media: change(s.media) }));
  const addProvider = () => ui.openSettings('providers');

  if (!state) return <Spinner />;

  if (MEDIA_OUTPUTS.every((o) => state.available[o].length === 0)) {
    return (
      <div className="col gap-16">
        <div className="empty">
          <div className="empty-icon"><ImageIcon size={24} /></div>
          <div className="t-title-m" style={{ color: 'var(--text)' }}>{t('No media models yet')}</div>
          <div className="t-body" style={{ maxWidth: 460 }}>
            {t('Add a provider that makes images, video, speech, music or transcripts. OpenAI and Google keys cover several kinds; ElevenLabs, Stability AI, Black Forest Labs and Deepgram add more.')}
          </div>
          <Button onClick={addProvider}>
            <Plus size={18} />
            {t('Add a provider')}
          </Button>
        </div>
      </div>
    );
  }

  const speech = state.resolved.SPEECH;
  const picked = picking ? state.resolved[picking] : null;

  return (
    <div className="col gap-16">
      <p className="settings-intro t-body">
        {t('Pick the model that makes each kind of media. Chat models use them when you ask for a picture, a video, a voiceover or a song, and the results are saved in the chat. Models are sorted automatically by what they make.')}
      </p>
      <Group>
        {MEDIA_OUTPUTS.map((o, i) => {
          const r = state.resolved[o];
          const info = MODEL_OUTPUT_INFO[o];
          return (
            <div key={o}>
              {i > 0 && <Divider />}
              <Row
                icon={ICONS[o]}
                title={tm(info.label)}
                subtitle={!r ? noneMakes(o) : r.explicit ? r.label : t('Automatic · {model}', { model: r.label })}
                trailing={r?.browserBlocked ? <BlockedBadge /> : undefined}
                chevron
                onClick={() => setPicking(o)}
              />
            </div>
          );
        })}
      </Group>

      <Group title={t('Options')}>
        <div className="col gap-16 group-pad">
          <Option title={t('Image shape')}>
            <Segmented options={[...ASPECTS]} selected={prefs.imageAspect} label={(a) => tm(ASPECT_INFO[a].label)} onSelect={(a) => update((m) => ({ ...m, imageAspect: a }))} />
          </Option>
          <Option title={t('Video shape')}>
            <Segmented options={VIDEO_ASPECTS} selected={prefs.videoAspect} label={(a) => tm(ASPECT_INFO[a].label)} onSelect={(a) => update((m) => ({ ...m, videoAspect: a }))} />
          </Option>
          <Option title={t('Music length')}>
            <Segmented
              options={MUSIC_LENGTHS}
              selected={prefs.musicSeconds}
              label={musicLength}
              onSelect={(s) => update((m) => ({ ...m, musicSeconds: s }))}
            />
          </Option>
        </div>
        <Divider full />
        <Row
          icon={<AudioLines size={20} />}
          title={t('Voice')}
          subtitle={speech ? <bdi>{app.media.voiceName(speech, app.media.voiceFor(speech))}</bdi> : t('Choose a speech model first')}
          chevron={!!speech}
          onClick={speech ? () => setPickingVoice(true) : undefined}
        />
      </Group>

      <Group>
        <SwitchRow
          icon={<Sparkles size={20} />}
          title={t('Let chat models create media')}
          subtitle={t('Gives tool-capable chat models image, video, speech and music tools.')}
          checked={prefs.chatTools}
          onChange={(v) => update((m) => ({ ...m, chatTools: v }))}
        />
        <Divider />
        <SwitchRow
          icon={<Speech size={20} />}
          title={t('Read aloud with this voice')}
          subtitle={prefs.speech ? t('Read aloud uses your speech model instead of the system voice.') : t('Choose a speech model above to use it for Read aloud.')}
          checked={prefs.aiReadAloud && !!prefs.speech}
          disabled={!prefs.speech}
          onChange={(v) => update((m) => ({ ...m, aiReadAloud: v }))}
        />
        <Divider />
        <SwitchRow
          icon={<Mic size={20} />}
          title={t('Dictate with this model')}
          subtitle={prefs.transcription ? t('The mic records, then your transcription model writes it down.') : t('Choose a transcription model above to use it for dictation.')}
          checked={prefs.aiDictation && !!prefs.transcription}
          disabled={!prefs.transcription}
          onChange={(v) => update((m) => ({ ...m, aiDictation: v }))}
        />
      </Group>

      <div className="row">
        <Button variant="tonal" onClick={addProvider}>
          <Plus size={18} />
          {t('Add a media provider')}
        </Button>
      </div>
      <p className="field-hint" style={{ margin: '-4px 6px 0' }}>
        {t('Media is made by the provider you pick, with your own key, and billed by them. OpenAI, Google, OpenRouter, xAI, Together and Groq keys cover several kinds; ElevenLabs, Stability AI, Black Forest Labs and Deepgram add more.')}
      </p>

      {picking && (
        <MediaModelPicker
          output={picking}
          choices={state.available[picking]}
          selected={mediaRef(prefs, picking)}
          automatic={picked && !picked.explicit ? picked : null}
          onPick={(ref) => {
            const o = picking;
            update((m) => withMediaRef(m, o, ref));
            closePicker();
          }}
          onAddProvider={() => {
            closePicker();
            addProvider();
          }}
          onClose={closePicker}
        />
      )}
      {pickingVoice && speech && (
        <VoicePicker
          choice={speech}
          current={app.media.voiceFor(speech)}
          onPick={(v) => {
            update((m) => ({ ...m, voice: v, voiceFor: `${speech.provider.id}/${speech.model.id}` }));
            closeVoice();
          }}
          onClose={closeVoice}
        />
      )}
    </div>
  );
}

function Option({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="col gap-8">
      <span className="field-label">{title}</span>
      {children}
    </div>
  );
}

function MediaModelPicker({ output, choices, selected, automatic, onPick, onAddProvider, onClose }: {
  output: MediaOutput;
  choices: MediaChoice[];
  selected: ModelRef | null;
  automatic: MediaChoice | null;
  onPick: (ref: ModelRef | null) => void;
  onAddProvider: () => void;
  onClose: () => void;
}) {
  const close = useStableCallback(onClose);
  // A saved choice whose provider or model is gone counts as Automatic.
  const autoChecked = !choices.some((c) => sameRef(selected, c));
  const groups: Array<{ id: string; label: string; kindName: string; blocked: boolean; choices: MediaChoice[] }> = [];
  for (const c of choices) {
    let g = groups.find((x) => x.id === c.provider.id);
    if (!g) {
      g = { id: c.provider.id, label: c.provider.label, kindName: providerKind(c.provider.kind).displayName, blocked: c.browserBlocked, choices: [] };
      groups.push(g);
    }
    g.choices.push(c);
  }
  const anyBlocked = groups.some((g) => g.blocked);

  return (
    <Dialog title={pickerTitle(output)} onClose={close}>
      {choices.length === 0 ? (
        <div className="col gap-16">
          <p className="t-body c-2" style={{ margin: 0 }}>{sentences(noneMakesYet(output), whoMakes(output))}</p>
          <div className="row">
            <Button onClick={onAddProvider}>
              <Plus size={18} />
              {t('Add a provider')}
            </Button>
          </div>
        </div>
      ) : (
        <div className="col gap-12">
          {anyBlocked && <Notice tone="warn">{t('Some of your providers don’t accept requests from web browsers. Their models work in the Facet app for Windows and Android.')}</Notice>}
          <div className="group outlined">
            <ChoiceRow
              leading={<span className="srow-icon c-primary"><Sparkles size={20} /></span>}
              title={t('Automatic')}
              subtitle={automatic ? t('Now: {model}', { model: automatic.label }) : t('The best model you have')}
              checked={autoChecked}
              onClick={() => onPick(null)}
            />
          </div>
          {groups.map((g) => (
            <OutlinedGroup
              key={g.id}
              title={
                <span className="row gap-8">
                  <span className="grow ellipsis"><bdi>{g.label}</bdi></span>
                  {g.blocked && <BlockedBadge />}
                </span>
              }
            >
              {g.choices.map((c, i) => {
                const checked = sameRef(selected, c);
                return (
                  <div key={c.model.id}>
                    {i > 0 && <Sep inset={58} />}
                    <ChoiceRow
                      leading={<ProviderBadge name={g.kindName} size={28} />}
                      title={c.model.displayName}
                      subtitle={c.model.id}
                      checked={checked}
                      disabled={c.browserBlocked && !checked}
                      hint={c.browserBlocked ? t('This provider doesn’t accept requests from web browsers. It works in the Facet app for Windows and Android.') : undefined}
                      onClick={() => onPick(c.ref)}
                    />
                  </div>
                );
              })}
            </OutlinedGroup>
          ))}
        </div>
      )}
    </Dialog>
  );
}

function VoicePicker({ choice, current, onPick, onClose }: { choice: MediaChoice; current: string; onPick: (voice: string) => void; onClose: () => void }) {
  const app = getApp();
  const close = useStableCallback(onClose);
  const [voices, setVoices] = useState<Voice[] | null>(null);
  const [query, setQuery] = useState('');
  const providerId = choice.provider.id;
  const modelId = choice.model.id;

  useEffect(() => {
    const ctl = new AbortController();
    app.media.voices(choice, ctl.signal).then(
      (v) => !ctl.signal.aborted && setVoices(v),
      () => !ctl.signal.aborted && setVoices([]),
    );
    return () => ctl.abort();
  }, [providerId, modelId]);

  const q = query.trim().toLowerCase();
  const shown = voices && q ? voices.filter((v) => v.name.toLowerCase().includes(q)) : voices;

  return (
    <Dialog title={t('Voice')} onClose={close}>
      <div className="col gap-12">
        <span className="t-label-m c-3" style={{ fontWeight: 400, marginTop: -6 }}>{choice.label}</span>
        {voices && voices.length > 12 && <FilterBox value={query} onChange={setQuery} placeholder={t('Search voices')} />}
        {!shown ? (
          <div className="row gap-8 c-3 t-body" style={{ padding: '8px 4px' }}>
            <Spinner />
            {t('Loading voices…')}
          </div>
        ) : shown.length === 0 ? (
          <p className="t-body c-3" style={{ margin: 0 }}>{q ? t('No voices match “{query}”.', { query: query.trim() }) : t('No voices found for this model.')}</p>
        ) : (
          <div className="group outlined">
            {shown.map((v, i) => (
              <div key={v.id || 'default'}>
                {i > 0 && <Sep />}
                <ChoiceRow
                  leading={<span className="srow-icon"><AudioLines size={20} /></span>}
                  title={<bdi>{v.name}</bdi>}
                  checked={v.id === current}
                  onClick={() => onPick(v.id)}
                />
              </div>
            ))}
          </div>
        )}
      </div>
    </Dialog>
  );
}
