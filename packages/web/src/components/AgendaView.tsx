import { useMemo } from 'react';
import { useStore, startOfLocalDay } from '../lib/store';
import { fmtDate, fmtRange, isSameDay } from '../lib/format';
import { eventColor, matchesSearch } from './WeekView';
import { useAlertPlan } from './AlertOverlay';

/** Dense list of the next days (mobile "Day" tab and desktop agenda). */
export function AgendaView() {
  const anchor = useStore((s) => s.anchor);
  const version = useStore((s) => s.version);
  const now = useStore((s) => s.now);
  const searchQuery = useStore((s) => s.searchQuery);
  const instancesFor = useStore((s) => s.instancesFor);
  const { openEdit, openCreate } = useStore.getState();
  const plan = useAlertPlan();
  const activeKeys = new Set(plan?.active.map((a) => a.instance.key) ?? []);
  const start = startOfLocalDay(anchor);
  const end = new Date(start.getTime() + 7 * 86_400_000);
  const list = useMemo(() => instancesFor(start, end).filter((i) => matchesSearch(i, searchQuery)), [version, start.getTime(), searchQuery]);
  const days = Array.from({ length: 7 }, (_, i) => new Date(start.getTime() + i * 86_400_000));
  return (
    <div className="agenda">
      {days.map((d) => {
        const items = list.filter((i) => (i.allDay ? i.start.getTime() <= d.getTime() && i.end.getTime() > d.getTime() : isSameDay(i.start, d)));
        return (
          <section key={d.getTime()} className={isSameDay(d, now) ? 'today' : ''}>
            <h3 onClick={() => openCreate({ start: new Date(d.getTime() + 9 * 3600_000), end: new Date(d.getTime() + 9.5 * 3600_000) })}>
              {fmtDate(d)}
              {isSameDay(d, now) ? <span className="pill">today</span> : null}
            </h3>
            {items.length ? (
              <ul className="list">
                {items.map((i) => (
                  <li
                    key={i.key}
                    className={`${activeKeys.has(i.key) ? 'alerting' : ''} ${i.end.getTime() < now.getTime() ? 'past' : ''} ${i.start.getTime() <= now.getTime() && i.end.getTime() > now.getTime() ? 'current' : ''}`}
                    onClick={() => openEdit(i)}
                  >
                    <span className="dot" style={{ background: eventColor(i) }} />
                    <span className="time">{fmtRange(i.start, i.end, i.allDay)}</span>
                    <span className="grow">
                      {i.tm ? <span className="tm-dot">{i.tm.alert.mode === 'none' ? '○' : '●'}</span> : null}
                      {i.isRecurring ? <span className="rec">↻ </span> : null}
                      {i.title}
                      {i.location ? <span className="muted"> · {i.location}</span> : null}
                    </span>
                    {!i.permissions.canEditDetails ? <span className="muted small">🔒</span> : null}
                  </li>
                ))}
              </ul>
            ) : (
              <p className="muted small">—</p>
            )}
          </section>
        );
      })}
    </div>
  );
}
