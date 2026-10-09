/** Web search on the Tools page: the bring-your-own-key backend (one at a time) and native search. */
import { ExternalLink, Globe, Search, Sparkles, Trash2 } from 'lucide-react';
import { useEffect, useState } from 'react';
import { getApp } from '../../app';
import type { ProviderEntity } from '../../data/entities';
import { platform } from '../../platform';
import { SEARCH_KINDS, isSearchKind, searchKind, type SearchKind } from '../../tools/types';
import { Button, Confirm, Dialog, Divider, Field, Group, Row, SwitchRow, useToast } from '../components/primitives';
import { useProviders, useSyncedPrefs } from '../hooks';
import { ui } from '../nav';
import { ToolsSecretInput, ToolsStatus, ToolsSubhead, errorText, plural, useStableCallback } from './ToolsShared';

/** "Tavily, Jina Search or SearXNG" */
function nameList(kinds: readonly SearchKind[], conjunction: 'or' | 'and' = 'or'): string {
  const names = kinds.map((k) => k.displayName);
  return names.length > 1 ? `${names.slice(0, -1).join(', ')} ${conjunction} ${names[names.length - 1]}` : names.join('');
}

const blockedHere = (k: SearchKind) => platform().corsLimited && !k.browserOk;
const browserKinds = () => SEARCH_KINDS.filter((k) => k.browserOk);
const blockedKinds = () => SEARCH_KINDS.filter((k) => !k.browserOk);

function validUrl(url: string): boolean {
  try {
    const u = new URL(url.trim());
    return (u.protocol === 'https:' || u.protocol === 'http:') && u.hostname.length > 0;
  } catch {
    return false;
  }
}

function useSearchService(): { provider: ProviderEntity; kind: SearchKind } | null | undefined {
  const providers = useProviders();
  if (!providers) return undefined;
  for (const p of providers) {
    const kind = isSearchKind(p.kind) ? searchKind(p.kind) : undefined;
    if (kind) return { provider: p, kind };
  }
  return null;
}

function PreferNativeRow() {
  const synced = useSyncedPrefs();
  return (
    <SwitchRow
      icon={<Sparkles size={20} />}
      title="Prefer the model's own search"
      subtitle="When a model can search on its own, let it. Turn off to always use your search service."
      checked={synced.preferNativeSearch}
      onChange={(v) => void getApp().settings.updateSynced((s) => ({ ...s, preferNativeSearch: v }))}
    />
  );
}

/** The web search group on the Tools overview. */
export function SearchOverviewGroup() {
  const current = useSearchService();
  const subtitle =
    current === undefined ? ' '
      : !current ? 'Not set up. Models without their own search can’t search the web.'
        : blockedHere(current.kind) ? `${current.kind.displayName} · Works in the Windows and Android apps only`
          : `${current.kind.displayName} · ${current.provider.enabled ? 'Ready' : 'Off'}`;
  return (
    <Group
      title="Web search"
      footer="Claude, GPT and Gemini models can search on their own. Every other model searches with the service you set up here."
    >
      <Row icon={<Globe size={20} />} title="Search service" subtitle={subtitle} onClick={() => ui.openSettings('tools', 'search')} />
      <Divider />
      <PreferNativeRow />
    </Group>
  );
}

/** Settings → Tools → Web search. */
export function WebSearchPage() {
  const app = getApp();
  const toast = useToast();
  const current = useSearchService();
  const [editing, setEditing] = useState<SearchKind | null>(null);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const closeEditor = useStableCallback(() => setEditing(null));
  const closeConfirm = useStableCallback(() => setConfirmRemove(false));
  const web = platform().corsLimited;
  const blocked = blockedKinds();

  return (
    <div className="col gap-16 tools-page">
      <ToolsSubhead
        title="Web search"
        subtitle={
          'Claude, GPT and Gemini models can search on their own. For every other model, add a search key here and Facet gives the model ' +
          `a search tool and a page reader. Searches go straight from ${web ? 'your browser' : 'this computer'} to the service you pick.`
        }
      />

      {web && blocked.length > 0 && (
        <ToolsStatus tone="info">
          {blocked.length === 1
            ? `${nameList(blocked)} doesn’t accept requests from web browsers, so it can’t search on the website. It works in the Windows and Android apps, and a key you save here syncs to them.`
            : `${nameList(blocked, 'and')} don’t accept requests from web browsers, so they can’t search on the website. They work in the Windows and Android apps, and a key you save here syncs to them.`}
        </ToolsStatus>
      )}

      {current && (
        <section>
          <Group title="In use">
            <Row
              icon={<Globe size={20} />}
              title={current.kind.displayName}
              subtitle={blockedHere(current.kind) ? 'Works in the Windows and Android apps only' : current.provider.enabled ? 'Ready' : 'Off'}
              onClick={() => setEditing(current.kind)}
            />
            <Divider />
            <Row icon={<Trash2 size={20} />} title="Remove" danger chevron={false} onClick={() => setConfirmRemove(true)} />
          </Group>
          {blockedHere(current.kind) && (
            <div style={{ marginTop: 12 }}>
              <ToolsStatus tone="warning">
                Models can’t search with {current.kind.displayName} on the website. To search here, switch to {nameList(browserKinds())}.
              </ToolsStatus>
            </div>
          )}
        </section>
      )}

      {current !== undefined && (
        <Group title={current ? 'Switch service' : 'Choose a search service'}>
          {SEARCH_KINDS.filter((k) => k.id !== current?.kind.id).map((k, i) => (
            <div key={k.id}>
              {i > 0 && <Divider />}
              <Row
                icon={<Search size={20} />}
                title={k.displayName}
                subtitle={k.blurb}
                onClick={() => setEditing(k)}
                trailing={blockedHere(k) ? <span className="badge">Windows and Android only</span> : undefined}
                chevron={blockedHere(k) ? true : undefined}
              />
            </div>
          ))}
        </Group>
      )}

      <div className="group">
        <PreferNativeRow />
      </div>

      {editing && (
        <SearchSetupDialog kind={editing} existing={current && current.kind.id === editing.id ? current.provider : null} onClose={closeEditor} />
      )}
      {confirmRemove && current && (
        <Confirm
          title="Remove web search?"
          body="Models without built-in search won’t be able to search the web."
          confirm="Remove"
          danger
          onConfirm={async () => {
            await app.providers.delete(current.provider.id);
            toast('Web search removed.');
          }}
          onClose={closeConfirm}
        />
      )}
    </div>
  );
}

function SearchSetupDialog({ kind, existing, onClose }: { kind: SearchKind; existing: ProviderEntity | null; onClose: () => void }) {
  const app = getApp();
  const toast = useToast();
  const [key, setKey] = useState('');
  const [loaded, setLoaded] = useState(!existing);
  const [url, setUrl] = useState(existing?.baseUrl || kind.defaultUrl);
  const [busy, setBusy] = useState<'test' | 'save' | null>(null);
  const [status, setStatus] = useState<{ ok: boolean; text: string } | null>(null);
  const isSearx = kind.id === 'search.searxng';

  useEffect(() => {
    if (!existing) return;
    let live = true;
    void app.providers.apiKey(existing).then((k) => {
      if (!live) return;
      setKey(k);
      setLoaded(true);
    });
    return () => {
      live = false;
    };
  }, [existing?.id]);

  const valid = loaded && (!kind.needsKey || key.trim() !== '') && validUrl(url);

  const test = async () => {
    setBusy('test');
    setStatus(null);
    try {
      const results = await app.search.search({ kind, apiKey: key.trim(), baseUrl: url.trim() }, 'weather in Lisbon', 3);
      setStatus({ ok: true, text: `Working. Found ${plural(results.length, 'result')}.` });
    } catch (e) {
      setStatus({ ok: false, text: errorText(e, `${kind.displayName} didn’t answer. Check the key and try again.`) });
    } finally {
      setBusy(null);
    }
  };

  const save = async () => {
    setBusy('save');
    try {
      // One search service at a time, as on Android.
      for (const p of await app.providers.all()) {
        if (isSearchKind(p.kind) && p.id !== existing?.id) await app.providers.delete(p.id);
      }
      if (existing) {
        await app.providers.update(existing.id, { label: kind.displayName, baseUrl: url.trim(), apiKey: key.trim(), headers: {}, enabled: true });
      } else {
        await app.providers.addService(kind.id, kind.displayName, url.trim(), key.trim());
      }
      toast(`Web search uses ${kind.displayName}.`);
      onClose();
    } catch (e) {
      setStatus({ ok: false, text: errorText(e, 'Couldn’t save. Try again.') });
      setBusy(null);
    }
  };

  return (
    <Dialog
      title={kind.displayName}
      onClose={onClose}
      footer={
        <>
          <Button variant="text" onClick={onClose}>Cancel</Button>
          <Button variant="tonal" busy={busy === 'test'} disabled={!valid || busy != null || blockedHere(kind)} onClick={test}>Test</Button>
          <Button busy={busy === 'save'} disabled={!valid || busy != null} onClick={save}>Save</Button>
        </>
      }
    >
      <div className="col gap-16">
        <p className="t-body c-2" style={{ margin: 0 }}>{kind.blurb}</p>
        {blockedHere(kind) && (
          <ToolsStatus tone="warning">
            {kind.displayName} doesn’t accept requests from web browsers, so it can’t search on the website. Save it here to use it in the
            Windows and Android apps.
          </ToolsStatus>
        )}
        {kind.needsKey && (
          <div className="col gap-6">
            <Field label="API key">
              <ToolsSecretInput value={key} onChange={(v) => { setKey(v.trim()); setStatus(null); }} label="API key" onEnter={() => valid && !busy && void save()} />
            </Field>
            {kind.keyUrl && (
              <span>
                <Button variant="text" small onClick={() => platform().openExternal(kind.keyUrl!)}>
                  Get a key from {kind.displayName} <ExternalLink size={14} />
                </Button>
              </span>
            )}
          </div>
        )}
        {isSearx && (
          <div className="col gap-6">
            <Field
              label="Instance URL"
              hint="Your SearXNG instance, with the JSON format enabled in settings.yml."
              error={url.trim().length > 8 && !validUrl(url) ? 'Enter an address that starts with https://' : undefined}
            >
              <input
                className="input mono"
                value={url}
                inputMode="url"
                spellCheck={false}
                placeholder="https://search.example.com"
                onChange={(e) => { setUrl(e.target.value.trim()); setStatus(null); }}
              />
            </Field>
            {kind.keyUrl && (
              <span>
                <Button variant="text" small onClick={() => platform().openExternal(kind.keyUrl!)}>
                  SearXNG documentation <ExternalLink size={14} />
                </Button>
              </span>
            )}
          </div>
        )}
        {status && <ToolsStatus tone={status.ok ? 'ok' : 'error'}>{status.text}</ToolsStatus>}
        <p className="field-hint" style={{ margin: 0 }}>
          The key is encrypted on this device and syncs end-to-end encrypted. Only one search service is used at a time.
        </p>
      </div>
    </Dialog>
  );
}
