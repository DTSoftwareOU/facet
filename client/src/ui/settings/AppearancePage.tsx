import { Brain, CornerDownLeft, Gauge, Languages, Receipt, Sparkles } from 'lucide-react';
import { useState } from 'react';
import { getApp } from '../../app';
import type { ThemeMode } from '../../data/prefs';
import { LOCALES, formatNumber, languageName, locale, resolveLocale, t, type LanguagePref } from '../../i18n';
import { tRich } from '../../i18n/rich';
import { Segmented } from '../chat/ChatSettings';
import { Dialog, Divider, Group, Row, SwitchRow } from '../components/primitives';
import { useLocalPrefs } from '../hooks';
import { ChoiceRow } from './common';
import type { PageProps } from './SettingsDialog';

const THEMES: ThemeMode[] = ['SYSTEM', 'LIGHT', 'DARK', 'BLACK'];

function themeLabel(mode: ThemeMode): string {
  switch (mode) {
    case 'SYSTEM': return t('System');
    case 'LIGHT': return t('Light');
    case 'DARK': return t('Dark');
    case 'BLACK': return t('Black');
  }
}

function nativeName(code: string): string {
  return LOCALES.find((l) => l.code === code)?.name ?? code;
}

/** "Deutsch", or "Automatic (system)" for the system choice. */
function languageChoiceLabel(pref: LanguagePref): string {
  return pref === 'auto' ? t('Automatic (system)') : nativeName(pref);
}

/** Every language by its own name, with its name in the current language beneath. Changing it reloads the window. */
function LanguageDialog({ current, onClose }: { current: LanguagePref; onClose: () => void }) {
  const system = resolveLocale('auto');
  const choose = (pref: LanguagePref) => {
    if (pref === current) {
      onClose();
      return;
    }
    getApp().settings.updateLocal((l) => ({ ...l, language: pref }));
    // Strings are translated once per page load, so the simplest reliable switch is a reload.
    location.reload();
  };
  const sorted = [...LOCALES].sort((a, b) => a.name.localeCompare(b.name, 'en'));
  return (
    <Dialog title={t('Language')} onClose={onClose} size="narrow">
      <div className="group outlined">
        <ChoiceRow
          title={t('Automatic (system)')}
          subtitle={<span lang={system} dir="auto">{nativeName(system)}</span>}
          checked={current === 'auto'}
          onClick={() => choose('auto')}
        />
        {sorted.map((l) => {
          const translatedName = languageName(l.code);
          return (
            <ChoiceRow
              key={l.code}
              title={<span lang={l.code} dir="auto">{l.name}</span>}
              subtitle={l.code === locale() || translatedName === l.name ? undefined : translatedName}
              checked={current === l.code}
              onClick={() => choose(l.code)}
            />
          );
        })}
      </div>
    </Dialog>
  );
}

export function AppearancePage(_props: PageProps) {
  const app = getApp();
  const local = useLocalPrefs();
  const [languageOpen, setLanguageOpen] = useState(false);
  const set = (patch: Partial<typeof local>) => app.settings.updateLocal((l) => ({ ...l, ...patch }));
  return (
    <div className="col gap-16">
      <Group>
        <Row
          icon={<Languages size={20} />}
          title={t('Language')}
          subtitle={<span lang={local.language === 'auto' ? undefined : local.language}>{languageChoiceLabel(local.language)}</span>}
          onClick={() => setLanguageOpen(true)}
        />
      </Group>
      <section className="col gap-8">
        <span className="field-label" style={{ marginInlineStart: 4 }}>{t('Theme')}</span>
        <Segmented options={THEMES} selected={local.theme} label={themeLabel} onSelect={(mode) => set({ theme: mode })} />
        <span className="field-hint" style={{ marginInlineStart: 4 }}>{t('Black uses true black backgrounds, easiest on OLED screens.')}</span>
      </section>
      <section className="col gap-8">
        <span className="field-label row" style={{ marginInlineStart: 4 }}>
          <span className="grow">{t('Chat text size')}</span>
          <span className="c-2">{formatNumber(local.chatTextScale, { style: 'percent', maximumFractionDigits: 0 })}</span>
        </span>
        <input type="range" className="range" min={0.85} max={1.3} step={0.05} value={local.chatTextScale} onChange={(e) => set({ chatTextScale: Number(e.target.value) })} aria-label={t('Chat text size')} />
        <div className="md" style={{ padding: '10px 14px', background: 'var(--surface)', borderRadius: 14 }}>
          <p>
            {tRich('Replies are set for reading: {clearType}, generous spacing, and code in {font}.', {
              clearType: <strong>{t('clear type')}</strong>,
              font: <code>JetBrains Mono</code>,
            })}
          </p>
        </div>
      </section>
      <Group title={t('Behavior')}>
        <SwitchRow icon={<CornerDownLeft size={20} className="flip-rtl" />} title={t('Send with Enter')} subtitle={local.sendOnEnter ? t('Shift+Enter adds a new line.') : t('Ctrl+Enter sends; Enter adds a new line.')} checked={local.sendOnEnter} onChange={(v) => set({ sendOnEnter: v })} />
        <Divider />
        <SwitchRow icon={<Brain size={20} />} title={t('Expand reasoning')} subtitle={t('Show the model\'s reasoning open while it thinks.')} checked={local.expandThinking} onChange={(v) => set({ expandThinking: v })} />
        <Divider />
        <SwitchRow icon={<Sparkles size={20} />} title={t('Reduce motion')} subtitle={t('Replace animations with short fades. The gem stays still.')} checked={local.reducedMotion} onChange={(v) => set({ reducedMotion: v })} />
      </Group>
      <Group title={t('Usage and cost')}>
        <SwitchRow icon={<Gauge size={20} />} title={t('Show token usage')} subtitle={t('Tokens in and out under each reply.')} checked={local.showUsage} onChange={(v) => set({ showUsage: v })} />
        <Divider />
        <SwitchRow icon={<Receipt size={20} />} title={t('Show cost')} subtitle={t('Estimated from the provider\'s published prices.')} checked={local.showCost} onChange={(v) => set({ showCost: v })} disabled={!local.showUsage} />
      </Group>
      {languageOpen && <LanguageDialog current={local.language} onClose={() => setLanguageOpen(false)} />}
    </div>
  );
}
