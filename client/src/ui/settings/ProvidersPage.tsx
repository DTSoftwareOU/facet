/**
 * Settings → Providers and keys (port of ProviderScreens.kt): the connected providers, adding one
 * from the presets, and each provider's page (key, address, models). Sub-pages use `detail`:
 * "new:<kind id>" for the add form, otherwise a provider id.
 */
import { useLiveQuery } from 'dexie-react-hooks';
import { ChevronDown, ExternalLink, Plus, Power, Trash2 } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { getApp } from '../../app';
import { db } from '../../data/db';
import type { ProviderEntity } from '../../data/entities';
import { ALL_PROVIDER_KINDS, normalizeBaseUrl, providerKind, ProviderKinds, type ProviderKind } from '../../llm/providers';
import { platform } from '../../platform';
import { isSearchKind } from '../../tools/types';
import { ProviderBadge } from '../components/Avatars';
import { Button, Confirm, Dialog, Field, Group, Row, Spinner, SwitchRow, useToast } from '../components/primitives';
import { useProviders } from '../hooks';
import { ui } from '../nav';
import { ProviderModels } from './ProviderModels';
import type { PageProps } from './SettingsDialog';
import { ActionRow, BlockedBadge, browserBlocked, errorText, FilterBox, Notice, OutlinedGroup, plural, SecretInput, Sep, useStableCallback } from './common';

const NEW = 'new:';
const LOCAL_IDS = new Set<string>([ProviderKinds.OLLAMA.id, ProviderKinds.LMSTUDIO.id]);
const OPEN_IDS = new Set<string>([...LOCAL_IDS, ProviderKinds.CUSTOM.id]);

/** Presets in the order Android offers them. */
const PRESET_GROUPS: Array<{ title: string; kinds: readonly ProviderKind[] }> = [
  { title: 'Chat models', kinds: ALL_PROVIDER_KINDS.filter((k) => k.style !== 'MEDIA' && !OPEN_IDS.has(k.id)) },
  { title: 'Media only', kinds: ALL_PROVIDER_KINDS.filter((k) => k.style === 'MEDIA') },
  { title: 'On your computer or custom', kinds: ALL_PROVIDER_KINDS.filter((k) => OPEN_IDS.has(k.id)) },
];

/** A one-time message for a provider's page (e.g. the result of adding it). */
interface Flash {
  id: string;
  ok: boolean;
  text: string;
}

export function ProvidersPage({ detail }: PageProps) {
  const [flash, setFlash] = useState<Flash | null>(null);
  // A flash belongs to the page it was made for; leaving that page drops it.
  useEffect(() => {
    if (flash && detail !== flash.id) setFlash(null);
  }, [detail]);

  if (detail?.startsWith(NEW)) return <AddProvider key={detail} kind={providerKind(detail.slice(NEW.length))} onAdded={setFlash} />;
  if (detail) return <ProviderDetail key={detail} id={detail} flash={flash?.id === detail ? flash : null} />;
  return <ProviderList />;
}

// ---------------------------------------------------------------- list

function ProviderList() {
  const all = useProviders();
  const [picking, setPicking] = useState(false);
  const closePicker = useCallback(() => setPicking(false), []);
  const add = (k: ProviderKind) => ui.openSettings('providers', NEW + k.id);

  if (!all) return <Spinner />;
  // Search keys (Brave, Tavily…) are stored as providers too, but they live on the Tools page.
  const providers = all.filter((p) => !isSearchKind(p.kind));

  if (providers.length === 0) {
    return (
      <div className="col gap-16">
        <p className="settings-intro t-body">
          Facet talks to AI providers directly with your own API keys. Pick one to get started; you can add as many as you like.
        </p>
        <PresetGroups onPick={add} />
      </div>
    );
  }

  return (
    <div className="col gap-16">
      <Group title="Connected">
        {providers.map((p, i) => (
          <div key={p.id}>
            {i > 0 && <Sep inset={64} />}
            <ConnectedRow provider={p} />
          </div>
        ))}
      </Group>
      <div className="row gap-8 row-wrap">
        <Button onClick={() => setPicking(true)}>
          <Plus size={18} />
          Add a provider
        </Button>
      </div>
      <p className="field-hint" style={{ margin: '-4px 6px 0' }}>
        Keys are encrypted on this device and synced end-to-end. Facet’s server can’t read them.
      </p>
      {picking && <PresetDialog onPick={add} onClose={closePicker} />}
    </div>
  );
}

function ConnectedRow({ provider: p }: { provider: ProviderEntity }) {
  const kind = providerKind(p.kind);
  const count = getApp().providers.models(p).length;
  const subtitle = [
    p.label !== kind.displayName ? kind.displayName : null,
    count > 0 || p.modelsFetchedAt > 0 ? plural(count, 'model') : 'No models yet',
    p.enabled ? null : 'Off',
  ].filter(Boolean).join(' · ');
  return (
    <ActionRow
      leading={<ProviderBadge name={kind.displayName} size={34} />}
      title={p.label}
      subtitle={subtitle}
      dim={!p.enabled}
      aside={browserBlocked(kind) ? <BlockedBadge /> : undefined}
      chevron
      onClick={() => ui.openSettings('providers', p.id)}
    />
  );
}

function PresetGroups({ onPick, query = '', inDialog }: { onPick: (k: ProviderKind) => void; query?: string; inDialog?: boolean }) {
  const GroupBox = inDialog ? OutlinedGroup : Group;
  const q = query.trim().toLowerCase();
  const groups = PRESET_GROUPS
    .map((g) => ({ ...g, kinds: g.kinds.filter((k) => !q || k.displayName.toLowerCase().includes(q) || k.blurb.toLowerCase().includes(q)) }))
    .filter((g) => g.kinds.length > 0);
  if (groups.length === 0) {
    return (
      <div className="empty">
        <span className="t-body">No preset matches “{query.trim()}”. Any OpenAI-compatible API works as a custom endpoint.</span>
        <Button variant="tonal" onClick={() => onPick(ProviderKinds.CUSTOM)}>
          <Plus size={18} />
          Add a custom endpoint
        </Button>
      </div>
    );
  }
  return (
    <>
      {groups.map((g) => (
        <GroupBox key={g.title} title={g.title}>
          {g.kinds.map((k, i) => (
            <div key={k.id}>
              {i > 0 && <Sep inset={64} />}
              <ActionRow
                leading={<ProviderBadge name={k.displayName} size={34} />}
                title={k.displayName}
                subtitle={k.blurb}
                aside={
                  <>
                    {browserBlocked(k) && <BlockedBadge />}
                    <Plus size={18} className="srow-chevron" aria-hidden />
                  </>
                }
                onClick={() => onPick(k)}
              />
            </div>
          ))}
        </GroupBox>
      ))}
    </>
  );
}

function PresetDialog({ onPick, onClose }: { onPick: (k: ProviderKind) => void; onClose: () => void }) {
  const close = useStableCallback(onClose);
  const [query, setQuery] = useState('');
  return (
    <Dialog title="Add a provider" onClose={close}>
      <div className="sticky-top">
        <FilterBox value={query} onChange={setQuery} placeholder="Search providers" />
      </div>
      <div style={{ marginTop: -12 }}>
        <PresetGroups
          inDialog
          query={query}
          onPick={(k) => {
            close();
            onPick(k);
          }}
        />
      </div>
    </Dialog>
  );
}

// ---------------------------------------------------------------- add and edit

function ProviderHero({ kind, title, subtitle }: { kind: ProviderKind; title: string; subtitle: string }) {
  return (
    <div className="row gap-12 page-hero">
      <ProviderBadge name={kind.displayName} size={44} />
      <div className="col grow">
        <span className="t-title-m ellipsis">{title}</span>
        <span className="t-label-m c-2" style={{ fontWeight: 400 }}>{subtitle}</span>
      </div>
    </div>
  );
}

function AddProvider({ kind, onAdded }: { kind: ProviderKind; onAdded: (f: Flash) => void }) {
  return (
    <div className="col gap-16">
      <ProviderHero kind={kind} title={`Add ${kind.displayName}`} subtitle={kind.blurb} />
      <ProviderForm kind={kind} existing={null} initial={{ label: kind.displayName, key: '', baseUrl: kind.defaultBaseUrl, headers: '' }} onAdded={onAdded} />
    </div>
  );
}

function ProviderDetail({ id, flash }: { id: string; flash: Flash | null }) {
  const app = getApp();
  const toast = useToast();
  // undefined while loading, null when it doesn't exist.
  const p = useLiveQuery(async () => (await db().providers.get(id)) ?? null, [id]);
  const [initial, setInitial] = useState<FormValues | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const closeConfirm = useCallback(() => setConfirmDelete(false), []);

  useEffect(() => {
    if (!p || p.deleted || initial) return;
    let cancelled = false;
    void app.providers.apiKey(p).then((key) => {
      if (!cancelled) setInitial({ label: p.label, key, baseUrl: p.baseUrl, headers: headersText(app.providers.headers(p)) });
    });
    return () => {
      cancelled = true;
    };
  }, [p, initial]);

  if (p === null || p?.deleted) {
    return (
      <div className="empty">
        <span className="t-body">This provider was removed, maybe from another device.</span>
        <Button variant="tonal" onClick={() => ui.openSettings('providers', null)}>Back to providers</Button>
      </div>
    );
  }
  if (!p || !initial) return <Spinner />;
  if (isSearchKind(p.kind)) {
    return (
      <div className="empty">
        <span className="t-body">This is a web search key. It’s managed on the Tools page.</span>
        <Button variant="tonal" onClick={() => ui.openSettings('tools')}>Open Tools</Button>
      </div>
    );
  }

  const kind = providerKind(p.kind);
  return (
    <div className="col gap-16">
      <ProviderHero
        kind={kind}
        title={p.label}
        subtitle={p.label !== kind.displayName ? `${kind.displayName} · ${kind.blurb}` : kind.blurb}
      />
      {flash && <Notice tone={flash.ok ? 'ok' : 'error'}>{flash.text}</Notice>}
      <ProviderForm kind={kind} existing={p} initial={initial} />
      <Group>
        <SwitchRow
          icon={<Power size={20} />}
          title="Enabled"
          subtitle="Turn off to hide its models without deleting the key."
          checked={p.enabled}
          onChange={(v) => void app.providers.update(p.id, { label: p.label, baseUrl: p.baseUrl, headers: app.providers.headers(p), enabled: v })}
        />
      </Group>
      <ProviderModels provider={p} kind={kind} />
      <Group>
        <Row icon={<Trash2 size={20} />} title="Remove provider" subtitle="Deletes this key from all your devices." danger onClick={() => setConfirmDelete(true)} />
      </Group>
      {confirmDelete && (
        <Confirm
          title={`Remove ${p.label}?`}
          body="The key is deleted from all your devices. Chats that used it stay, but need another model to continue."
          confirm="Remove"
          danger
          onConfirm={async () => {
            await app.providers.delete(p.id);
            ui.openSettings('providers', null);
            toast(`Removed ${p.label}.`);
          }}
          onClose={closeConfirm}
        />
      )}
    </div>
  );
}

interface FormValues {
  label: string;
  key: string;
  baseUrl: string;
  /** "Name: value" lines. */
  headers: string;
}

function headersText(h: Record<string, string>): string {
  return Object.entries(h).map(([k, v]) => `${k}: ${v}`).join('\n');
}

function parseHeaders(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split('\n')) {
    const i = line.indexOf(':');
    if (i <= 0) continue;
    const name = line.slice(0, i).trim();
    if (name) out[name] = line.slice(i + 1).trim();
  }
  return out;
}

const validUrl = (u: string) => /^https?:\/\/[^\s/]+/i.test(u.trim());

function baseUrlHint(kind: ProviderKind): string {
  if (LOCAL_IDS.has(kind.id)) {
    const example = kind.defaultBaseUrl.replace('localhost', '192.168.1.20');
    return `Where ${kind.displayName} runs. The default works on this computer; for another one use its address, e.g. ${example}`;
  }
  if (kind.id === ProviderKinds.CUSTOM.id) return 'Any OpenAI-compatible endpoint, ending before /chat/completions.';
  return 'Change only for a proxy or a compatible gateway.';
}

/** What the website can't do with this kind of provider, if anything. */
function webNotice(kind: ProviderKind): { tone: 'warn' | 'info'; text: string } | null {
  if (!platform().corsLimited) return null;
  if (!kind.browserOk) {
    return {
      tone: 'warn',
      text: `${kind.displayName} doesn’t accept requests from web browsers, so it can’t be used on this website. You can still add your key here: it syncs to the Facet app for Windows and Android, where it works.`,
    };
  }
  if (kind.id === ProviderKinds.OLLAMA.id) {
    return { tone: 'info', text: 'On the website, Ollama has to allow requests from web pages: start it with OLLAMA_ORIGINS set to this site’s address. The Facet app for Windows doesn’t need this.' };
  }
  if (kind.id === ProviderKinds.LMSTUDIO.id) {
    return { tone: 'info', text: 'On the website, LM Studio has to allow requests from web pages: turn on CORS in its server settings. The Facet app for Windows doesn’t need this.' };
  }
  if (kind.id === ProviderKinds.CUSTOM.id) {
    return { tone: 'info', text: 'On the website, the endpoint has to accept requests from web pages (CORS). If yours doesn’t, use the Facet app for Windows or Android.' };
  }
  return null;
}

function ProviderForm({ kind, existing, initial, onAdded }: {
  kind: ProviderKind;
  existing: ProviderEntity | null;
  initial: FormValues;
  onAdded?: (f: Flash) => void;
}) {
  const app = getApp();
  const [label, setLabel] = useState(initial.label);
  const [key, setKey] = useState(initial.key);
  const [keyChanged, setKeyChanged] = useState(false);
  const [baseUrl, setBaseUrl] = useState(initial.baseUrl);
  const [headers, setHeaders] = useState(initial.headers);
  const [advanced, setAdvanced] = useState(
    OPEN_IDS.has(kind.id) || normalizeBaseUrl(initial.baseUrl) !== normalizeBaseUrl(kind.defaultBaseUrl) || initial.headers.trim() !== '',
  );
  const [testing, setTesting] = useState(false);
  const [saving, setSaving] = useState(false);
  const [status, setStatus] = useState<{ ok: boolean; text: string } | null>(null);

  const parsed = parseHeaders(headers);
  const urlOk = validUrl(baseUrl);
  const ready = (!kind.requiresKey || key.trim() !== '') && urlOk;
  const dirty = !existing || (
    keyChanged ||
    (label.trim() || kind.displayName) !== existing.label ||
    normalizeBaseUrl(baseUrl) !== existing.baseUrl ||
    JSON.stringify(parsed) !== JSON.stringify(app.providers.headers(existing))
  );
  const notice = webNotice(kind);
  const edit = () => setStatus(null);

  const test = async () => {
    setTesting(true);
    setStatus(null);
    try {
      await app.providers.verify(kind, baseUrl, key, parsed);
      setStatus({ ok: true, text: key.trim() ? 'Connected. This key works.' : 'Connected.' });
    } catch (e) {
      setStatus({ ok: false, text: errorText(e, 'That didn’t work. Check the key and address, then try again.') });
    } finally {
      setTesting(false);
    }
  };

  const save = async () => {
    setSaving(true);
    setStatus(null);
    if (!existing) {
      let p: ProviderEntity;
      try {
        p = await app.providers.add(kind, label, baseUrl, key, parsed);
      } catch (e) {
        setStatus({ ok: false, text: errorText(e, 'Couldn’t save the provider. Try again.') });
        setSaving(false);
        return;
      }
      let flash: Flash;
      try {
        const models = await app.providers.refreshModels(p.id);
        flash = { id: p.id, ok: true, text: `Connected. ${plural(models.length, 'model')} ready to use.` };
      } catch (e) {
        flash = { id: p.id, ok: false, text: `${errorText(e, 'The model list didn’t load.')} The provider was saved: fix the key below, or add model IDs by hand.` };
      }
      onAdded?.(flash);
      ui.openSettings('providers', p.id);
      return;
    }
    try {
      await app.providers.update(existing.id, { label, baseUrl, apiKey: keyChanged ? key : undefined, headers: parsed, enabled: existing.enabled });
      setKeyChanged(false);
    } catch (e) {
      setStatus({ ok: false, text: errorText(e, 'Couldn’t save the changes. Try again.') });
      setSaving(false);
      return;
    }
    try {
      const models = await app.providers.refreshModels(existing.id);
      setStatus({ ok: true, text: `Saved. ${plural(models.length, 'model')} available.` });
    } catch (e) {
      setStatus({ ok: false, text: `Saved, but the model list didn’t load. ${errorText(e, 'Try Refresh below.')}` });
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="col gap-16">
      {notice && <Notice tone={notice.tone}>{notice.text}</Notice>}
      <div className="col gap-8">
        <Field label={kind.requiresKey ? 'API key' : 'API key (optional)'} hint="Encrypted on this device and synced end-to-end. Facet’s server can’t read it.">
          <SecretInput
            label={kind.requiresKey ? 'API key' : 'API key (optional)'}
            value={key}
            placeholder={kind.keyHint}
            onChange={(v) => {
              setKey(v.trim());
              setKeyChanged(true);
              edit();
            }}
          />
        </Field>
        {kind.keyUrl && (
          <button type="button" className="link-btn" onClick={() => platform().openExternal(kind.keyUrl!)}>
            {kind.requiresKey ? `Get an API key from ${kind.displayName}` : `About ${kind.displayName}`}
            <ExternalLink size={14} aria-hidden />
          </button>
        )}
      </div>
      <Field label="Name" hint="Useful when you add more than one key, e.g. Work or Personal.">
        <input
          className="input"
          value={label}
          onChange={(e) => {
            setLabel(e.target.value);
            edit();
          }}
          placeholder={kind.displayName}
        />
      </Field>

      <button type="button" className="disclosure" aria-expanded={advanced} onClick={() => setAdvanced((a) => !a)}>
        Advanced settings
        <ChevronDown size={16} aria-hidden />
      </button>
      {advanced && (
        <>
          <Field
            label="Base URL"
            hint={baseUrlHint(kind)}
            error={!urlOk && baseUrl.trim() !== initial.baseUrl.trim() ? 'Enter an address that starts with http:// or https://' : undefined}
          >
            <input
              className="input mono"
              value={baseUrl}
              onChange={(e) => {
                setBaseUrl(e.target.value.trim());
                edit();
              }}
              inputMode="url"
              autoCapitalize="off"
              autoComplete="off"
              spellCheck={false}
            />
          </Field>
          <Field label="Extra headers" hint="One per line. Sent with every request to this provider.">
            <textarea
              className="textarea mono"
              rows={3}
              value={headers}
              onChange={(e) => {
                setHeaders(e.target.value);
                edit();
              }}
              placeholder="Header-Name: value"
              spellCheck={false}
              style={{ minHeight: 0, fontSize: 13.5 }}
            />
          </Field>
        </>
      )}

      {status && <Notice tone={status.ok ? 'ok' : 'error'}>{status.text}</Notice>}

      <div className="form-actions">
        <Button onClick={save} busy={saving} disabled={!ready || !dirty || testing}>
          {existing ? 'Save changes' : 'Add provider'}
        </Button>
        <Button variant="tonal" onClick={test} busy={testing} disabled={!ready || saving}>
          Test connection
        </Button>
      </div>
    </div>
  );
}
