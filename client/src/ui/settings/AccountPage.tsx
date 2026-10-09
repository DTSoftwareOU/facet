import { Cloud, KeyRound, Laptop, Lock, LogOut, Monitor, RefreshCw, Server, Smartphone, Trash2, User } from 'lucide-react';
import { useEffect, useState } from 'react';
import { getApp } from '../../app';
import { Dates } from '../../core/format';
import { platform } from '../../platform';
import type { SessionDto } from '../../sync/api';
import { AuthDialog, RecoveryCodeView, passwordHint, passwordOk } from '../auth/AuthDialog';
import { Button, Dialog, Divider, Field, Group, Row, Spinner, TextPrompt, useToast } from '../components/primitives';
import { useAccount, useSyncState, useSyncedPrefs } from '../hooks';
import { ui } from '../nav';
import type { PageProps } from './SettingsDialog';

function PasswordConfirm({ title, body, action, danger, onConfirm, onClose }: {
  title: string;
  body: string;
  action: string;
  danger?: boolean;
  onConfirm: (password: string) => Promise<void>;
  onClose: () => void;
}) {
  const [pw, setPw] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const submit = async () => {
    if (!pw) return;
    setBusy(true);
    setError(null);
    try {
      await onConfirm(pw);
    } catch (e) {
      setError((e as Error).message || 'That didn’t work.');
      setBusy(false);
    }
  };
  return (
    <Dialog
      title={title}
      onClose={onClose}
      size="narrow"
      footer={
        <>
          <Button variant="text" onClick={onClose}>Cancel</Button>
          <Button variant={danger ? 'danger' : 'primary'} busy={busy} disabled={!pw} onClick={submit}>{action}</Button>
        </>
      }
    >
      <div className="col gap-12">
        <p className="t-body c-2" style={{ margin: 0 }}>{body}</p>
        <Field label="Password" error={error ?? undefined}>
          <input className="input" type="password" value={pw} onChange={(e) => setPw(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && submit()} autoComplete="current-password" />
        </Field>
      </div>
    </Dialog>
  );
}

function ChangePassword({ onClose }: { onClose: () => void }) {
  const app = getApp();
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const ok = current && passwordOk(next) && next === confirm;
  return (
    <Dialog
      title="Change password"
      onClose={onClose}
      size="narrow"
      footer={done ? <Button onClick={onClose}>Done</Button> : (
        <>
          <Button variant="text" onClick={onClose}>Cancel</Button>
          <Button
            busy={busy}
            disabled={!ok}
            onClick={async () => {
              setBusy(true);
              setError(null);
              try {
                await app.auth.changePassword(current, next);
                setDone(true);
              } catch (e) {
                setError((e as Error).message);
              } finally {
                setBusy(false);
              }
            }}
          >
            Change password
          </Button>
        </>
      )}
    >
      {done ? (
        <p className="t-body c-2">Password changed. Other devices were signed out and will ask for the new password.</p>
      ) : (
        <div className="col gap-12">
          <Field label="Current password">
            <input className="input" type="password" value={current} onChange={(e) => setCurrent(e.target.value)} autoComplete="current-password" />
          </Field>
          <Field label="New password" hint={passwordHint(next)}>
            <input className="input" type="password" value={next} onChange={(e) => setNext(e.target.value)} autoComplete="new-password" />
          </Field>
          <Field label="Confirm new password" error={confirm && confirm !== next ? 'Passwords don’t match.' : undefined}>
            <input className="input" type="password" value={confirm} onChange={(e) => setConfirm(e.target.value)} autoComplete="new-password" />
          </Field>
          {error && <span className="field-error">{error}</span>}
        </div>
      )}
    </Dialog>
  );
}

function SignOut({ onClose }: { onClose: () => void }) {
  const app = getApp();
  const [busy, setBusy] = useState<'keep' | 'remove' | null>(null);
  const out = async (remove: boolean) => {
    setBusy(remove ? 'remove' : 'keep');
    await app.auth.logout();
    if (remove) await app.sync.wipeLocalData();
    onClose();
  };
  return (
    <Dialog title="Sign out?" onClose={onClose} size="narrow">
      <div className="col gap-12">
        <p className="t-body c-2" style={{ margin: 0 }}>Your data stays safe in your account. Choose whether to keep a copy on this device.</p>
        <Button block variant="danger" busy={busy === 'remove'} disabled={!!busy} onClick={() => out(true)}>Sign out and remove data from this device</Button>
        <Button block variant="tonal" busy={busy === 'keep'} disabled={!!busy} onClick={() => out(false)}>Sign out and keep data here</Button>
      </div>
    </Dialog>
  );
}

function platformIcon(s: SessionDto) {
  if (s.platform === 'android') return <Smartphone size={20} />;
  if (s.platform === 'web') return <Laptop size={20} />;
  return <Monitor size={20} />;
}

function Devices() {
  const app = getApp();
  const toast = useToast();
  const [list, setList] = useState<SessionDto[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = () => {
    app.auth.sessions().then((s) => { setList(s); setError(null); }, (e) => setError((e as Error).message || 'Couldn’t load devices.'));
  };
  useEffect(load, []);
  return (
    <Group title="Signed-in devices">
      {error && <Row icon={<Cloud size={20} />} title="Couldn’t load devices" subtitle={error} />}
      {!list && !error && <div className="srow"><Spinner /></div>}
      {list?.map((s, i) => (
        <div key={s.id}>
          {i > 0 && <Divider />}
          <Row
            icon={platformIcon(s)}
            title={(s.deviceName || 'Unknown device') + (s.current ? ' (this device)' : '')}
            subtitle={`Active ${Dates.relative(s.lastSeenAt).toLowerCase()}${s.ip ? ' · ' + s.ip : ''}`}
            trailing={!s.current ? <Button variant="text" small onClick={async () => { await app.auth.revokeSession(s.id).catch((e) => toast((e as Error).message)); load(); }}>Sign out</Button> : undefined}
          />
        </div>
      ))}
      {list && list.length > 1 && (
        <>
          <Divider full />
          <Row icon={<LogOut size={20} />} title="Sign out of all other devices" onClick={async () => { await app.auth.revokeOtherSessions().catch((e) => toast((e as Error).message)); load(); }} />
        </>
      )}
    </Group>
  );
}

function ServerSetting() {
  const app = getApp();
  const [editing, setEditing] = useState(false);
  const [url, setUrl] = useState(app.auth.serverUrl);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const isDefault = app.auth.serverUrl === platform().defaultServerUrl;
  return (
    <>
      <Group title="Sync server" footer="Facet is open source. You can run your own sync server and point the app at it before signing in.">
        <Row icon={<Server size={20} />} title={app.auth.serverUrl.replace(/^https?:\/\//, '')} subtitle={isDefault ? 'Hosted by DT Software' : 'Self-hosted'} onClick={() => setEditing(true)} />
      </Group>
      {editing && (
        <Dialog
          title="Sync server"
          onClose={() => setEditing(false)}
          size="narrow"
          footer={
            <>
              <Button variant="text" onClick={() => setUrl(platform().defaultServerUrl)}>Use default</Button>
              <Button
                busy={busy}
                onClick={async () => {
                  setBusy(true);
                  setError(null);
                  const clean = url.trim().replace(/\/+$/, '');
                  try {
                    await app.auth.meta(clean);
                    await app.auth.setServerUrl(clean);
                    setEditing(false);
                  } catch {
                    setError('No Facet server answered at that address.');
                  } finally {
                    setBusy(false);
                  }
                }}
              >
                Save
              </Button>
            </>
          }
        >
          <Field label="Server address" hint="The address of a Facet sync server, e.g. https://facet.example.com" error={error ?? undefined}>
            <input className="input mono" value={url} onChange={(e) => setUrl(e.target.value)} inputMode="url" />
          </Field>
        </Dialog>
      )}
    </>
  );
}

export function AccountPage(_props: PageProps) {
  const app = getApp();
  const toast = useToast();
  const account = useAccount();
  const sync = useSyncState();
  const synced = useSyncedPrefs();
  const [dialog, setDialog] = useState<null | 'name' | 'password' | 'recovery' | 'signout' | 'delete' | 'signin' | 'signup'>(null);
  const [newCode, setNewCode] = useState<string | null>(null);

  if (account.kind !== 'signedIn') {
    const expired = account.kind === 'expired';
    return (
      <div className="col gap-16">
        <div className="group" style={{ padding: 24 }}>
          <div className="col gap-12">
            <span className="onboard-icon" style={{ width: 52, height: 52, borderRadius: '50%' }}><Cloud size={24} /></span>
            <span className="t-title-l">{expired ? 'Sign in to resume sync' : 'Sync across your devices'}</span>
            <span className="t-body c-2">
              {expired
                ? `Your session for ${account.email} ended. Your chats are still on this device.`
                : 'Keep chats, assistants and API keys in step on every device. Everything is encrypted before it leaves this device.'}
            </span>
            <div className="row gap-8" style={{ marginTop: 6, flexWrap: 'wrap' }}>
              {!expired && <Button onClick={() => ui.set({ auth: 'signup' })}>Create a free account</Button>}
              <Button variant={expired ? 'primary' : 'tonal'} onClick={() => ui.set({ auth: 'signin' })}>Sign in</Button>
            </div>
          </div>
        </div>
        <ServerSetting />
        {dialog === 'signin' && <AuthDialog mode="signin" onClose={() => setDialog(null)} />}
      </div>
    );
  }

  const status =
    sync.phase === 'SYNCING' ? 'Syncing now…'
      : sync.phase === 'IDLE' ? (sync.lastSyncAt > 0 ? 'Last synced ' + Dates.relative(sync.lastSyncAt).toLowerCase() : 'Up to date')
        : sync.message ?? 'Waiting to sync';

  return (
    <div className="col gap-16">
      <div className="group" style={{ padding: '18px 18px' }}>
        <div className="row gap-12">
          <span className="onboard-icon" style={{ borderRadius: '50%' }}><Cloud size={20} /></span>
          <span className="col grow" style={{ minWidth: 0 }}>
            <span className="t-label-l">End-to-end encrypted sync</span>
            <span className={'t-label-m ' + (sync.phase === 'ERROR' || sync.storageFull ? 'c-warning' : 'c-2')} style={{ fontWeight: 400 }}>{sync.storageFull ? sync.message : status}</span>
          </span>
          <Button variant="tonal" small busy={sync.phase === 'SYNCING'} onClick={() => void app.sync.syncNow()}>
            <RefreshCw size={15} /> Sync now
          </Button>
        </div>
      </div>
      <Group title={account.email}>
        <Row icon={<User size={20} />} title="Display name" subtitle={synced.profileName || account.displayName || 'Not set'} onClick={() => setDialog('name')} />
        <Divider />
        <Row icon={<Lock size={20} />} title="Change password" onClick={() => setDialog('password')} />
        <Divider />
        <Row icon={<KeyRound size={20} />} title="Recovery code" subtitle="Create a new code if you lost yours" onClick={() => setDialog('recovery')} />
        <Divider />
        <Row icon={<LogOut size={20} />} title="Sign out" onClick={() => setDialog('signout')} />
        <Divider />
        <Row icon={<Trash2 size={20} />} title="Delete account" danger onClick={() => setDialog('delete')} />
      </Group>
      <Devices />
      <p className="field-hint" style={{ margin: '0 6px' }}>Server: {account.serverUrl.replace(/^https:\/\//, '')}</p>

      {dialog === 'name' && (
        <TextPrompt title="Display name" initial={synced.profileName || account.displayName || ''} confirm="Save" onSubmit={(n) => app.auth.updateDisplayName(n)} onClose={() => setDialog(null)} />
      )}
      {dialog === 'password' && <ChangePassword onClose={() => setDialog(null)} />}
      {dialog === 'recovery' && !newCode && (
        <PasswordConfirm
          title="New recovery code"
          body="Your current recovery code will stop working. Enter your password to continue."
          action="Create new code"
          onConfirm={async (pw) => setNewCode(await app.auth.regenerateRecoveryCode(pw))}
          onClose={() => setDialog(null)}
        />
      )}
      {newCode && (
        <Dialog title="" onClose={() => { setNewCode(null); setDialog(null); }} size="narrow">
          <RecoveryCodeView code={newCode} reason="regenerated" onDone={() => { setNewCode(null); setDialog(null); }} />
        </Dialog>
      )}
      {dialog === 'signout' && <SignOut onClose={() => setDialog(null)} />}
      {dialog === 'delete' && (
        <PasswordConfirm
          title="Delete your account?"
          body="This permanently deletes your account and all synced data on the server, for every device. Chats stay on this device unless you remove them."
          action="Delete account"
          danger
          onConfirm={async (pw) => {
            await app.auth.deleteAccount(pw);
            setDialog(null);
            toast('Your account was deleted.');
          }}
          onClose={() => setDialog(null)}
        />
      )}
    </div>
  );
}
