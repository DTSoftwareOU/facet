import { Brain, CornerDownLeft, Gauge, Receipt, Sparkles } from 'lucide-react';
import { getApp } from '../../app';
import type { ThemeMode } from '../../data/prefs';
import { Segmented } from '../chat/ChatSettings';
import { Divider, Group, SwitchRow } from '../components/primitives';
import { useLocalPrefs } from '../hooks';
import type { PageProps } from './SettingsDialog';

const THEMES: ThemeMode[] = ['SYSTEM', 'LIGHT', 'DARK', 'BLACK'];
const THEME_LABELS: Record<ThemeMode, string> = { SYSTEM: 'System', LIGHT: 'Light', DARK: 'Dark', BLACK: 'Black' };

export function AppearancePage(_props: PageProps) {
  const app = getApp();
  const local = useLocalPrefs();
  const set = (patch: Partial<typeof local>) => app.settings.updateLocal((l) => ({ ...l, ...patch }));
  return (
    <div className="col gap-16">
      <section className="col gap-8">
        <span className="field-label" style={{ marginLeft: 4 }}>Theme</span>
        <Segmented options={THEMES} selected={local.theme} label={(t) => THEME_LABELS[t]} onSelect={(t) => set({ theme: t })} />
        <span className="field-hint" style={{ marginLeft: 4 }}>Black uses true black backgrounds, easiest on OLED screens.</span>
      </section>
      <section className="col gap-8">
        <span className="field-label row" style={{ marginLeft: 4 }}>
          <span className="grow">Chat text size</span>
          <span className="c-2">{Math.round(local.chatTextScale * 100)}%</span>
        </span>
        <input type="range" className="range" min={0.85} max={1.3} step={0.05} value={local.chatTextScale} onChange={(e) => set({ chatTextScale: Number(e.target.value) })} aria-label="Chat text size" />
        <div className="md" style={{ padding: '10px 14px', background: 'var(--surface)', borderRadius: 14 }}>
          <p>Replies are set for reading: <strong>clear type</strong>, generous spacing, and code in <code>JetBrains Mono</code>.</p>
        </div>
      </section>
      <Group title="Behavior">
        <SwitchRow icon={<CornerDownLeft size={20} />} title="Send with Enter" subtitle={local.sendOnEnter ? 'Shift+Enter adds a new line.' : 'Ctrl+Enter sends; Enter adds a new line.'} checked={local.sendOnEnter} onChange={(v) => set({ sendOnEnter: v })} />
        <Divider />
        <SwitchRow icon={<Brain size={20} />} title="Expand reasoning" subtitle="Show the model's reasoning open while it thinks." checked={local.expandThinking} onChange={(v) => set({ expandThinking: v })} />
        <Divider />
        <SwitchRow icon={<Sparkles size={20} />} title="Reduce motion" subtitle="Replace animations with short fades. The gem stays still." checked={local.reducedMotion} onChange={(v) => set({ reducedMotion: v })} />
      </Group>
      <Group title="Usage and cost">
        <SwitchRow icon={<Gauge size={20} />} title="Show token usage" subtitle="Tokens in and out under each reply." checked={local.showUsage} onChange={(v) => set({ showUsage: v })} />
        <Divider />
        <SwitchRow icon={<Receipt size={20} />} title="Show cost" subtitle="Estimated from the provider's published prices." checked={local.showCost} onChange={(v) => set({ showCost: v })} disabled={!local.showUsage} />
      </Group>
    </div>
  );
}
