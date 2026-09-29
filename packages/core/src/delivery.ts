/**
 * Platform alert-delivery abstraction.
 *
 * The core decides WHAT should alert and WHEN (see alerts.ts). A platform layer
 * decides HOW to deliver it reliably on that platform:
 *   - Web (foreground): in-page overlay + Notification API + audio.
 *   - Web Push (server-scheduled): works while an installed PWA is closed.
 *   - Native iOS wrapper: local notifications / alarms scheduled ahead of time.
 *
 * Nothing in the core relies on a JavaScript timer surviving in the background:
 * `scheduleReminders` produces the full upcoming plan so a platform can hand it
 * to the OS ahead of time.
 */
import type { ScheduledReminder } from './alerts';

export interface AlertDelivery {
  readonly id: string;
  /** Whether this platform can deliver while the app is closed / device locked. */
  readonly backgroundCapable: boolean;
  /** Replace the pending reminder schedule (idempotent). */
  schedule(reminders: ScheduledReminder[]): Promise<void>;
  /** Cancel everything pending for one instance (after ack/snooze). */
  cancel(instanceKey: string): Promise<void>;
  /** Deliver one reminder right now (the foreground ticker calls this). */
  deliverNow(reminder: ScheduledReminder): Promise<void>;
}

export class NoopDelivery implements AlertDelivery {
  id = 'noop';
  backgroundCapable = false;
  async schedule() {}
  async cancel() {}
  async deliverNow() {}
}

/**
 * Bridge for a native wrapper (e.g. WKWebView). The wrapper registers
 * `window.TimeManagerNative` (or a webkit message handler) and receives the
 * plan as JSON. See docs/NATIVE_BRIDGE.md.
 */
export interface NativeBridgeMessage {
  type: 'schedule' | 'cancel' | 'deliver';
  reminders?: (Omit<ScheduledReminder, 'fireAt'> & { fireAt: string })[];
  instanceKey?: string;
}

export function serializeReminders(reminders: ScheduledReminder[]): NativeBridgeMessage['reminders'] {
  return reminders.map((r) => ({ ...r, fireAt: r.fireAt.toISOString() }));
}
