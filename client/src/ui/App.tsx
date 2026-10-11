import { lazy, Suspense, useEffect } from 'react';
import { getApp } from '../app';
import { t } from '../i18n';
import { platform } from '../platform';
import { AuthDialog } from './auth/AuthDialog';
import { ChatScreen } from './chat/ChatScreen';
import { Onboarding } from './auth/Onboarding';
import { ToastProvider } from './components/primitives';
import { useLocalPrefs, useNarrow } from './hooks';
import { navigate, ui, useRoute, useUi } from './nav';
import { SearchScreen } from './SearchScreen';
import { Sidebar } from './Sidebar';

const SettingsDialog = lazy(() => import('./settings/SettingsDialog'));

/** Applies the theme, text size and motion preferences to the document. */
function useAppearance() {
  const local = useLocalPrefs();
  useEffect(() => {
    const mq = matchMedia('(prefers-color-scheme: dark)');
    const apply = () => {
      const theme = local.theme;
      const dark = theme === 'DARK' || theme === 'BLACK' || (theme === 'SYSTEM' && mq.matches);
      document.documentElement.dataset.theme = theme === 'BLACK' ? 'black' : dark ? 'dark' : 'light';
      document.querySelector('meta[name="theme-color"]')?.setAttribute('content', theme === 'BLACK' ? '#000000' : dark ? '#11151B' : '#F5F6F8');
    };
    apply();
    mq.addEventListener('change', apply);
    return () => mq.removeEventListener('change', apply);
  }, [local.theme]);
  useEffect(() => {
    document.documentElement.style.setProperty('--chat-scale', String(local.chatTextScale));
    document.documentElement.dataset.reducedMotion = String(local.reducedMotion);
  }, [local.chatTextScale, local.reducedMotion]);
}

function useShortcuts() {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const mod = e.ctrlKey || e.metaKey;
      if (mod && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        navigate({ name: 'search' });
      } else if (mod && e.shiftKey && e.key.toLowerCase() === 'o') {
        e.preventDefault();
        navigate({ name: 'home' });
      } else if (mod && e.key === ',') {
        e.preventDefault();
        ui.openSettings('home');
      } else if (mod && e.shiftKey && e.key.toLowerCase() === 's') {
        e.preventDefault();
        getApp().settings.updateLocal((l) => ({ ...l, sidebarOpen: !l.sidebarOpen }));
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
}

/** "Response ready" notifications while the window is in the background. */
function useReplyNotifications() {
  const local = useLocalPrefs();
  useEffect(() => {
    const app = getApp();
    app.chat.onReplyFinished = (conversationId, title, preview) => {
      if (!local.notifyOnComplete || document.hasFocus()) return;
      platform().notify(title || t('Response ready'), preview, () => navigate({ name: 'chat', id: conversationId }));
    };
    return () => {
      app.chat.onReplyFinished = null;
    };
  }, [local.notifyOnComplete]);
}

export function App() {
  useAppearance();
  useShortcuts();
  useReplyNotifications();
  const route = useRoute();
  const narrow = useNarrow();
  const state = useUi();
  const local = useLocalPrefs();

  return (
    <ToastProvider>
      <div className="shell">
        <Sidebar narrow={narrow} />
        {route.name === 'search' ? <SearchScreen /> : <ChatScreen route={route} />}
      </div>
      {state.settings && (
        <Suspense fallback={null}>
          <SettingsDialog page={state.settings} detail={state.settingsDetail} />
        </Suspense>
      )}
      {state.auth && <AuthDialog mode={state.auth} onClose={() => ui.set({ auth: null })} />}
      {!local.onboardingDone && !state.auth && !state.settings && <Onboarding />}
    </ToastProvider>
  );
}
