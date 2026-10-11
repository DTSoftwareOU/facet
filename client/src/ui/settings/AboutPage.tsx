import { Code2, Download, ExternalLink, FileText, Globe, RefreshCw, Scale, ScrollText } from 'lucide-react';
import { useEffect, useState } from 'react';
import { platform, type UpdateState } from '../../platform';
import { Gem } from '../components/Gem';
import { Button, Dialog, Divider, Group, Row } from '../components/primitives';
import type { PageProps } from './SettingsDialog';

const SITE = 'https://facet.dtsoftware.io';
const SOURCE = 'https://github.com/DTSoftwareOU/facet';

const LICENSES: [string, string][] = [
  ['React', 'MIT'], ['Dexie.js', 'Apache-2.0'], ['markdown-it', 'MIT'], ['highlight.js', 'BSD-3-Clause'], ['KaTeX', 'MIT'],
  ['Lucide icons', 'ISC'], ['fflate', 'MIT'], ['Instrument Sans and Instrument Serif', 'SIL OFL 1.1'], ['JetBrains Mono', 'SIL OFL 1.1'],
];
const DESKTOP_LICENSES: [string, string][] = [['Electron', 'MIT'], ['electron-updater', 'MIT']];

function Updates() {
  const updates = platform().updates;
  const [state, setState] = useState<UpdateState | null>(null);
  useEffect(() => {
    if (!updates) return;
    void updates.state().then(setState);
    return updates.onState(setState);
  }, []);
  if (!updates) return null;
  const s = state?.status ?? 'idle';
  const subtitle =
    s === 'checking' ? 'Checking for updates…'
      : s === 'available' || s === 'downloading' ? `Downloading ${state?.version ?? 'an update'}${state?.progress != null ? ` · ${Math.round(state.progress)}%` : ''}`
        : s === 'ready' ? `Version ${state?.version ?? ''} is ready. Restart to finish updating.`
          : s === 'error' ? state?.message ?? 'Couldn’t check for updates.'
            : 'Facet updates itself in the background.';
  return (
    <>
      <Divider />
      <Row
        icon={s === 'ready' ? <Download size={20} /> : <RefreshCw size={20} />}
        title={s === 'ready' ? 'Restart to update' : 'Check for updates'}
        subtitle={subtitle}
        onClick={() => (s === 'ready' ? void updates.install() : void updates.check())}
        disabled={s === 'checking' || s === 'downloading'}
      />
    </>
  );
}

export function AboutPage(_props: PageProps) {
  const p = platform();
  const [licenses, setLicenses] = useState(false);
  const open = (path: string) => p.openExternal(SITE + path);
  return (
    <div className="col gap-16">
      <div className="col" style={{ alignItems: 'center', gap: 10, padding: '18px 0 6px', textAlign: 'center' }}>
        <Gem size={56} />
        <span className="t-headline">Facet</span>
        <span className="t-label-m c-2">
          Version {p.version} · {p.kind === 'desktop' ? 'Windows app' : 'Web'}
        </span>
        <span className="t-body c-2" style={{ maxWidth: 420 }}>Every model. One home. Open source and end-to-end encrypted, made by DT Software OÜ.</span>
        <span className="t-label-s c-3" style={{ maxWidth: 420, fontWeight: 400 }}>
          Facet is independent and isn’t affiliated with or endorsed by any AI provider. Product and model names are trademarks of their owners.
        </span>
      </div>
      <Group>
        <Row icon={<Globe size={20} />} title="Website" subtitle="facet.dtsoftware.io" onClick={() => open('/')} trailing={<ExternalLink size={16} className="c-3" />} />
        <Divider />
        <Row icon={<Download size={20} />} title="Get Facet for Android and Windows" onClick={() => open('/#download')} trailing={<ExternalLink size={16} className="c-3" />} />
        <Updates />
      </Group>
      <Group>
        <Row icon={<FileText size={20} />} title="Privacy policy" onClick={() => open('/privacy')} trailing={<ExternalLink size={16} className="c-3" />} />
        <Divider />
        <Row icon={<Scale size={20} />} title="Terms of service" onClick={() => open('/terms')} trailing={<ExternalLink size={16} className="c-3" />} />
        <Divider />
        <Row icon={<Code2 size={20} />} title="Source code" subtitle="github.com/DTSoftwareOU/facet" onClick={() => p.openExternal(SOURCE)} trailing={<ExternalLink size={16} className="c-3" />} />
        <Divider />
        <Row icon={<ScrollText size={20} />} title="Open-source licenses" subtitle="Facet is licensed under Apache 2.0" onClick={() => setLicenses(true)} />
      </Group>
      {licenses && (
        <Dialog title="Open-source licenses" onClose={() => setLicenses(false)} footer={<Button onClick={() => setLicenses(false)}>Done</Button>}>
          <div className="kv" style={{ gridTemplateColumns: '1fr auto' }}>
            {[...LICENSES, ...(p.kind === 'desktop' ? DESKTOP_LICENSES : [])].map(([name, license]) => (
              <div key={name} style={{ display: 'contents' }}>
                <dt style={{ color: 'var(--text)' }}>{name}</dt>
                <dd className="c-2">{license}</dd>
              </div>
            ))}
          </div>
        </Dialog>
      )}
    </div>
  );
}
