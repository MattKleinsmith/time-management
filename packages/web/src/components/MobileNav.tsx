import { useStore } from '../lib/store';

export function MobileNav() {
  const view = useStore((s) => s.view);
  const { setView, openCreate } = useStore.getState();
  const items: { id: typeof view; label: string; icon: string }[] = [
    { id: 'now', label: 'Now', icon: '◉' },
    { id: 'agenda', label: 'Day', icon: '☰' },
    { id: 'week', label: 'Grid', icon: '▦' },
    { id: 'settings', label: 'More', icon: '⚙' },
  ];
  return (
    <nav className="mobile-nav mobile-only">
      {items.slice(0, 2).map((it) => (
        <button key={it.id} className={view === it.id ? 'active' : ''} onClick={() => setView(it.id)}>
          <span className="ic">{it.icon}</span>
          {it.label}
        </button>
      ))}
      <button className="fab" onClick={() => openCreate()} aria-label="New event">
        +
      </button>
      {items.slice(2).map((it) => (
        <button key={it.id} className={view === it.id ? 'active' : ''} onClick={() => setView(it.id)}>
          <span className="ic">{it.icon}</span>
          {it.label}
        </button>
      ))}
    </nav>
  );
}
