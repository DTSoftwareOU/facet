import { useLiveQuery } from 'dexie-react-hooks';
import { CloudOff, Download, File as FileIcon, FileText, Film, HardDrive, Image as ImageIcon, Music, Trash2 } from 'lucide-react';
import { useEffect, useState } from 'react';
import { getApp } from '../../app';
import { Dates, Format } from '../../core/format';
import { toJson } from '../../core/json';
import { db } from '../../data/db';
import type { AttachmentEntity } from '../../data/entities';
import { platform } from '../../platform';
import { Button, Confirm, Divider, Group, Row, SwitchRow, useToast } from '../components/primitives';
import { useAccount, useAutoFreed, useSyncState, useSyncedPrefs } from '../hooks';
import type { PageProps } from './SettingsDialog';

function kindIcon(a: AttachmentEntity) {
  switch (a.kind) {
    case 'image':
      return <ImageIcon size={20} />;
    case 'video':
      return <Film size={20} />;
    case 'audio':
      return <Music size={20} />;
    case 'pdf':
      return <FileText size={20} />;
    default:
      return <FileIcon size={20} />;
  }
}

function UsageBar({ records, blobs, quota }: { records: number; blobs: number; quota: number }) {
  const total = Math.max(quota, 1);
  const r = Math.min(1, records / total);
  const b = Math.min(1 - r, blobs / total);
  return (
    <div className="storage-bar" aria-hidden>
      {r > 0 && <span style={{ width: `${r * 100}%`, background: 'var(--primary)' }} />}
      {b > 0 && <span style={{ width: `${b * 100}%`, background: 'var(--flash)' }} />}
    </div>
  );
}

/** Everything in this device's database as one JSON file (API keys excluded). */
async function exportEverything(): Promise<Blob> {
  const d = db();
  const [conversations, messages, assistants, folders, prompts, skills] = await Promise.all([
    d.conversations.filter((x) => x.deleted === 0).toArray(),
    d.messages.filter((x) => x.deleted === 0).toArray(),
    d.assistants.filter((x) => x.deleted === 0).toArray(),
    d.folders.filter((x) => x.deleted === 0).toArray(),
    d.prompts.filter((x) => x.deleted === 0).toArray(),
    d.skills.filter((x) => x.deleted === 0).toArray(),
  ]);
  const clean = (rows: object[]) => rows.map((r) => JSON.parse(toJson({ ...r, dirty: undefined, deleted: undefined, workspace: undefined })));
  const body = {
    app: 'Facet',
    exportedAt: new Date().toISOString(),
    conversations: clean(conversations),
    messages: clean(messages),
    assistants: clean(assistants),
    folders: clean(folders),
    prompts: clean(prompts),
    skills: clean(skills),
    settings: getApp().settings.synced,
  };
  return new Blob([JSON.stringify(body, null, 2)], { type: 'application/json' });
}

export function DataPage(_props: PageProps) {
  const app = getApp();
  const toast = useToast();
  const account = useAccount();
  const sync = useSyncState();
  const synced = useSyncedPrefs();
  const autoFreed = useAutoFreed();
  const [deviceBytes, setDeviceBytes] = useState<number | null>(null);
  const [refresh, setRefresh] = useState(0);
  const [confirmWipe, setConfirmWipe] = useState(false);
  const largest = useLiveQuery(async () => {
    const all = await db().attachments.filter((a) => a.deleted === 0 && !!a.conversationId).toArray();
    return all.sort((a, b) => b.sizeBytes - a.sizeBytes).slice(0, 8);
  }, []) ?? [];
  const deviceOnly = useLiveQuery(() => db().attachments.filter((a) => a.deleted === 0 && a.localOnly).count(), []) ?? 0;
  const signedIn = account.kind === 'signedIn' ? account : null;

  useEffect(() => {
    void app.auth.refreshAccount().catch(() => {});
  }, []);
  useEffect(() => {
    void navigator.storage?.estimate?.().then((e) => setDeviceBytes(e.usage ?? null), () => setDeviceBytes(null));
  }, [refresh]);

  const full = !!signedIn && (sync.storageFull || (signedIn.quotaBytes > 0 && signedIn.usedBytes >= signedIn.quotaBytes));

  return (
    <div className="col gap-16">
      {signedIn && (
        <Group title="Sync storage">
          <div className="col gap-12" style={{ padding: 16 }}>
            <div className="row" style={{ alignItems: 'baseline', gap: 6 }}>
              <span className="t-title-l">{Format.bytes(signedIn.usedBytes)}</span>
              <span className="t-label-m c-2 grow" style={{ fontWeight: 400 }}>of {Format.bytes(signedIn.quotaBytes)}</span>
              {signedIn.quotaBytes > 0 && (
                <span className={'t-label-m ' + (full ? 'c-warning' : 'c-2')}>{Math.min(100, Math.round((signedIn.usedBytes * 100) / signedIn.quotaBytes))}%</span>
              )}
            </div>
            <UsageBar records={signedIn.recordBytes} blobs={signedIn.blobBytes} quota={signedIn.quotaBytes} />
            <div className="row gap-16 t-label-s c-2" style={{ fontWeight: 400 }}>
              <span><span className="legend-dot" style={{ background: 'var(--primary)' }} />Chats & settings · {Format.bytes(signedIn.recordBytes)}</span>
              <span><span className="legend-dot" style={{ background: 'var(--flash)' }} />Files · {Format.bytes(signedIn.blobBytes)}</span>
            </div>
            <span className={'t-label-s ' + (full ? 'c-warning' : 'c-3')} style={{ fontWeight: 400 }}>
              {!full
                ? 'Everything here is end-to-end encrypted. Chats are compressed before upload; files sync until the space is used.'
                : synced.autoFreeSpace
                  ? 'Storage is full and this device has no older files left to clear. New changes wait here until you free up space below or delete old chats.'
                  : 'Storage is full. New changes and files wait on this device until you free up space below or delete old chats.'}
            </span>
          </div>
          <Divider full />
          <SwitchRow
            icon={<CloudOff size={20} />}
            title="Free up space automatically"
            subtitle="When storage is full, the oldest files leave sync storage. They stay on the devices that have them."
            checked={synced.autoFreeSpace}
            onChange={(v) => app.settings.updateSynced((s) => ({ ...s, autoFreeSpace: v }))}
          />
          {autoFreed && (
            <p className="t-label-s c-3" style={{ margin: '0 16px 14px', fontWeight: 400 }}>
              Last clean-up, {Dates.relative(autoFreed.at).replace('Just now', 'just now')}: cleared {autoFreed.files === 1 ? '1 old file' : `${autoFreed.files} old files`} ({Format.bytes(autoFreed.bytes)}) from sync storage.
            </p>
          )}
        </Group>
      )}

      <Group title="On this device">
        <Row icon={<HardDrive size={20} />} title={platform().kind === 'web' ? 'Used by Facet in this browser' : 'Used on this computer'} subtitle={deviceBytes != null ? Format.bytes(deviceBytes) : 'Calculating…'} />
        {signedIn && (
          <>
            <Divider />
            <Row
              icon={<Download size={20} />}
              title="Remove downloaded copies"
              subtitle="Files already in your sync storage download again when you open them."
              onClick={async () => {
                const freed = await app.sync.clearDownloadedCopies();
                toast(freed > 0 ? `Freed ${Format.bytes(freed)} on this device.` : 'Nothing to remove.');
                setRefresh((x) => x + 1);
              }}
            />
          </>
        )}
        {deviceOnly > 0 && (
          <>
            <Divider />
            <Row
              icon={<CloudOff size={20} />}
              title={deviceOnly === 1 ? '1 file is only on this device' : `${deviceOnly} files are only on this device`}
              subtitle={`Cleared from sync storage to make room. Upload ${deviceOnly === 1 ? 'it' : 'them'} again if there's space.`}
              onClick={async () => {
                await app.sync.retryDeviceOnlyFiles();
                toast('Trying again. Files upload while there’s space.');
              }}
            />
          </>
        )}
      </Group>

      {largest.length > 0 && (
        <Group title="Largest files">
          {largest.map((f, i) => (
            <div key={f.id}>
              {i > 0 && <Divider />}
              <Row
                icon={kindIcon(f)}
                title={<span className="ellipsis" style={{ display: 'block' }}>{f.name}</span>}
                subtitle={`${Format.bytes(f.sizeBytes)} · ${f.localOnly ? 'This device only' : f.uploaded ? 'Synced' : 'Waiting to sync'}`}
                trailing={
                  signedIn && f.uploaded && !f.localOnly ? (
                    <Button
                      variant="tonal"
                      small
                      onClick={async () => {
                        try {
                          await app.sync.keepOnDeviceOnly(f.id);
                          toast(`${f.name} is now kept on this device only.`);
                        } catch {
                          toast('Couldn’t free that file. Check your connection.');
                        }
                      }}
                    >
                      Free up
                    </Button>
                  ) : undefined
                }
              />
            </div>
          ))}
        </Group>
      )}

      <Group title="Your data">
        <Row
          icon={<Download size={20} />}
          title="Export everything"
          subtitle="Chats, assistants, prompts, skills and settings as JSON. API keys are left out."
          onClick={async () => platform().saveFile(`facet-export-${Dates.isoDate(Date.now())}.json`, await exportEverything())}
        />
        <Divider />
        <Row
          icon={<Trash2 size={20} />}
          title={signedIn ? 'Remove data from this device' : 'Delete all data'}
          subtitle={signedIn ? 'Signs out and clears chats, keys and files here. Your account keeps its copy.' : 'Chats, keys and files on this device are deleted for good.'}
          danger
          onClick={() => setConfirmWipe(true)}
        />
      </Group>
      {confirmWipe && (
        <Confirm
          title={signedIn ? 'Remove data from this device?' : 'Delete all data?'}
          body={signedIn ? 'You’ll be signed out here. Sign in again to get everything back.' : 'This can’t be undone.'}
          confirm={signedIn ? 'Sign out and remove' : 'Delete everything'}
          danger
          onConfirm={async () => {
            if (signedIn) await app.auth.logout();
            await app.sync.wipeLocalData();
            await db().transaction('rw', db().providers, async () => db().providers.clear());
            toast('Data removed from this device.');
          }}
          onClose={() => setConfirmWipe(false)}
        />
      )}
    </div>
  );
}
