import { useStore, viewRange } from '../lib/store';
import { fmtDate, fmtMonthYear } from '../lib/format';
import { asset, BASE, logout } from '../lib/api';

export function TopBar() {
  const view = useStore((s) => s.view);
  const anchor = useStore((s) => s.anchor);
  const settings = useStore((s) => s.settings);
  const syncing = useStore((s) => s.syncing);
  const lastSyncAt = useStore((s) => s.lastSyncAt);
  const syncError = useStore((s) => s.syncError);
  const searchQuery = useStore((s) => s.searchQuery);
  const me = useStore((s) => s.me);
  const { setView, navigate, goToday, sync, openCreate, setSettings, setSearch, toggleHelp } = useStore.getState();
  const range = viewRange({ view, anchor, settings });
  const endShown = new Date(range.end.getTime() - 1);
  const title =
    view === 'week'
      ? range.days === 1
        ? fmtDate(range.start, true)
        : `${fmtDate(range.start)} – ${fmtDate(endShown)}`
      : view === 'day'
        ? fmtDate(range.start, true)
        : view === 'now'
          ? 'Now'
          : view === 'agenda'
            ? fmtMonthYear(anchor)
            : 'Settings';

  return (
    <header className="topbar">
      <div className="topbar-left">
        <button className="btn icon" title="Toggle help (?)" onClick={toggleHelp} aria-label="Help">
          <img src={asset('icons/icon.svg')} width={22} height={22} alt="" />
        </button>
        <div className="seg desktop-only">
          <button className={view === 'day' ? 'active' : ''} onClick={() => setView('day')} title="Day view (d)">
            Day
          </button>
          <button className={view === 'week' ? 'active' : ''} onClick={() => setView('week')} title="Multi-day view (w)">
            {settings.daysInView === 7 ? 'Week' : `${settings.daysInView}d`}
          </button>
          <button className={view === 'agenda' ? 'active' : ''} onClick={() => setView('agenda')} title="Agenda (g)">
            Agenda
          </button>
          <button className={view === 'now' ? 'active' : ''} onClick={() => setView('now')} title="Now (h)">
            Now
          </button>
        </div>
        {view === 'week' ? (
          <label className="days-select desktop-only" title="Days in view">
            <input
              type="range"
              min={1}
              max={14}
              value={settings.daysInView}
              onChange={(e) => setSettings({ daysInView: Number(e.target.value) })}
            />
          </label>
        ) : null}
      </div>
      <div className="topbar-center">
        {view !== 'now' && view !== 'settings' ? (
          <>
            <button className="btn icon" onClick={() => navigate(-1)} title="Previous (←)">
              ‹
            </button>
            <button className="btn" onClick={goToday} title="Today (t)">
              Today
            </button>
            <button className="btn icon" onClick={() => navigate(1)} title="Next (→)">
              ›
            </button>
          </>
        ) : null}
        <span className="title">{title}</span>
      </div>
      <div className="topbar-right">
        <input
          className="search desktop-only"
          placeholder="Search (/)"
          value={searchQuery}
          onChange={(e) => setSearch(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Escape') {
              setSearch('');
              (e.target as HTMLInputElement).blur();
            }
          }}
        />
        <button className="btn primary" onClick={() => openCreate()} title="New event (n)">
          + New
        </button>
        <button
          className={`btn icon sync ${syncing ? 'spinning' : ''} ${syncError ? 'err' : ''}`}
          onClick={() => sync('manual')}
          title={syncError ? `Sync error: ${syncError}` : lastSyncAt ? `Synced ${lastSyncAt.toLocaleTimeString()} (r)` : 'Sync (r)'}
        >
          ⟳
        </button>
        <button className="btn icon desktop-only" onClick={() => setView('settings')} title="Settings (,)">
          ⚙
        </button>
        <button
          className="btn icon desktop-only"
          title={`Signed in as ${me?.email ?? ''}. Click to sign out.`}
          onClick={async () => {
            if (confirm('Sign out of Time Manager?')) {
              await logout(false);
              location.href = BASE;
            }
          }}
        >
          ⎋
        </button>
      </div>
    </header>
  );
}
