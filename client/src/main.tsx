import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { getApp } from './app';
import { readLocal } from './data/prefs';
import { initI18n } from './i18n';
import { App } from './ui/App';
import './ui/styles/tokens.css';
import './ui/styles/base.css';
import './ui/styles/layout.css';
import './ui/styles/markdown.css';
import './ui/styles/screens.css';

async function boot() {
  // The language loads first, so nothing renders in English before its translation arrives.
  await initI18n(readLocal().language);
  const root = createRoot(document.getElementById('root')!);
  // Development builds expose the app for scripted UI tests.
  if (import.meta.env.DEV) (window as unknown as { facetApp: unknown }).facetApp = getApp();
  try {
    await getApp().start();
  } catch (e) {
    console.error('Facet failed to start', e);
  }
  root.render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
}

void boot();
