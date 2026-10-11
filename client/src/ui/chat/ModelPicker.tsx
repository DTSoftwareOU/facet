import { Brain, Eye, FileText, Globe, KeyRound, Search, Star, Wrench } from 'lucide-react';
import { useMemo, useState } from 'react';
import { getApp } from '../../app';
import { Format } from '../../core/format';
import type { ModelRef } from '../../data/prefs';
import type { ProviderModels } from '../../data/providers';
import { providerDisplayName } from '../../llm/providers';
import { t, tn } from '../../i18n';
import type { ModelInfo } from '../../llm/types';
import { platform } from '../../platform';
import { ProviderBadge } from '../components/Avatars';
import { Button, Dialog } from '../components/primitives';
import { useCatalog } from '../hooks';
import { ui } from '../nav';

export interface ResolvedModel {
  ref: ModelRef;
  model: ModelInfo;
  providerLabel: string;
  kindName: string;
}

/** Finds a model in the catalog (hidden models still resolve: chats may already use them). */
export function resolveModel(catalog: ProviderModels[] | undefined, ref: ModelRef | null | undefined): ResolvedModel | null {
  if (!catalog || !ref) return null;
  const p = catalog.find((c) => c.provider.id === ref.providerId);
  if (!p) return null;
  const model = p.models.find((m) => m.id === ref.modelId) ?? getApp().providers.modelInfo(p.provider, ref.modelId);
  return { ref, model, providerLabel: p.provider.label || providerDisplayName(p.kind), kindName: p.kind.displayName };
}

/** The first usable model: favorites first, then the provider's list order. */
export function firstModel(catalog: ProviderModels[] | undefined): ModelRef | null {
  if (!catalog) return null;
  for (const p of catalog) {
    const fav = p.models.find((m) => p.favorites.has(m.id) && !p.hidden.has(m.id));
    if (fav) return { providerId: p.provider.id, modelId: fav.id };
  }
  for (const p of catalog) {
    const m = p.models.find((x) => !p.hidden.has(x.id));
    if (m) return { providerId: p.provider.id, modelId: m.id };
  }
  return null;
}

function CapIcons({ m }: { m: ModelInfo }) {
  const c = m.caps;
  return (
    <span className="row gap-6 c-3" aria-hidden>
      {c.vision && <Eye size={14} />}
      {c.pdf && <FileText size={14} />}
      {c.reasoning.kind !== 'NONE' && <Brain size={14} />}
      {c.webSearch && <Globe size={14} />}
      {c.tools && <Wrench size={14} />}
    </span>
  );
}

export function ModelPicker({ current, onPick, onClose, title }: {
  current: ModelRef | null;
  onPick: (ref: ModelRef) => void;
  onClose: () => void;
  title?: string;
}) {
  const app = getApp();
  const catalog = useCatalog();
  const [q, setQ] = useState('');
  const query = q.trim().toLowerCase();

  const groups = useMemo(() => {
    if (!catalog) return [];
    return catalog
      .map((p) => {
        let models = p.models.filter((m) => !p.hidden.has(m.id) || (current?.providerId === p.provider.id && current.modelId === m.id));
        if (query) models = models.filter((m) => m.displayName.toLowerCase().includes(query) || m.id.toLowerCase().includes(query) || p.provider.label.toLowerCase().includes(query));
        const favs = models.filter((m) => p.favorites.has(m.id));
        const rest = models.filter((m) => !p.favorites.has(m.id));
        return { p, models: [...favs, ...rest] };
      })
      .filter((g) => g.models.length > 0);
  }, [catalog, query, current]);

  const blocked = (p: ProviderModels) => platform().corsLimited && !p.kind.browserOk;

  return (
    <Dialog title={title ?? t('Choose a model')} onClose={onClose} size="wide">
      <div className="row gap-8" style={{ position: 'sticky', top: 0, background: 'var(--surface)', paddingBottom: 10, zIndex: 1 }}>
        <div className="row grow" style={{ background: 'var(--surface-high)', borderRadius: 14, padding: '0 12px', gap: 8 }}>
          <Search size={17} className="c-3" />
          <input
            className="input"
            style={{ background: 'transparent', border: 0, padding: '10px 0' }}
            placeholder={t('Search models')}
            aria-label={t('Search models')}
            value={q}
            onChange={(e) => setQ(e.target.value)}
            autoFocus
          />
        </div>
      </div>
      {catalog && catalog.length === 0 && (
        <div className="empty">
          <div className="empty-icon"><KeyRound size={24} /></div>
          <div className="t-title-m" style={{ color: 'var(--text)' }}>{t('No providers yet')}</div>
          <div className="t-body">{t('Add an API key to see its models here.')}</div>
          <Button onClick={() => { onClose(); ui.openSettings('providers'); }}>{t('Add a provider')}</Button>
        </div>
      )}
      {catalog && catalog.length > 0 && groups.length === 0 && <div className="empty t-body">{t('No models match “{query}”.', { query: q })}</div>}
      {groups.map(({ p, models }) => (
        <section key={p.provider.id} style={{ marginBottom: 14 }}>
          <div className="row gap-8" style={{ padding: '8px 4px' }}>
            <ProviderBadge name={p.kind.displayName} />
            <span className="t-label-m c-2 grow"><bdi>{p.provider.label || providerDisplayName(p.kind)}</bdi></span>
            {blocked(p) && <span className="badge warning" title={t("This provider doesn't accept requests from web browsers.")}>{t('Windows and Android only')}</span>}
          </div>
          <div className="group">
            {models.slice(0, query ? 200 : 60).map((m, i) => {
              const selected = current?.providerId === p.provider.id && current.modelId === m.id;
              const fav = p.favorites.has(m.id);
              return (
                <div key={m.id}>
                  {i > 0 && <div className="group-divider full" />}
                  <div
                    className="srow clickable"
                    role="button"
                    tabIndex={0}
                    aria-pressed={selected}
                    style={selected ? { background: 'var(--primary-container)' } : undefined}
                    onClick={() => { onPick({ providerId: p.provider.id, modelId: m.id }); onClose(); }}
                    onKeyDown={(e) => {
                      if (e.target !== e.currentTarget || (e.key !== 'Enter' && e.key !== ' ')) return;
                      e.preventDefault();
                      onPick({ providerId: p.provider.id, modelId: m.id });
                      onClose();
                    }}
                  >
                    <span className="srow-text">
                      <span className="srow-title row gap-8">
                        <span className="ellipsis">{m.displayName}</span>
                        <CapIcons m={m} />
                      </span>
                      <span className="srow-sub ellipsis">
                        {[
                          m.id,
                          m.contextWindow ? t('{size} context', { size: Format.contextWindow(m.contextWindow) }) : '',
                          m.pricing ? t('${input}/${output} per 1M', { input: String(m.pricing.input), output: String(m.pricing.output) }) : '',
                        ].filter(Boolean).join(' · ')}
                      </span>
                    </span>
                    <button
                      type="button"
                      className="icon-btn sm"
                      aria-label={fav ? t('Remove from favorites') : t('Add to favorites')}
                      title={fav ? t('Remove from favorites') : t('Add to favorites')}
                      onClick={(e) => {
                        e.stopPropagation();
                        void app.providers.toggleFavorite(p.provider.id, m.id);
                      }}
                      style={fav ? { color: 'var(--gold)' } : undefined}
                    >
                      <Star size={17} fill={fav ? 'currentColor' : 'none'} />
                    </button>
                  </div>
                </div>
              );
            })}
            {!query && models.length > 60 && <div className="srow"><span className="srow-sub">{tn('{count} more. Search to find it.', '{count} more. Search to find them.', models.length - 60)}</span></div>}
          </div>
        </section>
      ))}
      {catalog && catalog.length > 0 && (
        <div className="row" style={{ justifyContent: 'center', padding: '6px 0 4px' }}>
          <Button variant="text" onClick={() => { onClose(); ui.openSettings('providers'); }}>{t('Manage providers and models')}</Button>
        </div>
      )}
    </Dialog>
  );
}
