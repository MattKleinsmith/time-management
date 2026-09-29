import { useMemo } from 'react';
import { SNOOZE_PRESETS_MIN, type AlertStatus } from '@tm/core';
import { useStore } from '../lib/store';
import { computePlan, unlockAudio } from '../lib/delivery';
import { fmtCountdown, fmtTime } from '../lib/format';

export function useAlertPlan() {
  const now = useStore((s) => s.now);
  const version = useStore((s) => s.version);
  const status = useStore((s) => s.status);
  return useMemo(() => (status === 'ready' ? computePlan(new Date()) : null), [now, version, status]);
}

export function AlertOverlay() {
  const plan = useAlertPlan();
  const view = useStore((s) => s.view);
  if (!plan || !plan.active.length) return null;
  // The Now view renders alerts inline; elsewhere show a floating stack.
  if (view === 'now') return null;
  return (
    <div className="alert-bar" role="region" aria-label="Active alerts">
      {plan.active.map((a) => (
        <AlertCard key={a.instance.key} alert={a} compact />
      ))}
    </div>
  );
}

export function AlertCard({ alert, compact = false }: { alert: AlertStatus; compact?: boolean }) {
  const { acknowledge, snooze, openEdit, setAudioUnlocked } = useStore.getState();
  const audioUnlocked = useStore((s) => s.audioUnlocked);
  const now = useStore((s) => s.now);
  const inst = alert.instance;
  const diff = inst.start.getTime() - now.getTime();
  const when = diff > 0 ? `in ${fmtCountdown(diff)}` : diff < -60_000 ? `${fmtCountdown(diff)} ago` : 'now';
  return (
    <div className={`alert-card ${compact ? 'compact' : ''}`} role="alert">
      <div className="alert-head">
        <span className="pulse" />
        <div className="alert-title" onClick={() => openEdit(inst)}>
          <strong>{inst.title}</strong>
          <span className="muted">
            {fmtTime(inst.start)} · {when}
            {alert.policy.mode === 'repeat' ? ` · every ${alert.policy.intervalMin}m` : ''}
            {alert.firedCount > 1 ? ` · ×${alert.firedCount}` : ''}
          </span>
        </div>
      </div>
      <div className="alert-actions">
        <button
          className="btn primary"
          onClick={() => {
            if (!audioUnlocked && unlockAudio()) setAudioUnlocked(true);
            void acknowledge(inst);
          }}
        >
          Acknowledge
        </button>
        <div className="snooze-group">
          {(compact ? [5, 15] : SNOOZE_PRESETS_MIN).map((m) => (
            <button key={m} className="btn" onClick={() => void snooze(inst, m)}>
              {m}m
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
