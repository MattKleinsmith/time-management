import { useEffect, useMemo, useRef, useState } from 'react';
import { type EventInstance } from '@tm/core';
import { useStore, viewRange, startOfLocalDay } from '../lib/store';
import { fmtDayHeader, fmtHourLabel, fmtTime, GOOGLE_COLORS, isSameDay } from '../lib/format';
import { useAlertPlan } from './AlertOverlay';

const MIN = 60_000;
const DAY = 86_400_000;

interface Segment {
  inst: EventInstance;
  dayIndex: number;
  top: number; // minutes from day start
  bottom: number;
  col: number;
  cols: number;
}

type Gesture =
  | { kind: 'move'; inst: EventInstance; origin: { x: number; y: number }; startedAt: number; moved: boolean; duplicate: boolean; preview?: { start: Date; end: Date } }
  | { kind: 'resize'; inst: EventInstance; origin: { x: number; y: number }; moved: boolean; preview?: { start: Date; end: Date } }
  | { kind: 'create'; anchor: Date; dayIndex: number; preview?: { start: Date; end: Date } };

export function eventColor(inst: EventInstance): string {
  if (inst.colorId && GOOGLE_COLORS[inst.colorId]) return GOOGLE_COLORS[inst.colorId];
  return inst.calendar.backgroundColor ?? '#3b82f6';
}

export function matchesSearch(inst: EventInstance, q: string): boolean {
  if (!q) return true;
  const s = q.toLowerCase();
  return (
    inst.title.toLowerCase().includes(s) ||
    (inst.location ?? '').toLowerCase().includes(s) ||
    (inst.description ?? '').toLowerCase().includes(s) ||
    (inst.tm?.tags ?? []).some((t) => t.toLowerCase().includes(s))
  );
}

function layoutDay(segs: Segment[]): void {
  // Greedy column assignment for overlapping events (classic calendar layout).
  segs.sort((a, b) => a.top - b.top || b.bottom - a.bottom);
  let cluster: Segment[] = [];
  let clusterEnd = -1;
  const flush = () => {
    const colEnds: number[] = [];
    for (const s of cluster) {
      let col = colEnds.findIndex((end) => end <= s.top);
      if (col < 0) {
        col = colEnds.length;
        colEnds.push(s.bottom);
      } else colEnds[col] = s.bottom;
      s.col = col;
    }
    for (const s of cluster) s.cols = colEnds.length;
    cluster = [];
  };
  for (const s of segs) {
    if (cluster.length && s.top >= clusterEnd) flush();
    cluster.push(s);
    clusterEnd = Math.max(clusterEnd, s.bottom);
  }
  if (cluster.length) flush();
}

export function WeekView() {
  const view = useStore((s) => s.view);
  const anchor = useStore((s) => s.anchor);
  const settings = useStore((s) => s.settings);
  const version = useStore((s) => s.version);
  const now = useStore((s) => s.now);
  const selectedKey = useStore((s) => s.selectedKey);
  const searchQuery = useStore((s) => s.searchQuery);
  const instancesFor = useStore((s) => s.instancesFor);
  const { select, openEdit, openCreate, changeTime, setSettings } = useStore.getState();
  const plan = useAlertPlan();
  const range = viewRange({ view, anchor, settings });
  const days = useMemo(() => Array.from({ length: range.days }, (_, i) => new Date(range.start.getTime() + i * DAY)).map((d) => startOfLocalDay(d)), [range.start.getTime(), range.days]);
  const instances = useMemo(() => instancesFor(range.start, range.end).filter((i) => matchesSearch(i, searchQuery)), [version, range.start.getTime(), range.end.getTime(), searchQuery]);
  const pxPerHour = settings.pxPerHour;
  const hourStart = settings.dayStartHour;
  const hourEnd = settings.dayEndHour;
  const gridMinutes = (hourEnd - hourStart) * 60;
  const pxPerMin = pxPerHour / 60;
  const bodyRef = useRef<HTMLDivElement>(null);
  const [gesture, setGesture] = useState<Gesture | null>(null);
  const gestureRef = useRef<Gesture | null>(null);
  gestureRef.current = gesture;

  const activeKeys = useMemo(() => new Set(plan?.active.map((a) => a.instance.key) ?? []), [plan]);

  // Build timed segments per day and all-day rows.
  const { segments, allDay } = useMemo(() => {
    const segments: Segment[][] = days.map(() => []);
    const allDay: { inst: EventInstance; from: number; to: number }[] = [];
    for (const inst of instances) {
      if (inst.allDay) {
        const from = Math.max(0, Math.floor((inst.start.getTime() - range.start.getTime()) / DAY));
        const to = Math.min(days.length - 1, Math.ceil((inst.end.getTime() - range.start.getTime()) / DAY) - 1);
        allDay.push({ inst, from, to: Math.max(from, to) });
        continue;
      }
      for (let di = 0; di < days.length; di++) {
        const dayStart = days[di].getTime() + hourStart * 60 * MIN;
        const dayEnd = days[di].getTime() + hourEnd * 60 * MIN;
        const s = Math.max(inst.start.getTime(), dayStart);
        const e = Math.min(inst.end.getTime(), dayEnd);
        if (e <= s && !(inst.start.getTime() === inst.end.getTime() && s >= dayStart && s < dayEnd)) continue;
        const top = (s - dayStart) / MIN;
        const bottom = Math.max(top + 15, (e - dayStart) / MIN);
        segments[di].push({ inst, dayIndex: di, top, bottom, col: 0, cols: 1 });
      }
    }
    segments.forEach(layoutDay);
    return { segments, allDay };
  }, [instances, days, hourStart, hourEnd]);

  // Scroll to "now" (or 7am) on first render / when the range changes.
  useEffect(() => {
    const el = bodyRef.current;
    if (!el) return;
    const today = days.find((d) => isSameDay(d, now));
    const targetMin = today ? Math.max(0, now.getHours() * 60 + now.getMinutes() - hourStart * 60 - 90) : Math.max(0, (7 - hourStart) * 60);
    el.scrollTop = targetMin * pxPerMin;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [range.start.getTime(), pxPerHour, view]);

  // ---- pointer gestures ---------------------------------------------------

  function pointToTime(clientX: number, clientY: number): { dayIndex: number; minutes: number } | null {
    const el = bodyRef.current;
    if (!el) return null;
    const rect = el.getBoundingClientRect();
    const gutter = 52;
    const x = clientX - rect.left - gutter;
    const width = rect.width - gutter;
    const dayIndex = Math.min(days.length - 1, Math.max(0, Math.floor((x / width) * days.length)));
    const y = clientY - rect.top + el.scrollTop;
    const minutes = Math.min(gridMinutes, Math.max(0, y / pxPerMin));
    return { dayIndex, minutes };
  }

  function snap(minutes: number): number {
    return Math.round(minutes / settings.snapMinutes) * settings.snapMinutes;
  }

  function timeAt(dayIndex: number, minutes: number): Date {
    return new Date(days[dayIndex].getTime() + (hourStart * 60 + minutes) * MIN);
  }

  function onPointerDownEvent(e: React.PointerEvent, inst: EventInstance, mode: 'move' | 'resize') {
    if (e.button !== 0) return;
    if (e.pointerType === 'touch') return; // touch uses the editor for rescheduling
    e.stopPropagation();
    (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId);
    const origin = { x: e.clientX, y: e.clientY };
    if (mode === 'move') setGesture({ kind: 'move', inst, origin, startedAt: Date.now(), moved: false, duplicate: e.altKey });
    else setGesture({ kind: 'resize', inst, origin, moved: false });
  }

  function onPointerDownGrid(e: React.PointerEvent) {
    if (e.button !== 0 || e.pointerType === 'touch') return;
    const p = pointToTime(e.clientX, e.clientY);
    if (!p) return;
    const startMin = snap(p.minutes);
    const start = timeAt(p.dayIndex, startMin);
    setGesture({ kind: 'create', anchor: start, dayIndex: p.dayIndex, preview: { start, end: new Date(start.getTime() + settings.snapMinutes * MIN) } });
    select(null);
  }

  function onPointerMove(e: React.PointerEvent) {
    const g = gestureRef.current;
    if (!g) return;
    const p = pointToTime(e.clientX, e.clientY);
    if (!p) return;
    if (g.kind === 'move') {
      const dx = e.clientX - g.origin.x;
      const dy = e.clientY - g.origin.y;
      if (!g.moved && Math.hypot(dx, dy) < 4) return;
      const duration = g.inst.end.getTime() - g.inst.start.getTime();
      // Keep the pointer's offset inside the event.
      const origin = pointToTime(g.origin.x, g.origin.y)!;
      const originMin = (g.inst.start.getTime() - days[origin.dayIndex].getTime()) / MIN - hourStart * 60;
      const offset = origin.minutes - originMin;
      const newStartMin = snap(p.minutes - offset);
      const start = timeAt(p.dayIndex, newStartMin);
      setGesture({ ...g, moved: true, preview: { start, end: new Date(start.getTime() + duration) } });
    } else if (g.kind === 'resize') {
      const dayIndex = days.findIndex((d) => isSameDay(d, g.inst.start));
      const di = dayIndex >= 0 ? dayIndex : p.dayIndex;
      const endMin = Math.max(((g.inst.start.getTime() - days[di].getTime()) / MIN - hourStart * 60) + settings.snapMinutes, snap(p.minutes));
      const end = timeAt(di, endMin);
      setGesture({ ...g, moved: true, preview: { start: g.inst.start, end } });
    } else if (g.kind === 'create') {
      const t = timeAt(p.dayIndex, snap(p.minutes));
      const start = t < g.anchor ? t : g.anchor;
      const end = t < g.anchor ? g.anchor : new Date(Math.max(t.getTime(), g.anchor.getTime() + settings.snapMinutes * MIN));
      setGesture({ ...g, preview: { start, end } });
    }
  }

  async function onPointerUp(e: React.PointerEvent) {
    const g = gestureRef.current;
    if (!g) return;
    setGesture(null);
    if (g.kind === 'create') {
      const preview = g.preview ?? { start: g.anchor, end: new Date(g.anchor.getTime() + settings.defaultDurationMin * MIN) };
      const moved = g.preview && g.preview.end.getTime() - g.preview.start.getTime() > settings.snapMinutes * MIN;
      openCreate({ start: preview.start, end: moved ? preview.end : new Date(preview.start.getTime() + settings.defaultDurationMin * MIN) });
      return;
    }
    if (!g.moved || !g.preview) {
      if (g.kind === 'move') {
        select(g.inst.key);
        if (e.detail >= 2) openEdit(g.inst);
      }
      return;
    }
    if (g.kind === 'move' && g.duplicate) {
      openCreate({
        title: g.inst.title,
        description: g.inst.description ?? '',
        location: g.inst.location ?? '',
        calendarId: g.inst.permissions.calendarWritable ? g.inst.calendarId : undefined,
        start: g.preview.start,
        end: g.preview.end,
        tm: g.inst.tm,
      });
      return;
    }
    if (g.preview.start.getTime() === g.inst.start.getTime() && g.preview.end.getTime() === g.inst.end.getTime()) return;
    await changeTime(g.inst, g.preview.start, g.preview.end);
  }

  const previewFor = (key: string) => (gesture && gesture.kind !== 'create' && gesture.inst.key === key ? gesture.preview : undefined);

  const hours = Array.from({ length: hourEnd - hourStart }, (_, i) => hourStart + i);
  const nowMin = now.getHours() * 60 + now.getMinutes() - hourStart * 60;

  return (
    <div className="week" style={{ ['--days' as string]: days.length, ['--pxh' as string]: `${pxPerHour}px` }}>
      <div className="week-head">
        <div className="gutter zoom">
          <button title="Zoom out (-)" onClick={() => setSettings({ pxPerHour: Math.max(24, pxPerHour - 8) })}>
            −
          </button>
          <button title="Zoom in (+)" onClick={() => setSettings({ pxPerHour: Math.min(200, pxPerHour + 8) })}>
            +
          </button>
        </div>
        {days.map((d, i) => {
          const h = fmtDayHeader(d);
          const today = isSameDay(d, now);
          return (
            <div key={i} className={`day-head ${today ? 'today' : ''} ${d.getDay() === 0 || d.getDay() === 6 ? 'weekend' : ''}`} onClick={() => { useStore.getState().setAnchor(d); useStore.getState().setView('day'); }}>
              <span className="wd">{h.weekday}</span>
              <span className="dn">{h.day}</span>
              {d.getDate() === 1 || i === 0 ? <span className="mo">{h.month}</span> : null}
            </div>
          );
        })}
      </div>
      {allDay.length ? (
        <div className="allday-row">
          <div className="gutter">all day</div>
          <div className="allday-grid">
            {allDay.map(({ inst, from, to }) => (
              <div
                key={inst.key}
                className={`allday-chip ${selectedKey === inst.key ? 'selected' : ''}`}
                style={{ gridColumn: `${from + 1} / ${to + 2}`, background: eventColor(inst) }}
                onClick={() => select(inst.key)}
                onDoubleClick={() => openEdit(inst)}
                title={inst.title}
              >
                {inst.title}
              </div>
            ))}
          </div>
        </div>
      ) : null}
      <div className="week-body" ref={bodyRef} onPointerMove={onPointerMove} onPointerUp={onPointerUp} onPointerCancel={() => setGesture(null)}>
        <div className="gutter-col">
          {hours.map((h) => (
            <div key={h} className="hour-label" style={{ height: pxPerHour }}>
              <span>{fmtHourLabel(h)}</span>
            </div>
          ))}
        </div>
        <div className="days-grid" onPointerDown={onPointerDownGrid} style={{ height: gridMinutes * pxPerMin }}>
          {days.map((d, di) => {
            const today = isSameDay(d, now);
            return (
              <div key={di} className={`day-col ${today ? 'today' : ''} ${d.getDay() === 0 || d.getDay() === 6 ? 'weekend' : ''}`}>
                {hours.map((h) => (
                  <div key={h} className="hour-line" style={{ top: (h - hourStart) * pxPerHour }} />
                ))}
                {today && nowMin >= 0 && nowMin <= gridMinutes ? <div className="now-line" style={{ top: nowMin * pxPerMin }} /> : null}
                {segments[di].map((seg) => {
                  const inst = seg.inst;
                  const preview = previewFor(inst.key);
                  const dragging = !!preview;
                  const color = eventColor(inst);
                  const heightPx = (seg.bottom - seg.top) * pxPerMin;
                  const isActive = activeKeys.has(inst.key);
                  const past = inst.end.getTime() < now.getTime();
                  return (
                    <div
                      key={inst.key + seg.dayIndex}
                      className={`event ${selectedKey === inst.key ? 'selected' : ''} ${dragging ? 'dragging' : ''} ${isActive ? 'alerting' : ''} ${past ? 'past' : ''} ${inst.tm ? 'tm' : ''} ${inst.status === 'tentative' ? 'tentative' : ''} ${!inst.permissions.canEditDetails ? 'readonly' : ''}`}
                      style={{
                        top: seg.top * pxPerMin,
                        height: heightPx,
                        left: `calc(${(seg.col / seg.cols) * 100}% + 1px)`,
                        width: `calc(${100 / seg.cols}% - 3px)`,
                        ['--c' as string]: color,
                      }}
                      onPointerDown={(e) => onPointerDownEvent(e, inst, 'move')}
                      onClick={(e) => {
                        if (e.detail === 1 && (e.nativeEvent as PointerEvent).pointerType === 'touch') select(inst.key);
                      }}
                      onDoubleClick={() => openEdit(inst)}
                      onContextMenu={(e) => {
                        e.preventDefault();
                        openEdit(inst);
                      }}
                      title={`${inst.title}\n${fmtTime(inst.start)} – ${fmtTime(inst.end)}${inst.location ? `\n${inst.location}` : ''}${inst.permissions.reason ? `\n${inst.permissions.reason}` : ''}`}
                    >
                      <div className="event-inner">
                        <span className="event-title">
                          {inst.tm ? <span className="tm-dot" title="Time Manager alert configured">{inst.tm.alert.mode === 'none' ? '○' : '●'}</span> : null}
                          {inst.isRecurring ? <span className="rec">↻</span> : null}
                          {inst.title}
                        </span>
                        {heightPx > 28 ? (
                          <span className="event-time">
                            {fmtTime(inst.start)} – {fmtTime(inst.end)}
                            {inst.location ? ` · ${inst.location}` : ''}
                          </span>
                        ) : null}
                      </div>
                      {inst.permissions.canEditDetails ? <div className="resize-handle" onPointerDown={(e) => onPointerDownEvent(e, inst, 'resize')} /> : null}
                    </div>
                  );
                })}
                {gesture?.preview
                  ? (() => {
                      const p = gesture.preview!;
                      const dayStart = d.getTime() + hourStart * 60 * MIN;
                      const dayEnd = d.getTime() + hourEnd * 60 * MIN;
                      const s = Math.max(p.start.getTime(), dayStart);
                      const e = Math.min(p.end.getTime(), dayEnd);
                      if (e <= s) return null;
                      return (
                        <div className="event ghost" style={{ top: ((s - dayStart) / MIN) * pxPerMin, height: Math.max(12, ((e - s) / MIN) * pxPerMin), left: 1, right: 2 }}>
                          <div className="event-inner">
                            <span className="event-title">{gesture.kind === 'create' ? 'New event' : gesture.inst.title}</span>
                            <span className="event-time">
                              {fmtTime(p.start)} – {fmtTime(p.end)}
                            </span>
                          </div>
                        </div>
                      );
                    })()
                  : null}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
