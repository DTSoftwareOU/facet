/** The models section of a provider's page: refresh, add by ID, filter, favorites, hide/show and per-model edits. */
import { Eye, EyeOff, MoreHorizontal, Plus, RefreshCw, Star } from 'lucide-react';
import { useCallback, useState } from 'react';
import { getApp } from '../../app';
import { Dates } from '../../core/format';
import type { ProviderEntity } from '../../data/entities';
import { isCustomized } from '../../data/providers';
import { MEDIA_OUTPUTS } from '../../domain/media/service';
import { canRun, displayName, inferCaps, mediaOutput, modelInfo } from '../../llm/catalog';
import type { ProviderKind } from '../../llm/providers';
import { t, tm, tn } from '../../i18n';
import { defaultCaps, MODEL_OUTPUT_INFO, type ModelInfo, type ModelOutput } from '../../llm/types';
import { Button, Dialog, Field, IconButton, Menu, useMenu, useToast, type MenuItem } from '../components/primitives';
import { ModelEditDialog } from './ModelEditDialog';
import { ActionRow, errorText, FilterBox, Sep, useStableCallback } from './common';

/** Rows shown before "Show all" on providers with long lists. */
const PREVIEW = 12;

function updatedLabel(at: number): string {
  return Dates.justNow(at) ? t('Updated just now') : t('Updated {time}', { time: Dates.relative(at) });
}

export function ProviderModels({ provider: p, kind }: { provider: ProviderEntity; kind: ProviderKind }) {
  const app = getApp();
  const menu = useMenu();
  const [query, setQuery] = useState('');
  const [showAll, setShowAll] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; text: string } | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const closeEdit = useCallback(() => setEditing(null), []);
  const closeAdd = useCallback(() => setAdding(false), []);

  const models = app.providers.models(p);
  const favorites = app.providers.favorites(p);
  const prefs = app.providers.modelPrefs(p);
  const hidden = new Set(Object.keys(prefs).filter((id) => prefs[id].hidden));
  const hiddenCount = models.filter((m) => hidden.has(m.id)).length;
  const q = query.trim().toLowerCase();
  const filtered = q ? models.filter((m) => m.displayName.toLowerCase().includes(q) || m.id.toLowerCase().includes(q)) : models;
  const mediaOnly = kind.style === 'MEDIA';
  const shown = showAll || q || mediaOnly ? filtered : filtered.slice(0, PREVIEW);

  const refresh = async () => {
    setRefreshing(true);
    setResult(null);
    try {
      const list = await app.providers.refreshModels(p.id);
      setResult({ ok: true, text: tn('{provider} lists {count} model.', '{provider} lists {count} models.', list.length, { provider: kind.displayName }) });
    } catch (e) {
      setResult({ ok: false, text: errorText(e, t('Couldn’t load the model list. Try again.')) });
    } finally {
      setRefreshing(false);
    }
  };

  const menuItems = (): MenuItem[] => {
    const ids = filtered.map((m) => m.id);
    const items: MenuItem[] = [
      { label: q ? tn('Show {count} matching', 'Show {count} matching', ids.length) : t('Show all'), icon: <Eye size={17} />, onSelect: () => void app.providers.setHidden(p.id, ids, false) },
      { label: q ? tn('Hide {count} matching', 'Hide {count} matching', ids.length) : t('Hide all'), icon: <EyeOff size={17} />, onSelect: () => void app.providers.setHidden(p.id, ids, true) },
    ];
    if (!q && favorites.size > 0) {
      items.push({
        label: t('Show only favorites'),
        icon: <Star size={17} />,
        onSelect: () => {
          void (async () => {
            await app.providers.setHidden(p.id, models.filter((m) => !favorites.has(m.id)).map((m) => m.id), true);
            await app.providers.setHidden(p.id, [...favorites], false);
          })();
        },
      });
    }
    return items;
  };

  const row = (m: ModelInfo, i: number) => {
    const isHidden = hidden.has(m.id);
    const fav = favorites.has(m.id);
    const edited = prefs[m.id] ? isCustomized(prefs[m.id]) : false;
    const sub = [
      isHidden ? t('Hidden') : null,
      edited ? t('Edited') : null,
      !mediaOnly && m.output !== 'TEXT' ? tm(MODEL_OUTPUT_INFO[m.output].label) : null,
      m.id,
    ].filter(Boolean).join(' · ');
    return (
      <div key={m.id}>
        {i > 0 && <Sep inset={16} />}
        <ActionRow
          compact
          dim={isHidden}
          title={m.displayName}
          subtitle={sub}
          subLines={1}
          onClick={() => setEditing(m.id)}
          trailing={
            <>
              <IconButton small label={isHidden ? t('Show {model}', { model: m.displayName }) : t('Hide {model}', { model: m.displayName })} onClick={() => void app.providers.setHidden(p.id, [m.id], !isHidden)}>
                {isHidden ? <EyeOff size={17} /> : <Eye size={17} />}
              </IconButton>
              <IconButton
                small
                label={fav ? t('Remove {model} from favorites', { model: m.displayName }) : t('Add {model} to favorites', { model: m.displayName })}
                aria-pressed={fav}
                onClick={() => void app.providers.toggleFavorite(p.id, m.id)}
                style={fav ? { color: 'var(--gold)' } : undefined}
              >
                <Star size={17} fill={fav ? 'currentColor' : 'none'} />
              </IconButton>
            </>
          }
        />
      </div>
    );
  };

  // Media-only providers list a handful of models; group them by what they make.
  const sections: Array<{ output: ModelOutput | null; models: ModelInfo[] }> = mediaOnly
    ? [...MEDIA_OUTPUTS, 'TEXT' as const].map((o) => ({ output: o, models: shown.filter((m) => m.output === o) })).filter((s) => s.models.length > 0)
    : [{ output: null, models: shown }];

  return (
    <section className="col gap-8">
      <div className="row gap-8" style={{ margin: '14px 4px 0', minHeight: 30 }}>
        <h3 className="group-title grow" style={{ margin: 0 }}>
          {hiddenCount > 0 ? tn('Models · {count} hidden', 'Models · {count} hidden', hiddenCount) : t('Models')}
        </h3>
        {p.modelsFetchedAt > 0 && <span className="t-label-s c-3" style={{ fontWeight: 400 }}>{updatedLabel(p.modelsFetchedAt)}</span>}
        {models.length > 0 && (
          <IconButton small label={t('Show or hide models')} onClick={menu.open} aria-haspopup="menu">
            <MoreHorizontal size={18} />
          </IconButton>
        )}
      </div>
      <p className="field-hint" style={{ margin: '-4px 4px 0' }}>{t('Click a model to rename it, change what it makes or can do, or set its price.')}</p>
      <div className="group">
        <div className="models-toolbar">
          <Button variant="tonal" small busy={refreshing} onClick={refresh}>
            {!refreshing && <RefreshCw size={15} />}
            {t('Refresh')}
          </Button>
          <Button variant="tonal" small onClick={() => setAdding(true)}>
            <Plus size={15} />
            {t('Add model ID')}
          </Button>
          {models.length > 8 && <FilterBox value={query} onChange={setQuery} placeholder={t('Filter models')} />}
        </div>
        {result && (
          <p className={'t-label-m ' + (result.ok ? 'c-2' : 'c-error')} role={result.ok ? 'status' : 'alert'} style={{ margin: 0, padding: '0 16px 10px', fontWeight: 400 }}>
            {result.text}
          </p>
        )}
        {models.length === 0 && <p className="t-body c-3" style={{ margin: 0, padding: '8px 16px 16px' }}>{t('No models yet. Refresh, or add a model ID.')}</p>}
        {models.length > 0 && filtered.length === 0 && <p className="t-body c-3" style={{ margin: 0, padding: '8px 16px 16px' }}>{t('No models match “{query}”.', { query: query.trim() })}</p>}
        {sections.map((s) => (
          <div key={s.output ?? 'all'}>
            {s.output && <div className="group-section">{tm(MODEL_OUTPUT_INFO[s.output].label)}</div>}
            {s.models.map(row)}
          </div>
        ))}
        {!showAll && !q && !mediaOnly && filtered.length > shown.length && (
          <>
            <Sep inset={16} />
            <button type="button" className="show-more" onClick={() => setShowAll(true)}>{tn('Show all {count}', 'Show all {count}', filtered.length)}</button>
          </>
        )}
      </div>
      {menu.anchor && <Menu anchor={menu.anchor} items={menuItems()} onClose={menu.close} align="end" />}
      {editing && <ModelEditDialog provider={p} kind={kind} modelId={editing} onClose={closeEdit} />}
      {adding && <AddModelDialog provider={p} kind={kind} models={models} onClose={closeAdd} />}
    </section>
  );
}

/** What a hand-typed model ID most likely makes: media-looking IDs go to their kind; you can correct it in the model's settings. */
function guessOutput(kind: ProviderKind, id: string): ModelOutput {
  const media = mediaOutput(kind, id);
  if (media && canRun(kind, media)) return media;
  if (kind.style === 'MEDIA') return MEDIA_OUTPUTS.find((o) => canRun(kind, o)) ?? 'IMAGE';
  return 'TEXT';
}

/** The toast after adding a model by hand, naming what it makes. */
function addedText(output: ModelOutput, name: string): string {
  switch (output) {
    case 'IMAGE': return t('Added {name} as an image model.', { name });
    case 'VIDEO': return t('Added {name} as a video model.', { name });
    case 'SPEECH': return t('Added {name} as a speech model.', { name });
    case 'MUSIC': return t('Added {name} as a music model.', { name });
    case 'TRANSCRIPTION': return t('Added {name} as a transcription model.', { name });
    default: return t('Added {name}.', { name });
  }
}

function AddModelDialog({ provider, kind, models, onClose }: { provider: ProviderEntity; kind: ProviderKind; models: ModelInfo[]; onClose: () => void }) {
  const app = getApp();
  const toast = useToast();
  const close = useStableCallback(onClose);
  const [id, setId] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    const mid = id.trim();
    if (!mid || busy) return;
    if (models.some((m) => m.id === mid)) {
      setError(t('That model is already in the list.'));
      return;
    }
    const output = guessOutput(kind, mid);
    const caps = output === 'TEXT' ? inferCaps(kind, mid) : defaultCaps({ tools: false });
    const name = displayName(kind, mid);
    setBusy(true);
    try {
      await app.providers.addCustomModel(provider.id, modelInfo(mid, name, { caps, output }));
      toast(addedText(output, name));
      close();
    } catch (e) {
      setError(errorText(e, t('Couldn’t add that model. Try again.')));
      setBusy(false);
    }
  };

  return (
    <Dialog
      title={t('Add a model ID')}
      onClose={close}
      size="narrow"
      footer={
        <>
          <Button variant="text" onClick={close}>{t('Cancel')}</Button>
          <Button onClick={submit} busy={busy} disabled={!id.trim()}>{t('Add')}</Button>
        </>
      }
    >
      <Field
        label={t('Model ID')}
        error={error ?? undefined}
        hint={t('The exact ID {provider} uses. Facet guesses what it can do; click it afterwards to correct anything.', { provider: kind.displayName })}
      >
        <input
          className="input mono"
          dir="ltr"
          value={id}
          onChange={(e) => {
            setId(e.target.value);
            setError(null);
          }}
          onKeyDown={(e) => e.key === 'Enter' && submit()}
          placeholder={t('e.g. {example} or {other}', { example: 'gpt-5.5', other: 'claude-opus-5-5' })}
          autoCapitalize="off"
          autoComplete="off"
          spellCheck={false}
        />
      </Field>
    </Dialog>
  );
}
