/**
 * Web platform layer for alerts.
 *
 * Foreground: a 1-second ticker asks the core planner what is active and
 * delivers new reminders (overlay, Notification API, WebAudio, vibration).
 * Background: the service worker receives Web Push (when the server has VAPID
 * keys) and shows notifications; iOS suspends JavaScript, so nothing here
 * assumes a timer survives being backgrounded. On resume, the ticker re-plans
 * from the calendar data and immediately surfaces anything missed.
 */
import { planAlerts, scheduleReminders, serializeReminders, type AlertDelivery, type AlertPlan, type ScheduledReminder } from '@tm/core';
import { useStore, startOfLocalDay } from './store';

declare global {
  interface Window {
    TimeManagerNative?: { postMessage(json: string): void };
    webkit?: { messageHandlers?: { timeManager?: { postMessage(msg: unknown): void } } };
  }
}

let audioCtx: AudioContext | null = null;

export function unlockAudio(): boolean {
  try {
    audioCtx ??= new (window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext)();
    if (audioCtx.state === 'suspended') void audioCtx.resume();
    // Play a silent buffer to satisfy iOS' gesture requirement.
    const buf = audioCtx.createBuffer(1, 1, 22050);
    const src = audioCtx.createBufferSource();
    src.buffer = buf;
    src.connect(audioCtx.destination);
    src.start(0);
    return true;
  } catch {
    return false;
  }
}

export function playSound(kind: 'default' | 'chime' | 'alarm' | 'silent') {
  if (kind === 'silent' || !audioCtx) return;
  const ctx = audioCtx;
  if (ctx.state === 'suspended') void ctx.resume();
  const t0 = ctx.currentTime;
  const tone = (freq: number, start: number, dur: number, type: OscillatorType = 'sine', gain = 0.25) => {
    const o = ctx.createOscillator();
    const g = ctx.createGain();
    o.type = type;
    o.frequency.value = freq;
    g.gain.setValueAtTime(0, t0 + start);
    g.gain.linearRampToValueAtTime(gain, t0 + start + 0.01);
    g.gain.exponentialRampToValueAtTime(0.001, t0 + start + dur);
    o.connect(g).connect(ctx.destination);
    o.start(t0 + start);
    o.stop(t0 + start + dur + 0.05);
  };
  if (kind === 'chime') {
    tone(880, 0, 0.5);
    tone(1174, 0.25, 0.7);
  } else if (kind === 'alarm') {
    for (let i = 0; i < 6; i++) tone(i % 2 ? 660 : 880, i * 0.18, 0.15, 'square', 0.18);
  } else {
    tone(784, 0, 0.35);
    tone(988, 0.3, 0.45);
  }
}

export class WebAlertDelivery implements AlertDelivery {
  id = 'web';
  backgroundCapable = false;
  async schedule(reminders: ScheduledReminder[]) {
    // Hand the plan to a native wrapper if one is present.
    const msg = JSON.stringify({ type: 'schedule', reminders: serializeReminders(reminders) });
    window.TimeManagerNative?.postMessage(msg);
    window.webkit?.messageHandlers?.timeManager?.postMessage(JSON.parse(msg));
  }
  async cancel(instanceKey: string) {
    const msg = JSON.stringify({ type: 'cancel', instanceKey });
    window.TimeManagerNative?.postMessage(msg);
    window.webkit?.messageHandlers?.timeManager?.postMessage(JSON.parse(msg));
    const reg = await navigator.serviceWorker?.getRegistration();
    const notes = await reg?.getNotifications({ tag: `tm-${instanceKey}` });
    notes?.forEach((n) => n.close());
  }
  async deliverNow(r: ScheduledReminder) {
    const s = useStore.getState();
    if (s.settings.soundEnabled) playSound(r.sound);
    if (s.settings.vibrate && 'vibrate' in navigator) {
      try {
        navigator.vibrate([200, 100, 200]);
      } catch {
        /* ignore */
      }
    }
    if (s.notificationPermission === 'granted') {
      const opts: NotificationOptions & { renotify?: boolean; actions?: { action: string; title: string }[] } = {
        body: r.body,
        tag: `tm-${r.instanceKey}`,
        renotify: true,
        requireInteraction: true,
        data: { instanceKey: r.instanceKey },
        actions: [
          { action: 'ack', title: 'Acknowledge' },
          { action: 'snooze', title: 'Snooze 5m' },
        ],
      };
      try {
        const reg = await navigator.serviceWorker?.getRegistration();
        if (reg) await reg.showNotification(r.title, opts);
        else new Notification(r.title, opts);
      } catch (e) {
        console.warn('notification failed', e);
      }
    }
  }
}

export const delivery = new WebAlertDelivery();

const fired = new Map<string, number>();
let lastPlanSent = '';

export function computePlan(now: Date): AlertPlan {
  const s = useStore.getState();
  const list = s.instancesFor(startOfLocalDay(new Date(now.getTime() - 36 * 3600_000)), new Date(now.getTime() + 2 * 86_400_000));
  return planAlerts(list, now, s.localAlerts, { maxNagHours: s.settings.maxNagHours });
}

/** One tick of the foreground alert loop. Safe to call as often as you like. */
export async function alertTick(now = new Date()) {
  const s = useStore.getState();
  if (s.status !== 'ready') return;
  const plan = computePlan(now);
  for (const a of plan.active) {
    const key = a.instance.key;
    const prev = fired.get(key) ?? 0;
    if (a.firedCount > prev) {
      fired.set(key, a.firedCount);
      await delivery.deliverNow({
        instanceKey: key,
        title: a.instance.title,
        body: reminderBody(a.instance.start, now, a.instance.location),
        fireAt: now,
        sound: a.policy.sound,
        sequence: a.firedCount,
      });
    }
  }
  for (const key of [...fired.keys()]) {
    if (!plan.active.some((a) => a.instance.key === key)) {
      fired.delete(key);
      void delivery.cancel(key);
    }
  }
  // Publish the upcoming schedule to native layers when it changes.
  const list = s.instancesFor(startOfLocalDay(now), new Date(now.getTime() + 2 * 86_400_000));
  const reminders = scheduleReminders(list, now, new Date(now.getTime() + 12 * 3600_000), s.localAlerts, { maxNagHours: s.settings.maxNagHours });
  const sig = reminders.map((r) => `${r.instanceKey}@${r.fireAt.getTime()}`).join('|');
  if (sig !== lastPlanSent) {
    lastPlanSent = sig;
    void delivery.schedule(reminders);
  }
}

function reminderBody(start: Date, now: Date, location?: string) {
  const diff = start.getTime() - now.getTime();
  const mins = Math.round(Math.abs(diff) / 60_000);
  const when = diff > 60_000 ? `starts in ${mins} min` : diff < -60_000 ? `started ${mins} min ago` : 'starts now';
  return location ? `${when} · ${location}` : when;
}

export function startAlertLoop() {
  let timer: ReturnType<typeof setInterval> | null = null;
  const run = () => void alertTick();
  const start = () => {
    if (timer) return;
    timer = setInterval(run, 1000);
    run();
  };
  const stop = () => {
    if (timer) clearInterval(timer);
    timer = null;
  };
  start();
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') {
      useStore.getState().tickNow();
      start();
      void useStore.getState().sync('visible');
    } else {
      // Keep ticking in the background where the browser allows; iOS will suspend us regardless.
    }
  });
  window.addEventListener('focus', run);
  return stop;
}
