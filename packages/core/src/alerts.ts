/**
 * Alert planning. Pure functions: given instances + acknowledgement state + "now",
 * decide which alerts are active and when the next reminders fire.
 *
 * Conceptual model: "At time X start an alert and keep reminding me according
 * to this policy until I explicitly acknowledge it."
 */
import type { AlertPolicy, AlertSound } from './metadata';
import type { EventInstance } from './model';
import { MINUTE, HOUR } from './time';

export type AlertPhase = 'scheduled' | 'active' | 'snoozed' | 'acknowledged' | 'expired' | 'none';

export interface LocalAlertState {
  /** Instance keys acknowledged on this device (fallback for read-only events). */
  acked: Record<string, string>; // instanceKey -> acked at ISO
  snoozed: Record<string, string>; // instanceKey -> until ISO
}

export const emptyLocalAlertState = (): LocalAlertState => ({ acked: {}, snoozed: {} });

export interface AlertStatus {
  instance: EventInstance;
  policy: AlertPolicy;
  phase: AlertPhase;
  /** First moment the alert should have started. */
  alertStart: Date;
  /** Next moment a reminder should fire (for scheduled/active/snoozed). */
  nextFireAt?: Date;
  /** How many reminders have already been due since alertStart (active only). */
  firedCount: number;
  /** When the alert stops nagging on its own (repeat mode with until=end, or the safety cap). */
  expiresAt: Date;
}

export interface AlertPlannerOptions {
  /** Safety cap: stop nagging this many hours after the alert started even if never acknowledged. */
  maxNagHours?: number;
  /** "Alert once" stays visible this many minutes unless acknowledged. */
  onceVisibleMinutes?: number;
}

const DEFAULTS: Required<AlertPlannerOptions> = { maxNagHours: 12, onceVisibleMinutes: 60 };

function isAcked(inst: EventInstance, local: LocalAlertState): boolean {
  if (local.acked[inst.key]) return true;
  const ack = inst.tm?.ack;
  if (!ack) return false;
  if (inst.tmSource === 'series' || inst.isRecurring) {
    // Series-level ack marks the last acknowledged occurrence; everything up to it counts.
    return ack.instanceStart >= inst.instanceStart;
  }
  return ack.instanceStart === inst.instanceStart;
}

function snoozeUntil(inst: EventInstance, local: LocalAlertState): Date | undefined {
  const l = local.snoozed[inst.key];
  const r = inst.tm?.snooze && inst.tm.snooze.instanceStart === inst.instanceStart ? inst.tm.snooze.until : undefined;
  const candidates = [l, r].filter((x): x is string => !!x).map((x) => new Date(x)).filter((d) => !Number.isNaN(d.getTime()));
  if (!candidates.length) return undefined;
  return new Date(Math.max(...candidates.map((d) => d.getTime())));
}

/** Compute the alert status of one instance at `now`. */
export function alertStatusFor(
  inst: EventInstance,
  now: Date,
  local: LocalAlertState,
  opts: AlertPlannerOptions = {},
): AlertStatus | null {
  const policy = inst.tm?.alert;
  if (!policy || policy.mode === 'none' || inst.allDay) return null;
  const o = { ...DEFAULTS, ...opts };
  const alertStart = new Date(inst.start.getTime() - policy.leadMin * MINUTE);
  const t = now.getTime();
  const cap = alertStart.getTime() + o.maxNagHours * HOUR;
  let expiresAt: Date;
  if (policy.mode === 'once') expiresAt = new Date(Math.min(cap, alertStart.getTime() + o.onceVisibleMinutes * MINUTE));
  else if (policy.until === 'end') expiresAt = new Date(Math.min(cap, Math.max(inst.end.getTime(), alertStart.getTime() + MINUTE)));
  else expiresAt = new Date(cap);

  const base = { instance: inst, policy, alertStart, expiresAt, firedCount: 0 };
  if (isAcked(inst, local)) return { ...base, phase: 'acknowledged' };
  if (t < alertStart.getTime()) return { ...base, phase: 'scheduled', nextFireAt: alertStart };
  if (t >= expiresAt.getTime()) return { ...base, phase: 'expired' };
  const snooze = snoozeUntil(inst, local);
  if (snooze && snooze.getTime() > t) return { ...base, phase: 'snoozed', nextFireAt: snooze };

  if (policy.mode === 'once') {
    return { ...base, phase: 'active', firedCount: 1, nextFireAt: undefined };
  }
  // Repeat mode: reminders fire at alertStart + k*interval, or from the end of a snooze.
  const interval = Math.max(1, policy.intervalMin) * MINUTE;
  const origin = snooze && snooze.getTime() <= t ? snooze.getTime() : alertStart.getTime();
  const elapsed = t - origin;
  const k = Math.floor(elapsed / interval);
  const next = new Date(origin + (k + 1) * interval);
  return {
    ...base,
    phase: 'active',
    firedCount: k + 1,
    nextFireAt: next.getTime() < expiresAt.getTime() ? next : undefined,
  };
}

export interface AlertPlan {
  active: AlertStatus[];
  snoozed: AlertStatus[];
  scheduled: AlertStatus[];
  /** Earliest moment anything changes (a reminder fires, a snooze ends, an alert starts). */
  nextChangeAt?: Date;
}

export function planAlerts(
  instances: EventInstance[],
  now: Date,
  local: LocalAlertState,
  opts: AlertPlannerOptions = {},
): AlertPlan {
  const plan: AlertPlan = { active: [], snoozed: [], scheduled: [] };
  let next: number | undefined;
  for (const inst of instances) {
    const s = alertStatusFor(inst, now, local, opts);
    if (!s) continue;
    if (s.phase === 'active') plan.active.push(s);
    else if (s.phase === 'snoozed') plan.snoozed.push(s);
    else if (s.phase === 'scheduled') plan.scheduled.push(s);
    else continue;
    if (s.nextFireAt && (next === undefined || s.nextFireAt.getTime() < next)) next = s.nextFireAt.getTime();
  }
  plan.active.sort((a, b) => a.alertStart.getTime() - b.alertStart.getTime());
  plan.scheduled.sort((a, b) => a.alertStart.getTime() - b.alertStart.getTime());
  if (next !== undefined) plan.nextChangeAt = new Date(next);
  return plan;
}

/**
 * A platform-independent description of the reminders that should be delivered
 * in [from, to). Native layers (iOS local notifications, Web Push scheduler)
 * consume this to pre-schedule reminders without JavaScript timers.
 */
export interface ScheduledReminder {
  instanceKey: string;
  title: string;
  body: string;
  fireAt: Date;
  sound: AlertSound;
  /** 0 for the initial alert, then 1, 2, ... for repeats. */
  sequence: number;
}

export function scheduleReminders(
  instances: EventInstance[],
  from: Date,
  to: Date,
  local: LocalAlertState,
  opts: AlertPlannerOptions & { maxPerInstance?: number; maxTotal?: number } = {},
): ScheduledReminder[] {
  const maxPer = opts.maxPerInstance ?? 24;
  const maxTotal = opts.maxTotal ?? 60;
  const out: ScheduledReminder[] = [];
  for (const inst of instances) {
    const s = alertStatusFor(inst, from, local, opts);
    if (!s || s.phase === 'acknowledged' || s.phase === 'expired' || s.phase === 'none') continue;
    const interval = Math.max(1, s.policy.intervalMin) * MINUTE;
    const body = formatReminderBody(inst, from);
    let fireAt = s.nextFireAt;
    let seq = s.phase === 'active' ? s.firedCount : 0;
    // If the alert is currently active, deliver immediately once so a freshly-opened
    // platform layer does not wait a whole interval.
    if (s.phase === 'active') {
      out.push({ instanceKey: inst.key, title: inst.title, body, fireAt: from, sound: s.policy.sound, sequence: seq });
    }
    let n = 0;
    while (fireAt && fireAt.getTime() < to.getTime() && fireAt.getTime() < s.expiresAt.getTime() && n < maxPer) {
      seq++;
      out.push({ instanceKey: inst.key, title: inst.title, body, fireAt, sound: s.policy.sound, sequence: seq });
      n++;
      if (s.policy.mode !== 'repeat') break;
      fireAt = new Date(fireAt.getTime() + interval);
    }
  }
  out.sort((a, b) => a.fireAt.getTime() - b.fireAt.getTime());
  return out.slice(0, maxTotal);
}

export function formatReminderBody(inst: EventInstance, now: Date): string {
  const diff = inst.start.getTime() - now.getTime();
  const mins = Math.round(Math.abs(diff) / MINUTE);
  const when = diff > MINUTE ? `starts in ${mins} min` : diff < -MINUTE ? `started ${mins} min ago` : 'starts now';
  return inst.location ? `${when} · ${inst.location}` : when;
}

export const SNOOZE_PRESETS_MIN = [1, 5, 10, 15, 30, 60];
