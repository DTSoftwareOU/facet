import { Copy, Download, KeyRound, TriangleAlert } from 'lucide-react';
import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { getApp } from '../../app';
import { platform } from '../../platform';
import { Gem } from '../components/Gem';
import { Button, Field, IconButton, useToast } from '../components/primitives';
import { Segmented } from '../chat/ChatSettings';
import { X } from 'lucide-react';

export function passwordOk(p: string): boolean {
  return p.length >= 10;
}

export function passwordHint(p: string): string {
  if (!p) return 'At least 10 characters. A passphrase of a few words works well.';
  if (p.length < 10) return `${10 - p.length} more characters`;
  if (p.length < 14) return 'Good. Longer is even stronger.';
  return 'Strong';
}

/** A full-window card for account flows. */
export function AuthLayout({ onClose, children }: { onClose: () => void; children: React.ReactNode }) {
  useEffect(() => {
    const k = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !e.defaultPrevented && document.querySelectorAll('.scrim').length === 1) onClose();
    };
    window.addEventListener('keydown', k);
    return () => window.removeEventListener('keydown', k);
  }, [onClose]);
  return createPortal(
    <div className="scrim auth-scrim">
      <div className="auth-card" role="dialog" aria-modal="true">
        <IconButton label="Close" className="auth-close" onClick={onClose}>
          <X size={20} />
        </IconButton>
        {children}
      </div>
    </div>,
    document.body,
  );
}

export function RecoveryCodeView({ code, reason, onDone }: { code: string; reason: 'new' | 'reset' | 'regenerated'; onDone: () => void }) {
  const toast = useToast();
  const [saved, setSaved] = useState(false);
  const text = `Facet recovery code\n\n${code}\n\nKeep this somewhere safe. It unlocks your encrypted data if you forget your password.\n`;
  return (
    <div className="col gap-16">
      <KeyRound size={36} className="c-warning" />
      <h1 className="t-display" style={{ margin: 0 }}>Save your recovery code</h1>
      <p className="t-body c-2" style={{ margin: 0 }}>
        {reason === 'reset'
          ? 'Your password was reset. Here is your new recovery code. Any older code no longer works.'
          : reason === 'regenerated'
            ? 'Here is your new recovery code. Your previous code no longer works.'
            : 'If you forget your password, this code is the only way to unlock your encrypted data. We can’t recover it for you.'}
      </p>
      <div className="recovery-code mono" aria-label={code}>
        {code.split('-').slice(0, 4).join('-')}
        <br />
        {code.split('-').slice(4).join('-')}
      </div>
      <div className="row gap-8" style={{ flexWrap: 'wrap' }}>
        <Button variant="tonal" onClick={() => { void navigator.clipboard.writeText(code); toast('Recovery code copied.'); }}>
          <Copy size={17} /> Copy
        </Button>
        <Button variant="tonal" onClick={() => platform().saveFile('facet-recovery-code.txt', new Blob([text], { type: 'text/plain' }))}>
          <Download size={17} /> Save as file
        </Button>
      </div>
      <label className="row gap-12" style={{ cursor: 'pointer' }}>
        <input type="checkbox" checked={saved} onChange={(e) => setSaved(e.target.checked)} style={{ width: 18, height: 18, accentColor: 'var(--primary)' }} />
        <span className="t-body">I saved my recovery code somewhere safe</span>
      </label>
      <Button block disabled={!saved} onClick={onDone}>Done</Button>
    </div>
  );
}

function ServerLine() {
  const app = getApp();
  const [editing, setEditing] = useState(false);
  const [url, setUrl] = useState(app.auth.serverUrl);
  if (editing) {
    return (
      <div className="col gap-8">
        <Field label="Sync server" hint="Self-hosting? Enter your server's address. Leave empty for the default.">
          <input className="input" value={url} onChange={(e) => setUrl(e.target.value)} placeholder={platform().defaultServerUrl} />
        </Field>
        <div className="row gap-8">
          <Button small onClick={async () => { await app.auth.setServerUrl(url); setUrl(app.auth.serverUrl); setEditing(false); }}>Save</Button>
          <Button small variant="text" onClick={() => setEditing(false)}>Cancel</Button>
        </div>
      </div>
    );
  }
  return (
    <button type="button" className="t-label-m c-3" style={{ alignSelf: 'center' }} onClick={() => setEditing(true)}>
      Sync server: {app.auth.serverUrl.replace(/^https:\/\//, '')} · Change
    </button>
  );
}

function SignInUp({ initial, onForgot, onSignedUp, onDone }: { initial: 'signin' | 'signup'; onForgot: () => void; onSignedUp: (code: string) => void; onDone: () => void }) {
  const app = getApp();
  const [mode, setMode] = useState(initial);
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState(true);
  const signUp = mode === 'signup';
  useEffect(() => {
    void app.auth.meta().then((m) => setOpen(m.registrationOpen), () => {});
  }, []);
  const emailOk = /@.+\./.test(email);
  const canSubmit = emailOk && !busy && (signUp ? passwordOk(password) && password === confirm && open : password.length > 0);
  const submit = async () => {
    if (!canSubmit) return;
    setBusy(true);
    setError(null);
    try {
      if (signUp) onSignedUp(await app.auth.register(email, password, name));
      else {
        await app.auth.login(email, password);
        onDone();
      }
    } catch (e) {
      setError((e as Error).message || 'Something went wrong.');
    } finally {
      setBusy(false);
    }
  };
  return (
    <form className="col gap-16" onSubmit={(e) => { e.preventDefault(); void submit(); }}>
      <Gem size={40} />
      <div className="col gap-8">
        <h1 className="t-display" style={{ margin: 0 }}>{signUp ? 'Create your account' : 'Welcome back'}</h1>
        <p className="t-body c-2" style={{ margin: 0 }}>
          {signUp ? 'Your chats, assistants and keys are encrypted on this device before they sync. Not even we can read them.' : 'Sign in to sync your encrypted chats to this device.'}
        </p>
      </div>
      {signUp && (
        <Field label="Name (optional)">
          <input className="input" value={name} onChange={(e) => setName(e.target.value)} placeholder="What should we call you?" autoComplete="name" />
        </Field>
      )}
      <Field label="Email">
        <input className="input" type="email" value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="email" autoFocus />
      </Field>
      <Field label="Password" hint={signUp ? passwordHint(password) : undefined}>
        <input className="input" type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete={signUp ? 'new-password' : 'current-password'} />
      </Field>
      {signUp && (
        <Field label="Confirm password" error={confirm && confirm !== password ? 'Passwords don’t match.' : undefined}>
          <input className="input" type="password" value={confirm} onChange={(e) => setConfirm(e.target.value)} autoComplete="new-password" />
        </Field>
      )}
      {signUp && (
        <div className="notice" style={{ marginTop: 0 }}>
          <KeyRound size={18} className="c-warning" style={{ flex: 'none', marginTop: 2 }} />
          <span>Because your data is end-to-end encrypted, we can’t reset your password for you. You’ll get a recovery code next. Keep it somewhere safe.</span>
        </div>
      )}
      {signUp && !open && <span className="field-error">This server isn’t accepting new accounts.</span>}
      {error && <span className="field-error" role="alert">{error}</span>}
      <Button type="submit" block busy={busy} disabled={!canSubmit}>
        {busy ? (signUp ? 'Securing your account…' : 'Signing in…') : signUp ? 'Create account' : 'Sign in'}
      </Button>
      <div className="row" style={{ justifyContent: 'space-between', flexWrap: 'wrap', gap: 8 }}>
        <button type="button" className="t-label-m c-primary" onClick={() => { setMode(signUp ? 'signin' : 'signup'); setError(null); }}>
          {signUp ? 'Already have an account? Sign in' : 'New to Facet? Create an account'}
        </button>
        {!signUp && <button type="button" className="t-label-m c-2" onClick={onForgot}>Forgot password?</button>}
      </div>
      <ServerLine />
    </form>
  );
}

function Recover({ onDone }: { onDone: (code: string) => void }) {
  const app = getApp();
  const [mode, setMode] = useState<'code' | 'email'>('code');
  const [email, setEmail] = useState('');
  const [recovery, setRecovery] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [emailCode, setEmailCode] = useState('');
  const [codeSent, setCodeSent] = useState(false);
  const [emailEnabled, setEmailEnabled] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    void app.auth.meta().then((m) => setEmailEnabled(m.emailEnabled), () => {});
  }, []);
  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
    } catch (e) {
      setError((e as Error).message || 'Something went wrong.');
    } finally {
      setBusy(false);
    }
  };
  const pwOk = passwordOk(password) && password === confirm;
  return (
    <div className="col gap-16">
      <h1 className="t-display" style={{ margin: 0 }}>Reset your password</h1>
      <Segmented options={['code', 'email'] as const as ('code' | 'email')[]} selected={mode} label={(m) => (m === 'code' ? 'Recovery code' : 'Email')} onSelect={(m) => { setMode(m); setError(null); }} />
      <Field label="Email">
        <input className="input" type="email" value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="email" />
      </Field>
      {mode === 'code' ? (
        <>
          <p className="t-body c-2" style={{ margin: 0 }}>Your data stays intact. You’ll get a new recovery code afterwards.</p>
          <Field label="Recovery code">
            <input className="input mono" value={recovery} onChange={(e) => setRecovery(e.target.value)} placeholder="XXXX-XXXX-XXXX-XXXX-…" />
          </Field>
          <Field label="New password" hint={passwordHint(password)}>
            <input className="input" type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="new-password" />
          </Field>
          <Field label="Confirm new password" error={confirm && confirm !== password ? 'Passwords don’t match.' : undefined}>
            <input className="input" type="password" value={confirm} onChange={(e) => setConfirm(e.target.value)} autoComplete="new-password" />
          </Field>
          {error && <span className="field-error" role="alert">{error}</span>}
          <Button block busy={busy} disabled={!email.includes('@') || !recovery.trim() || !pwOk} onClick={() => run(async () => onDone(await app.auth.recoverWithCode(email, recovery, password)))}>
            Reset password
          </Button>
        </>
      ) : !emailEnabled ? (
        <p className="t-body c-2" style={{ margin: 0 }}>This sync server can’t send email. Use your recovery code instead, or ask the server’s operator.</p>
      ) : (
        <>
          <div className="notice error" style={{ marginTop: 0 }}>
            <TriangleAlert size={18} style={{ flex: 'none', marginTop: 2 }} />
            <span>Without your recovery code, your encrypted data on the server can’t be unlocked, so it will be deleted. Chats on this device are uploaded again afterwards.</span>
          </div>
          {!codeSent ? (
            <Button block busy={busy} disabled={!email.includes('@')} onClick={() => run(async () => { await app.auth.requestEmailReset(email); setCodeSent(true); })}>
              Email me a code
            </Button>
          ) : (
            <>
              <p className="t-body c-2" style={{ margin: 0 }}>If an account exists for {email}, we sent an 8-digit code. It expires in 30 minutes.</p>
              <Field label="Code from the email">
                <input className="input mono" inputMode="numeric" value={emailCode} onChange={(e) => setEmailCode(e.target.value.replace(/\D/g, '').slice(0, 8))} />
              </Field>
              <Field label="New password" hint={passwordHint(password)}>
                <input className="input" type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="new-password" />
              </Field>
              <Field label="Confirm new password" error={confirm && confirm !== password ? 'Passwords don’t match.' : undefined}>
                <input className="input" type="password" value={confirm} onChange={(e) => setConfirm(e.target.value)} autoComplete="new-password" />
              </Field>
              <Button block variant="danger" busy={busy} disabled={emailCode.length !== 8 || !pwOk} onClick={() => run(async () => onDone(await app.auth.confirmEmailReset(email, emailCode, password)))}>
                Reset password and data
              </Button>
            </>
          )}
          {error && <span className="field-error" role="alert">{error}</span>}
        </>
      )}
    </div>
  );
}

/** Sign in, create an account, or reset the password; ends on the recovery code when there is one. */
export function AuthDialog({ mode, onClose }: { mode: 'signin' | 'signup' | 'recover'; onClose: () => void }) {
  const toast = useToast();
  const [step, setStep] = useState<'form' | 'recover' | { code: string; reason: 'new' | 'reset' }>(mode === 'recover' ? 'recover' : 'form');
  const finish = () => {
    getApp().settings.updateLocal((l) => ({ ...l, onboardingDone: true }));
    onClose();
  };
  return (
    <AuthLayout onClose={onClose}>
      {step === 'form' && (
        <SignInUp
          initial={mode === 'signup' ? 'signup' : 'signin'}
          onForgot={() => setStep('recover')}
          onSignedUp={(code) => setStep({ code, reason: 'new' })}
          onDone={() => {
            toast('Signed in. Syncing your chats…');
            finish();
          }}
        />
      )}
      {step === 'recover' && <Recover onDone={(code) => setStep({ code, reason: 'reset' })} />}
      {typeof step === 'object' && <RecoveryCodeView code={step.code} reason={step.reason} onDone={finish} />}
    </AuthLayout>
  );
}
