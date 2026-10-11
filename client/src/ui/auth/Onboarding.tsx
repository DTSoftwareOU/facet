import { Brain, KeyRound, Monitor, ShieldCheck } from 'lucide-react';
import { useEffect, useState } from 'react';
import { getApp } from '../../app';
import { t } from '../../i18n';
import { platform } from '../../platform';
import { Gem } from '../components/Gem';
import { Button } from '../components/primitives';
import { useAccount } from '../hooks';
import { ui } from '../nav';
import { AuthLayout } from './AuthDialog';

function Point({ icon, title, body }: { icon: React.ReactNode; title: string; body: string }) {
  return (
    <div className="row gap-12" style={{ alignItems: 'flex-start' }}>
      <span className="onboard-icon">{icon}</span>
      <span className="col gap-4">
        <span className="t-label-l">{title}</span>
        <span className="t-body c-2">{body}</span>
      </span>
    </div>
  );
}

/** First run: what Facet is, then an account choice (sync is optional). */
export function Onboarding() {
  const app = getApp();
  const account = useAccount();
  const [step, setStep] = useState<'welcome' | 'account'>('welcome');
  const done = () => app.settings.updateLocal((l) => ({ ...l, onboardingDone: true }));
  const desktop = platform().kind === 'desktop';
  // Already signed in (e.g. in another window): nothing to set up here.
  useEffect(() => {
    if (account.kind !== 'guest') done();
  }, [account.kind]);
  if (account.kind !== 'guest') return null;
  return (
    <AuthLayout onClose={done}>
      {step === 'welcome' ? (
        <div className="col gap-20">
          <Gem size={56} />
          <h1 className="t-display" style={{ margin: 0, whiteSpace: 'pre-line' }}>{t('Every model.\nOne home.')}</h1>
          <p className="t-body c-2" style={{ margin: 0 }}>
            {t('Facet is a private, open-source chat app for your own OpenAI, Anthropic, Google and other API keys.')}
          </p>
          <div className="col gap-16">
            <Point icon={<KeyRound size={20} />} title={t('Your keys, your bill')} body={t('Pay providers directly. See the cost of every reply.')} />
            <Point icon={<ShieldCheck size={20} />} title={t('Encrypted end to end')} body={t('Chats and keys are locked on your device before they sync.')} />
            <Point icon={<Brain size={20} />} title={t('Full control')} body={t('Reasoning effort, web search, and every model a provider offers.')} />
            {desktop && <Point icon={<Monitor size={20} />} title={t('Works on your computer')} body={t('Let models run commands and read and edit files, with your approval.')} />}
          </div>
          <Button block onClick={() => setStep('account')}>{t('Continue')}</Button>
        </div>
      ) : (
        <div className="col gap-16">
          <h1 className="t-display" style={{ margin: 0 }}>{t('Sync, privately')}</h1>
          <p className="t-body c-2" style={{ margin: 0 }}>
            {t('A free account keeps your chats, assistants and keys in step across your phone, computer and browser. Everything is encrypted with a key only you hold.')}
          </p>
          <Button block onClick={() => ui.set({ auth: 'signup' })}>{t('Create an account')}</Button>
          <Button block variant="tonal" onClick={() => ui.set({ auth: 'signin' })}>{t('I already have an account')}</Button>
          <Button
            block
            variant="text"
            onClick={() => {
              done();
              ui.openSettings('providers');
            }}
          >
            {t('Use without an account')}
          </Button>
          <p className="field-hint" style={{ textAlign: 'center', margin: 0 }}>
            {t('Without an account, everything stays on this device. You can create one later in Settings.')}
          </p>
        </div>
      )}
    </AuthLayout>
  );
}
