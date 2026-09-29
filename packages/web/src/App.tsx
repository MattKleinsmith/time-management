import { useEffect } from 'react';
import { useStore } from './lib/store';
import { TopBar } from './components/TopBar';
import { WeekView } from './components/WeekView';
import { NowView } from './components/NowView';
import { AgendaView } from './components/AgendaView';
import { SettingsView } from './components/SettingsView';
import { EventEditor } from './components/EventEditor';
import { AlertOverlay } from './components/AlertOverlay';
import { HelpOverlay, ScopePromptModal, Toasts } from './components/Modals';
import { MobileNav } from './components/MobileNav';
import { useKeyboard } from './hooks/useKeyboard';
import { SignIn } from './components/SignIn';

export default function App() {
  const status = useStore((s) => s.status);
  const view = useStore((s) => s.view);
  const theme = useStore((s) => s.settings.theme);
  const editor = useStore((s) => s.editor);
  useKeyboard();

  useEffect(() => {
    const dark = theme === 'dark' || (theme === 'system' && window.matchMedia('(prefers-color-scheme: dark)').matches);
    document.documentElement.dataset.theme = dark ? 'dark' : 'light';
  }, [theme]);

  if (status === 'booting') return <div className="boot">Loading Time Manager…</div>;
  if (status === 'unauthenticated') return <SignIn />;
  if (status === 'error') return <div className="boot error">Something went wrong: {useStore.getState().error}</div>;

  return (
    <div className={`app view-${view} ${editor ? 'editor-open' : ''}`}>
      <TopBar />
      <main className="main">
        <AlertOverlay />
        {view === 'week' || view === 'day' ? <WeekView /> : null}
        {view === 'now' ? <NowView /> : null}
        {view === 'agenda' ? <AgendaView /> : null}
        {view === 'settings' ? <SettingsView /> : null}
      </main>
      {editor ? <EventEditor /> : null}
      <MobileNav />
      <ScopePromptModal />
      <HelpOverlay />
      <Toasts />
    </div>
  );
}
