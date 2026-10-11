import { Cloud, KeyRound, Laptop, Lock, LogOut, Monitor, RefreshCw, Server, Smartphone, Trash2, User } from 'lucide-react';
import { useEffect, useState } from 'react';
import { getApp } from '../../app';
import { Dates } from '../../core/format';
import { t } from '../../i18n';
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
      setError((e as Error).message || t('That didn’t work.'));
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
          <Button variant="text" onClick={onClose}>{t('Cancel')}</Button>
          <Button variant={danger ? 'danger' : 'primary'} busy={busy} disabled={!pw} onClick={submit}>{action}</Button>
        </>
      }
    >
      <div className="col gap-12">
        <p className="t-body c-2" style={{ margin: 0 }}>{body}</p>
        <Field label={t('Password')} error={error ?? undefined}>
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
      title={t('Change password')}
      onClose={onClose}
      size="narrow"
      footer={done ? <Button onClick={onClose}>{t('Done')}</Button> : (
        <>
          <Button variant="text" onClick={onClose}>{t('Cancel')}</Button>
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
            {t('Change password')}
          </Button>
        </>
      )}
    >
      {done ? (
        <p className="t-body c-2">{t('Password changed. Other devices were signed out and will ask for the new password.')}</p>
      ) : (
        <div className="col gap-12">
          <Field label={t('Current password')}>
            <input className="input" type="password" value={current} onChange={(e) => setCurrent(e.target.value)} autoComplete="current-password" />
          </Field>
          <Field label={t('New password')} hint={passwordHint(next)}>
            <input className="input" type="password" value={next} onChange={(e) => setNext(e.target.value)} autoComplete="new-password" />
          </Field>
          <Field label={t('Confirm new password')} error={confirm && confirm !== next ? t('Passwords don’t match.') : undefined}>
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
    <Dialog title={t('Sign out?')} onClose={onClose} size="narrow">
      <div className="col gap-12">
        <p className="t-body c-2" style={{ margin: 0 }}>{t('Your data stays safe in your account. Choose whether to keep a copy on this device.')}</p>
        <Button block variant="danger" busy={busy === 'remove'} disabled={!!busy} onClick={() => out(true)}>{t('Sign out and remove data from this device')}</Button>
        <Button block variant="tonal" busy={busy === 'keep'} disabled={!!busy} onClick={() => out(false)}>{t('Sign out and keep data here')}</Button>
      </div>
    </Dialog>
  );
}

function platformIcon(s: SessionDto) {
  if (s.platform === 'android') return <Smartphone size={20} />;
  if (s.platform === 'web') return <Laptop size={20} />;
  return <Monitor size={20} />;
}

function sessionTitle(s: SessionDto): string {
  if (!s.deviceName) return s.current ? t('Unknown device (this device)') : t('Unknown device');
  return s.current ? t('{device} (this device)', { device: s.deviceName }) : s.deviceName;
}

function sessionSubtitle(s: SessionDto): string {
  const active = Dates.justNow(s.lastSeenAt) ? t('Active just now') : t('Active {time}', { time: Dates.relative(s.lastSeenAt) });
  return s.ip ? `${active} · ${s.ip}` : active;
}

function Devices() {
  const app = getApp();
  const toast = useToast();
  const [list, setList] = useState<SessionDto[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = () => {
    app.auth.sessions().then((s) => { setList(s); setError(null); }, (e) => setError((e as Error).message || t('Couldn’t load devices.')));
  };
  useEffect(load, []);
  return (
    <Group title={t('Signed-in devices')}>
      {error && <Row icon={<Cloud size={20} />} title={t('Couldn’t load devices')} subtitle={error} />}
      {!list && !error && <div className="srow"><Spinner /></div>}
      {list?.map((s, i) => (
        <div key={s.id}>
          {i > 0 && <Divider />}
          <Row
            icon={platformIcon(s)}
            title={<bdi>{sessionTitle(s)}</bdi>}
            subtitle={sessionSubtitle(s)}
            trailing={!s.current ? <Button variant="text" small onClick={async () => { await app.auth.revokeSession(s.id).catch((e) => toast((e as Error).message)); load(); }}>{t('Sign out')}</Button> : undefined}
          />
        </div>
      ))}
      {list && list.length > 1 && (
        <>
          <Divider full />
          <Row icon={<LogOut size={20} />} title={t('Sign out of all other devices')} onClick={async () => { await app.auth.revokeOtherSessions().catch((e) => toast((e as Error).message)); load(); }} />
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
      <Group title={t('Sync server')} footer={t('Facet is open source. You can run your own sync server and point the app at it before signing in.')}>
        <Row icon={<Server size={20} />} title={<bdi>{app.auth.serverUrl.replace(/^https?:\/\//, '')}</bdi>} subtitle={isDefault ? t('Hosted by DT Software') : t('Self-hosted')} onClick={() => setEditing(true)} />
      </Group>
      {editing && (
        <Dialog
          title={t('Sync server')}
          onClose={() => setEditing(false)}
          size="narrow"
          footer={
            <>
              <Button variant="text" onClick={() => setUrl(platform().defaultServerUrl)}>{t('Use default')}</Button>
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
                    setError(t('No Facet server answered at that address.'));
                  } finally {
                    setBusy(false);
                  }
                }}
              >
                {t('Save')}
              </Button>
            </>
          }
        >
          <Field label={t('Server address')} hint={t('The address of a Facet sync server, e.g. {example}', { example: 'https://facet.example.com' })} error={error ?? undefined}>
            <input className="input mono" value={url} onChange={(e) => setUrl(e.target.value)} inputMode="url" dir="ltr" />
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
            <span className="t-title-l">{expired ? t('Sign in to resume sync') : t('Sync across your devices')}</span>
            <span className="t-body c-2">
              {expired
                ? t('Your session for {email} ended. Your chats are still on this device.', { email: account.email })
                : t('Keep chats, assistants and API keys in step on every device. Everything is encrypted before it leaves this device.')}
            </span>
            <div className="row gap-8" style={{ marginTop: 6, flexWrap: 'wrap' }}>
              {!expired && <Button onClick={() => ui.set({ auth: 'signup' })}>{t('Create a free account')}</Button>}
              <Button variant={expired ? 'primary' : 'tonal'} onClick={() => ui.set({ auth: 'signin' })}>{t('Sign in')}</Button>
            </div>
          </div>
        </div>
        <ServerSetting />
        {dialog === 'signin' && <AuthDialog mode="signin" onClose={() => setDialog(null)} />}
      </div>
    );
  }

  const status =
    sync.phase === 'SYNCING' ? t('Syncing now…')
      : sync.phase === 'IDLE'
        ? sync.lastSyncAt > 0
          ? Dates.justNow(sync.lastSyncAt) ? t('Last synced just now') : t('Last synced {time}', { time: Dates.relative(sync.lastSyncAt) })
          : t('Up to date')
        : sync.message ?? t('Waiting to sync');

  return (
    <div className="col gap-16">
      <div className="group" style={{ padding: '18px 18px' }}>
        <div className="row gap-12">
          <span className="onboard-icon" style={{ borderRadius: '50%' }}><Cloud size={20} /></span>
          <span className="col grow" style={{ minWidth: 0 }}>
            <span className="t-label-l">{t('End-to-end encrypted sync')}</span>
            <span className={'t-label-m ' + (sync.phase === 'ERROR' || sync.storageFull ? 'c-warning' : 'c-2')} style={{ fontWeight: 400 }}>{sync.storageFull ? sync.message : status}</span>
          </span>
          <Button variant="tonal" small busy={sync.phase === 'SYNCING'} onClick={() => void app.sync.syncNow()}>
            <RefreshCw size={15} /> {t('Sync now')}
          </Button>
        </div>
      </div>
      <Group title={<bdi>{account.email}</bdi>}>
        <Row icon={<User size={20} />} title={t('Display name')} subtitle={synced.profileName || account.displayName ? <bdi>{synced.profileName || account.displayName}</bdi> : t('Not set')} onClick={() => setDialog('name')} />
        <Divider />
        <Row icon={<Lock size={20} />} title={t('Change password')} onClick={() => setDialog('password')} />
        <Divider />
        <Row icon={<KeyRound size={20} />} title={t('Recovery code')} subtitle={t('Create a new code if you lost yours')} onClick={() => setDialog('recovery')} />
        <Divider />
        <Row icon={<LogOut size={20} />} title={t('Sign out')} onClick={() => setDialog('signout')} />
        <Divider />
        <Row icon={<Trash2 size={20} />} title={t('Delete account')} danger onClick={() => setDialog('delete')} />
      </Group>
      <Devices />
      <p className="field-hint" style={{ margin: '0 6px' }}>{t('Server: {address}', { address: account.serverUrl.replace(/^https:\/\//, '') })}</p>

      {dialog === 'name' && (
        <TextPrompt title={t('Display name')} initial={synced.profileName || account.displayName || ''} confirm={t('Save')} onSubmit={(n) => app.auth.updateDisplayName(n)} onClose={() => setDialog(null)} />
      )}
      {dialog === 'password' && <ChangePassword onClose={() => setDialog(null)} />}
      {dialog === 'recovery' && !newCode && (
        <PasswordConfirm
          title={t('New recovery code')}
          body={t('Your current recovery code will stop working. Enter your password to continue.')}
          action={t('Create new code')}
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
          title={t('Delete your account?')}
          body={t('This permanently deletes your account and all synced data on the server, for every device. Chats stay on this device unless you remove them.')}
          action={t('Delete account')}
          danger
          onConfirm={async (pw) => {
            await app.auth.deleteAccount(pw);
            setDialog(null);
            toast(t('Your account was deleted.'));
          }}
          onClose={() => setDialog(null)}
        />
      )}
    </div>
  );
}
