import { Bell, Globe, Lock, ShieldCheck } from 'lucide-react';
import { useState } from 'react';
import { getApp } from '../../app';
import { sentences, t } from '../../i18n';
import { platform } from '../../platform';
import { Group, SwitchRow } from '../components/primitives';
import { useLocalPrefs } from '../hooks';
import type { PageProps } from './SettingsDialog';

export function PrivacyPage(_props: PageProps) {
  const app = getApp();
  const local = useLocalPrefs();
  const web = platform().kind === 'web';
  const [permission, setPermission] = useState(typeof Notification !== 'undefined' ? Notification.permission : 'denied');
  const set = (patch: Partial<typeof local>) => app.settings.updateLocal((l) => ({ ...l, ...patch }));

  return (
    <div className="col gap-16">
      <div className="group" style={{ padding: 18 }}>
        <div className="row gap-12" style={{ alignItems: 'flex-start' }}>
          <span className="onboard-icon"><ShieldCheck size={20} /></span>
          <div className="col gap-6">
            <span className="t-label-l">{t("What's encrypted")}</span>
            <span className="t-body c-2">
              {sentences(
                t('Chats, files, assistants, prompts, settings, MCP sign-ins and API keys are encrypted on this device with a key derived from your password before they sync.'),
                t('The sync server stores only ciphertext and never sees your password.'),
                web ? t('Model requests go straight from this browser to the provider you choose.') : t('Model requests go straight from this computer to the provider you choose.'),
              )}
            </span>
          </div>
        </div>
      </div>
      {web && (
        <div className="notice" style={{ marginTop: 0 }}>
          <Lock size={18} style={{ flex: 'none', marginTop: 2 }} />
          <span>
            {t("The website's code is delivered by the server each time you open it. For the strongest guarantee, use the Facet app for Windows or Android, whose code is installed on your device and doesn't change under you.")}
          </span>
        </div>
      )}
      <Group title={t('Notifications')}>
        <SwitchRow
          icon={<Bell size={20} />}
          title={t('Tell me when a reply is ready')}
          subtitle={
            web && permission === 'denied' ? t('Notifications are blocked for this site in your browser settings.')
              : web && permission !== 'granted' && local.notifyOnComplete ? t('Allow notifications when your browser asks.')
                : t('Only while Facet is in the background.')
          }
          checked={local.notifyOnComplete && permission !== 'denied'}
          onChange={async (v) => {
            set({ notifyOnComplete: v });
            if (v && typeof Notification !== 'undefined' && Notification.permission === 'default') setPermission(await Notification.requestPermission());
          }}
        />
      </Group>
      <Group title={t('Network')} footer={t('Facet never sends your chats or keys anywhere except the providers and servers you set up.')}>
        <SwitchRow
          icon={<Globe size={20} />}
          title={t('Live model prices')}
          subtitle={t("Download OpenRouter's public price list once a day for cost estimates. No account or key is sent.")}
          checked={local.pricingFeed}
          onChange={(v) => {
            set({ pricingFeed: v });
            if (v) void app.pricing.refreshIfStale({ enabled: true, maxAgeMs: 0 });
          }}
        />
      </Group>
    </div>
  );
}
