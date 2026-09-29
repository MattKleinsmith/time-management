import { useMemo } from 'react';
import type { EventInstance } from '@tm/core';
import { useStore, useCurrentAndNext } from '../lib/store';
import { fmtCountdown, fmtDate, fmtRange, fmtTime, isSameDay } from '../lib/format';
import { AlertCard, useAlertPlan } from './AlertOverlay';
import { eventColor } from './WeekView';
import { unlockAudio } from '../lib/delivery';

export function NowView() {
  const now = useStore((s) => s.now);
  const { current, next, list } = useCurrentAndNext(now);
  const plan = useAlertPlan();
  const { openEdit, changeTime, openCreate, setAudioUnlocked, setNotificationPermission } = useStore.getState();
  const audioUnlocked = useStore((s) => s.audioUnlocked);
  const notif = useStore((s) => s.notificationPermission);
  const todayRest = useMemo(() => list.filter((i) => !i.allDay && isSameDay(i.start, now) && i.end.getTime() > now.getTime()), [list, now]);
  const upcomingAlerts = plan?.scheduled.slice(0, 3) ?? [];

  const startNow = async (inst: EventInstance) => {
    const dur = inst.end.getTime() - inst.start.getTime();
    const start = new Date(Math.floor(now.getTime() / 60_000) * 60_000);
    await changeTime(inst, start, new Date(start.getTime() + dur), inst.allDay, inst.isRecurring ? 'instance' : 'instance');
  };
  const pushBy = async (inst: EventInstance, minutes: number) => {
    await changeTime(inst, new Date(inst.start.getTime() + minutes * 60_000), new Date(inst.end.getTime() + minutes * 60_000), inst.allDay, 'instance');
  };
  const endNow = async (inst: EventInstance) => {
    await changeTime(inst, inst.start, new Date(Math.max(inst.start.getTime() + 60_000, now.getTime())), inst.allDay, 'instance');
  };

  return (
    <div className="now">
      {!audioUnlocked || notif === 'default' ? (
        <div className="enable-bar">
          {!audioUnlocked ? (
            <button
              className="btn"
              onClick={() => {
                if (unlockAudio()) setAudioUnlocked(true);
              }}
            >
              🔔 Enable sound
            </button>
          ) : null}
          {notif === 'default' ? (
            <button className="btn" onClick={() => Notification.requestPermission().then((p) => setNotificationPermission(p))}>
              Allow notifications
            </button>
          ) : null}
        </div>
      ) : null}

      {plan?.active.length ? (
        <section className="now-alerts">
          <h2>Active alerts</h2>
          {plan.active.map((a) => (
            <AlertCard key={a.instance.key} alert={a} />
          ))}
        </section>
      ) : null}

      <section className="now-current">
        <h2>Now · {fmtTime(now)}</h2>
        {current ? (
          <div className="big-card" style={{ ['--c' as string]: eventColor(current) }} onClick={() => openEdit(current)}>
            <div className="big-title">{current.title}</div>
            <div className="big-sub">
              {fmtRange(current.start, current.end, current.allDay)} · ends in {fmtCountdown(current.end.getTime() - now.getTime())}
              {current.location ? ` · ${current.location}` : ''}
            </div>
            <div className="progress">
              <div style={{ width: `${Math.min(100, ((now.getTime() - current.start.getTime()) / (current.end.getTime() - current.start.getTime())) * 100)}%` }} />
            </div>
            {current.permissions.canEditDetails ? (
              <div className="quick-row" onClick={(e) => e.stopPropagation()}>
                <button className="chip" onClick={() => void pushBy(current, 15)}>
                  +15m
                </button>
                <button className="chip" onClick={() => void endNow(current)}>
                  End now
                </button>
              </div>
            ) : null}
          </div>
        ) : (
          <div className="big-card empty">
            <div className="big-title muted">Nothing scheduled right now</div>
            <button className="btn" onClick={() => openCreate()}>
              + Schedule something
            </button>
          </div>
        )}
      </section>

      <section className="now-next">
        <h2>Next</h2>
        {next ? (
          <div className="big-card" style={{ ['--c' as string]: eventColor(next) }} onClick={() => openEdit(next)}>
            <div className="big-title">{next.title}</div>
            <div className="big-sub">
              {isSameDay(next.start, now) ? '' : `${fmtDate(next.start)} · `}
              {fmtRange(next.start, next.end, next.allDay)} · in {fmtCountdown(next.start.getTime() - now.getTime())}
              {next.location ? ` · ${next.location}` : ''}
            </div>
            {next.tm && next.tm.alert.mode !== 'none' ? (
              <div className="muted small">
                Alert {next.tm.alert.leadMin ? `${next.tm.alert.leadMin} min before` : 'at start'}
                {next.tm.alert.mode === 'repeat' ? `, every ${next.tm.alert.intervalMin} min until ${next.tm.alert.until === 'ack' ? 'acknowledged' : 'it ends'}` : ', once'}
              </div>
            ) : (
              <div className="muted small">No Time Manager alert</div>
            )}
            {next.permissions.canEditDetails ? (
              <div className="quick-row" onClick={(e) => e.stopPropagation()}>
                <button className="chip" onClick={() => void startNow(next)}>
                  Start now
                </button>
                <button className="chip" onClick={() => void pushBy(next, 15)}>
                  +15m
                </button>
                <button className="chip" onClick={() => void pushBy(next, 60)}>
                  +1h
                </button>
                <button className="chip" onClick={() => void pushBy(next, 24 * 60)}>
                  Tomorrow
                </button>
              </div>
            ) : null}
          </div>
        ) : (
          <div className="big-card empty">
            <div className="big-title muted">Nothing upcoming in the next week</div>
          </div>
        )}
      </section>

      {upcomingAlerts.length ? (
        <section>
          <h2>Upcoming alerts</h2>
          <ul className="list">
            {upcomingAlerts.map((a) => (
              <li key={a.instance.key} onClick={() => openEdit(a.instance)}>
                <span className="dot" style={{ background: eventColor(a.instance) }} />
                <span className="grow">{a.instance.title}</span>
                <span className="muted">{fmtTime(a.alertStart)}</span>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      <section>
        <h2>Rest of today</h2>
        {todayRest.length ? (
          <ul className="list">
            {todayRest.map((i) => (
              <li key={i.key} className={i === current ? 'current' : ''} onClick={() => openEdit(i)}>
                <span className="dot" style={{ background: eventColor(i) }} />
                <span className="grow">
                  {i.tm ? '● ' : ''}
                  {i.title}
                </span>
                <span className="muted">{fmtTime(i.start)}</span>
              </li>
            ))}
          </ul>
        ) : (
          <p className="muted">Nothing else today.</p>
        )}
      </section>
    </div>
  );
}
