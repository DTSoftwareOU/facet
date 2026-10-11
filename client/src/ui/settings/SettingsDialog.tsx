import {
  ArrowLeft,
  Bot,
  Cloud,
  Database,
  Image as ImageIcon,
  Info,
  KeyRound,
  Library,
  MessageSquare,
  Monitor,
  Palette,
  ShieldCheck,
  Wrench,
  X,
} from 'lucide-react';
import { useEffect, useRef, type ComponentType, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { platform } from '../../platform';
import { IconButton } from '../components/primitives';
import { useNarrow } from '../hooks';
import { ui, type SettingsPage } from '../nav';
import { AboutPage } from './AboutPage';
import { AccountPage } from './AccountPage';
import { AppearancePage } from './AppearancePage';
import { AssistantsPage } from './AssistantsPage';
import { ChatPrefsPage } from './ChatPrefsPage';
import { ComputerPage } from './ComputerPage';
import { DataPage } from './DataPage';
import { MediaPage } from './MediaPage';
import { PrivacyPage } from './PrivacyPage';
import { PromptsPage } from './PromptsPage';
import { ProvidersPage } from './ProvidersPage';
import { ToolsPage } from './ToolsPage';

export interface PageProps {
  detail: string | null;
}

interface PageDef {
  id: SettingsPage;
  title: string;
  icon: ReactNode;
  component: ComponentType<PageProps>;
  desktopOnly?: boolean;
  separatorBefore?: boolean;
}

const PAGES: PageDef[] = [
  { id: 'account', title: 'Account and sync', icon: <Cloud size={19} />, component: AccountPage },
  { id: 'providers', title: 'Providers and keys', icon: <KeyRound size={19} />, component: ProvidersPage, separatorBefore: true },
  { id: 'assistants', title: 'Assistants', icon: <Bot size={19} />, component: AssistantsPage },
  { id: 'prompts', title: 'Prompt library', icon: <Library size={19} />, component: PromptsPage },
  { id: 'chat', title: 'Chat', icon: <MessageSquare size={19} />, component: ChatPrefsPage },
  { id: 'tools', title: 'Tools', icon: <Wrench size={19} />, component: ToolsPage },
  { id: 'computer', title: 'Computer access', icon: <Monitor size={19} />, component: ComputerPage },
  { id: 'media', title: 'Media models', icon: <ImageIcon size={19} />, component: MediaPage },
  { id: 'appearance', title: 'Appearance', icon: <Palette size={19} />, component: AppearancePage, separatorBefore: true },
  { id: 'privacy', title: 'Privacy and security', icon: <ShieldCheck size={19} />, component: PrivacyPage },
  { id: 'data', title: 'Data and storage', icon: <Database size={19} />, component: DataPage },
  { id: 'about', title: 'About Facet', icon: <Info size={19} />, component: AboutPage, separatorBefore: true },
];

export default function SettingsDialog({ page, detail }: { page: SettingsPage; detail: string | null }) {
  const narrow = useNarrow(760);
  const pages = PAGES.filter((p) => !p.desktopOnly || platform().computer).map((p) =>
    // Away from the Windows app, this page is about using a PC of the account.
    p.id === 'computer' && !platform().computer ? { ...p, title: 'Your PC' } : p,
  );
  // On wide windows there's no separate "home": show the first page beside the menu.
  const current = page === 'home' && !narrow ? 'account' : page;
  const def = pages.find((p) => p.id === current);
  const close = () => ui.closeSettings();

  useEffect(() => {
    const k = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || e.defaultPrevented || document.querySelectorAll('.scrim').length > 1 || document.querySelector('.menu')) return;
      if (detail) ui.openSettings(page, null);
      else close();
    };
    window.addEventListener('keydown', k);
    return () => window.removeEventListener('keydown', k);
  }, [page, detail]);

  const Page = def?.component;
  // Each page and sub-page opens at the top.
  const body = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (body.current) body.current.scrollTop = 0;
  }, [current, detail]);
  return createPortal(
    <div className="scrim settings-scrim" onMouseDown={(e) => e.target === e.currentTarget && close()}>
      <div className={'settings-dialog ' + (current === 'home' ? 'home' : 'page')} role="dialog" aria-modal="true" aria-label="Settings">
        <nav className="settings-nav" aria-label="Settings sections">
          <div className="row" style={{ marginBottom: 8 }}>
            <h2 className="t-title-l grow" style={{ margin: '0 0 0 12px' }}>Settings</h2>
            {narrow && (
              <IconButton label="Close settings" onClick={close}>
                <X size={20} />
              </IconButton>
            )}
          </div>
          {pages.map((p) => (
            <div key={p.id}>
              {p.separatorBefore && <div className="sep" />}
              <button type="button" className={p.id === current ? 'on' : ''} onClick={() => ui.openSettings(p.id)} aria-current={p.id === current ? 'page' : undefined}>
                {p.icon}
                {p.title}
              </button>
            </div>
          ))}
        </nav>
        <section className="settings-page">
          <header className="settings-head">
            {(narrow || detail) && (
              <IconButton label="Back" onClick={() => (detail ? ui.openSettings(page, null) : ui.openSettings('home'))}>
                <ArrowLeft size={20} />
              </IconButton>
            )}
            <h2 className="t-title-l">{def?.title ?? 'Settings'}</h2>
            <IconButton label="Close settings" onClick={close}>
              <X size={20} />
            </IconButton>
          </header>
          <div className="settings-body" ref={body}>{Page && <Page key={current} detail={detail} />}</div>
        </section>
      </div>
    </div>,
    document.body,
  );
}
