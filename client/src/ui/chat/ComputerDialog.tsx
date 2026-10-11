/**
 * Choose the PC and folder a chat works in (docs/REMOTE.md): the account's online PCs, then a
 * folder browser on the chosen one. The Windows app also offers itself ("This PC").
 */
import { ArrowLeft, ChevronRight, Folder, HardDrive, Monitor, MonitorOff } from 'lucide-react';
import { useEffect, useState } from 'react';
import { getApp } from '../../app';
import type { ComputerBinding } from '../../data/entities';
import { formatList, t } from '../../i18n';
import type { FolderEntry, FolderListing } from '../../platform/platform';
import type { ChatComputer } from '../../remote/computers';
import { Button, Dialog, Divider, Group, IconButton, Row, Spinner } from '../components/primitives';
import { useHosts } from '../hooks';

export function folderName(path: string): string {
  const parts = path.replace(/[\\/]+$/, '').split(/[\\/]/);
  return parts[parts.length - 1] || path;
}

/** The PCs a chat can use: online hosts with remote use on (and this PC in the Windows app). */
async function computerFor(hostId: string): Promise<ChatComputer | null> {
  const app = getApp();
  if (hostId === app.computers.hostId) {
    const s = await app.computers.resolve({ computerHost: hostId, computerFolder: null, workspace: null });
    return s.kind === 'ready' ? s.computer : null;
  }
  return app.computers.remote(hostId);
}

export function ComputerDialog({ binding, onPick, onClose }: {
  binding: ComputerBinding | null;
  onPick: (binding: ComputerBinding | null) => void;
  onClose: () => void;
}) {
  const app = getApp();
  const hosts = useHosts().filter((h) => h.hostId !== app.computers.hostId);
  const [browsing, setBrowsing] = useState<{ hostId: string; name: string } | null>(null);
  const me = app.computers.hostId;

  if (browsing) {
    return (
      <FolderBrowser
        hostId={browsing.hostId}
        name={browsing.name}
        start={binding?.host === browsing.hostId ? binding.folder : null}
        onBack={() => setBrowsing(null)}
        onPick={(folder) => {
          onPick({ host: browsing.hostId, folder });
          onClose();
        }}
        onClose={onClose}
      />
    );
  }

  const disabled = hosts.filter((h) => !h.remote);
  return (
    <Dialog
      title={t('Work on a PC')}
      onClose={onClose}
      size="narrow"
      footer={
        <>
          {binding && (
            <Button variant="text" onClick={() => { onPick(null); onClose(); }}>
              {t('Don’t use a PC')}
            </Button>
          )}
          <span className="grow" />
          <Button variant="tonal" onClick={onClose}>{t('Close')}</Button>
        </>
      }
    >
      <p className="t-body c-2" style={{ margin: '0 0 14px' }}>
        {t('Models can run commands and read and edit files in a folder on the PC. Facet on the PC runs them; you approve changes here.')}
      </p>
      <Group footer={disabled.length > 0 ? t('To use {pcs}, open Facet on it and turn on “Let your other devices use this PC” in Settings → Computer access.', { pcs: formatList(disabled.map((h) => h.name)) }) : undefined}>
        {me && (
          <>
            <Row icon={<Monitor size={20} />} title={t('This PC')} subtitle={binding?.host === me ? <bdi dir="ltr">{binding.folder}</bdi> : t('Choose a folder')} onClick={() => setBrowsing({ hostId: me, name: t('This PC') })} />
            {hosts.length > 0 && <Divider />}
          </>
        )}
        {hosts.map((h, i) => (
          <div key={h.hostId}>
            {i > 0 && <Divider />}
            <Row
              icon={h.remote ? <Monitor size={20} /> : <MonitorOff size={20} />}
              title={<bdi>{h.name}</bdi>}
              subtitle={!h.remote ? t('Remote use is off on this PC') : binding?.host === h.hostId ? <bdi dir="ltr">{binding.folder}</bdi> : t('{os} · online', { os: h.os || 'Windows' })}
              onClick={h.remote ? () => setBrowsing({ hostId: h.hostId, name: h.name }) : undefined}
              disabled={!h.remote}
            />
          </div>
        ))}
        {!me && hosts.length === 0 && (
          <Row icon={<MonitorOff size={20} />} title={t('No PC is online')} subtitle={t('Open Facet on your Windows PC and sign in with this account.')} />
        )}
      </Group>
    </Dialog>
  );
}

function FolderBrowser({ hostId, name, start, onBack, onPick, onClose }: {
  hostId: string;
  name: string;
  start: string | null;
  onBack: () => void;
  onPick: (folder: string) => void;
  onClose: () => void;
}) {
  const [path, setPath] = useState<string | null>(start);
  const [listing, setListing] = useState<FolderListing | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let live = true;
    setLoading(true);
    setError(null);
    void (async () => {
      try {
        const computer = await computerFor(hostId);
        if (!computer) throw new Error(t('{pc} isn’t available right now.', { pc: name }));
        const l = await computer.listFolders(path);
        if (live) setListing(l);
      } catch (e) {
        if (!live) return;
        setError((e as Error).message || t('Couldn’t open that folder.'));
        // A remembered folder that's gone: start from the top instead.
        if (path && path === start) setPath(null);
      } finally {
        if (live) setLoading(false);
      }
    })();
    return () => {
      live = false;
    };
  }, [hostId, path]);

  const entries: FolderEntry[] = path === null ? listing?.places ?? [] : listing?.folders ?? [];
  const up = () => setPath(listing?.parent ?? null);

  return (
    <Dialog
      title={name}
      onClose={onClose}
      size="narrow"
      footer={
        <>
          <Button variant="text" onClick={onBack}>{t('All PCs')}</Button>
          <span className="grow" />
          <Button disabled={!path || loading || !!error} onClick={() => path && onPick(path)}>{t('Use this folder')}</Button>
        </>
      }
    >
      <div className="folder-path">
        <IconButton label={path ? t('Up one folder') : t('Back')} small disabled={loading} onClick={() => (path ? up() : onBack())}>
          <ArrowLeft size={18} className="flip-rtl" />
        </IconButton>
        <span className="ellipsis t-label-l" title={path ?? undefined}>{path ? <bdi dir="ltr">{path}</bdi> : t('Places')}</span>
        {loading && <Spinner size={16} />}
      </div>
      {error ? (
        <p className="field-error" role="alert" style={{ margin: '12px 4px' }}>{error}</p>
      ) : (
        <div className="folder-list" role="list" aria-busy={loading}>
          {!loading && entries.length === 0 && <p className="t-body c-3" style={{ margin: '16px 4px' }}>{path ? t('No folders here.') : t('Nothing to show.')}</p>}
          {entries.map((f) => (
            <button key={f.path} type="button" role="listitem" className="folder-item" onClick={() => setPath(f.path)} title={f.path}>
              {/^[a-zA-Z]:\\?$/.test(f.path) ? <HardDrive size={18} /> : <Folder size={18} />}
              <span className="ellipsis grow"><bdi>{f.name}</bdi></span>
              <ChevronRight size={16} className="c-3 flip-rtl" />
            </button>
          ))}
        </div>
      )}
    </Dialog>
  );
}
