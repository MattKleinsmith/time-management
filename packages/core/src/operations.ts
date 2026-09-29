/**
 * High-level commands the UI calls. Every write goes to Google Calendar and the
 * returned resource is applied to the local cache immediately (the next
 * incremental sync re-confirms it).
 *
 * Rules enforced here:
 *  - never silently modify or duplicate events the user cannot edit;
 *  - configure the recurring parent by default rather than creating exceptions;
 *  - Time Manager metadata lives only in extendedProperties.private.
 */
import { formatReminderBody, type LocalAlertState } from './alerts';
import { applyPrivatePropsPatch, clearTmConfigPatch, defaultTmConfig, parseTmConfig, serializeTmConfig, type TmConfig } from './metadata';
import type { EventInstance } from './model';
import { eventTiming, expandRecurrence } from './recurrence';
import type { SyncEngine } from './sync';
import { DAY, formatDateOnly, toRfc3339InZone } from './time';
import { GcalError, type GcalClient, type GcalEvent } from './types';

export type EditScope = 'instance' | 'series' | 'following';

export interface EventDraft {
  calendarId: string;
  title: string;
  start: Date;
  end: Date;
  allDay: boolean;
  timeZone: string;
  description?: string;
  location?: string;
  /** RRULE/RDATE/EXDATE lines, e.g. ["RRULE:FREQ=WEEKLY;BYDAY=MO,WE"]. */
  recurrence?: string[];
  colorId?: string;
  tm?: TmConfig | null;
}

export interface TimeChange {
  start: Date;
  end: Date;
  allDay?: boolean;
}

export class ReadOnlyEventError extends Error {
  constructor(
    message: string,
    public readonly instance: EventInstance,
  ) {
    super(message);
    this.name = 'ReadOnlyEventError';
  }
}

export interface OperationsHost {
  client: GcalClient;
  engine: SyncEngine;
  localAlerts: {
    get(): LocalAlertState;
    set(next: LocalAlertState): void;
  };
}

export function gcalTime(date: Date, allDay: boolean, tz: string) {
  return allDay ? { date: formatDateOnly(new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()))) } : { dateTime: toRfc3339InZone(date, tz), timeZone: tz };
}

export class EventOperations {
  constructor(private readonly host: OperationsHost) {}

  private get client() {
    return this.host.client;
  }
  private get engine() {
    return this.host.engine;
  }

  async createEvent(draft: EventDraft): Promise<GcalEvent> {
    const body: Partial<GcalEvent> = {
      summary: draft.title,
      start: gcalTime(draft.start, draft.allDay, draft.timeZone),
      end: gcalTime(draft.end, draft.allDay, draft.timeZone),
    };
    if (draft.description) body.description = draft.description;
    if (draft.location) body.location = draft.location;
    if (draft.colorId) body.colorId = draft.colorId;
    if (draft.recurrence?.length) body.recurrence = draft.recurrence;
    if (draft.tm) {
      const props = serializeTmConfig(draft.tm);
      const priv: Record<string, string> = {};
      for (const [k, v] of Object.entries(props)) if (v !== null) priv[k] = v;
      body.extendedProperties = { private: priv };
    }
    const created = await this.client.insertEvent(draft.calendarId, body);
    await this.engine.upsertLocal(draft.calendarId, created);
    return created;
  }

  /** Change title/description/location/colour (details) with recurring scope. */
  async updateDetails(
    inst: EventInstance,
    patch: Partial<Pick<GcalEvent, 'summary' | 'description' | 'location' | 'colorId' | 'recurrence'>>,
    scope: EditScope = inst.isRecurring ? 'series' : 'instance',
  ): Promise<GcalEvent> {
    this.assertCanEditDetails(inst);
    return this.patchWithScope(inst, patch, scope);
  }

  /** Move / resize. */
  async changeTime(inst: EventInstance, change: TimeChange, scope: EditScope = 'instance'): Promise<GcalEvent> {
    this.assertCanEditDetails(inst);
    const allDay = change.allDay ?? inst.allDay;
    const tz = inst.timeZone;
    if (scope === 'series' && inst.isRecurring && inst.master) {
      // Shift the whole series by the same delta the user applied to this occurrence.
      const master = inst.master;
      const mt = eventTiming(master, tz);
      if (!mt) throw new Error('Cannot read series timing');
      const deltaStart = change.start.getTime() - inst.start.getTime();
      const newDuration = change.end.getTime() - change.start.getTime();
      const newStart = new Date(mt.start.getTime() + deltaStart);
      const newEnd = new Date(newStart.getTime() + newDuration);
      const patched = await this.client.patchEvent(inst.calendarId, master.id, {
        start: gcalTime(newStart, allDay, tz),
        end: gcalTime(newEnd, allDay, tz),
      });
      await this.engine.upsertLocal(inst.calendarId, patched);
      return patched;
    }
    return this.patchWithScope(inst, { start: gcalTime(change.start, allDay, tz), end: gcalTime(change.end, allDay, tz) }, scope);
  }

  /** Attach / update Time Manager configuration. Defaults to the whole series for recurring events. */
  async setTmConfig(inst: EventInstance, cfg: TmConfig, scope: EditScope = inst.isRecurring ? 'series' : 'instance'): Promise<GcalEvent> {
    if (!inst.permissions.canConfigure) {
      throw new ReadOnlyEventError(
        `${inst.permissions.reason ?? 'This event cannot be modified.'} A future "Create configurable copy" feature could make a private copy you control.`,
        inst,
      );
    }
    const config: TmConfig = { ...cfg, v: cfg.v || '1', own: scope === 'instance' && inst.isRecurring };
    const props = serializeTmConfig(config);
    return this.patchWithScope(inst, { extendedProperties: { private: props as Record<string, string> } }, scope);
  }

  /** Remove Time Manager configuration (keeps the ordinary Google event). */
  async clearTmConfig(inst: EventInstance, scope: EditScope = inst.isRecurring ? 'series' : 'instance'): Promise<GcalEvent> {
    if (!inst.permissions.canConfigure) throw new ReadOnlyEventError(inst.permissions.reason ?? 'Read-only event', inst);
    const target = scope === 'series' && inst.master ? inst.master : inst.event;
    const props = clearTmConfigPatch(target);
    if (scope === 'instance' && inst.isRecurring) {
      // Exception keeps inheriting series config unless explicitly opted out: mark none.
      const off = defaultTmConfig({ own: true, alert: { ...defaultTmConfig().alert, mode: 'none' } });
      return this.patchWithScope(inst, { extendedProperties: { private: serializeTmConfig(off) as Record<string, string> } }, 'instance');
    }
    return this.patchWithScope(inst, { extendedProperties: { private: props as unknown as Record<string, string> } }, scope);
  }

  /** Acknowledge the alert for this occurrence: stored locally and (when writable) on the event. */
  async acknowledge(inst: EventInstance): Promise<void> {
    const now = new Date().toISOString();
    const local = this.host.localAlerts.get();
    const snoozed = { ...local.snoozed };
    delete snoozed[inst.key];
    this.host.localAlerts.set({ acked: { ...local.acked, [inst.key]: now }, snoozed });
    if (!inst.permissions.canConfigure || !inst.tm) return;
    const target = inst.tmSource === 'instance' ? inst.event : (inst.master ?? inst.event);
    const cfg = parseTmConfig(target);
    if (!cfg) return;
    const next: TmConfig = { ...cfg, ack: { instanceStart: inst.instanceStart, at: now }, snooze: undefined };
    try {
      const patched = await this.client.patchEvent(inst.calendarId, target.id, {
        extendedProperties: { private: { tm_ack: `${inst.instanceStart}|${now}`, tm_snooze: null } as unknown as Record<string, string> },
      });
      await this.engine.upsertLocal(inst.calendarId, patched);
    } catch (e) {
      // Local ack still applies; remote mirror is best-effort.
      if (!(e instanceof GcalError)) throw e;
      await this.engine.upsertLocal(inst.calendarId, applyPrivatePropsPatch(target, serializeTmConfig(next)));
    }
  }

  async snooze(inst: EventInstance, minutes: number): Promise<void> {
    const until = new Date(Date.now() + minutes * 60_000).toISOString();
    const local = this.host.localAlerts.get();
    this.host.localAlerts.set({ ...local, snoozed: { ...local.snoozed, [inst.key]: until } });
    if (!inst.permissions.canConfigure || !inst.tm) return;
    const target = inst.tmSource === 'instance' ? inst.event : (inst.master ?? inst.event);
    try {
      const patched = await this.client.patchEvent(inst.calendarId, target.id, {
        extendedProperties: { private: { tm_snooze: `${inst.instanceStart}|${until}` } },
      });
      await this.engine.upsertLocal(inst.calendarId, patched);
    } catch (e) {
      if (!(e instanceof GcalError)) throw e;
    }
  }

  /** Delete with recurring scope. "instance" cancels one occurrence (an exception with status=cancelled). */
  async deleteEvent(inst: EventInstance, scope: EditScope = inst.isRecurring ? 'instance' : 'series'): Promise<void> {
    if (!inst.permissions.canDelete) throw new ReadOnlyEventError(inst.permissions.reason ?? 'Read-only event', inst);
    if (!inst.isRecurring || !inst.master) {
      await this.client.deleteEvent(inst.calendarId, inst.eventId);
      await this.engine.removeLocal(inst.calendarId, inst.eventId);
      return;
    }
    if (scope === 'series') {
      await this.client.deleteEvent(inst.calendarId, inst.master.id);
      await this.engine.removeLocal(inst.calendarId, inst.master.id);
      return;
    }
    if (scope === 'following') {
      await this.truncateSeriesBefore(inst);
      return;
    }
    const instanceId = await this.resolveInstanceId(inst);
    await this.client.deleteEvent(inst.calendarId, instanceId);
    // Google represents a deleted occurrence as a cancelled exception; mirror that locally.
    await this.engine.upsertLocal(inst.calendarId, {
      id: instanceId,
      status: 'cancelled',
      recurringEventId: inst.master.id,
      originalStartTime: inst.allDay ? { date: inst.instanceStart } : { dateTime: inst.instanceStart },
    });
  }

  // ---- internals -------------------------------------------------------

  private assertCanEditDetails(inst: EventInstance) {
    if (!inst.permissions.canEditDetails) {
      throw new ReadOnlyEventError(inst.permissions.reason ?? 'This event cannot be modified.', inst);
    }
  }

  private async patchWithScope(inst: EventInstance, patch: Partial<GcalEvent>, scope: EditScope): Promise<GcalEvent> {
    if (!inst.isRecurring || !inst.master) {
      const patched = await this.client.patchEvent(inst.calendarId, inst.eventId, patch);
      await this.engine.upsertLocal(inst.calendarId, patched);
      return patched;
    }
    if (scope === 'series') {
      const patched = await this.client.patchEvent(inst.calendarId, inst.master.id, patch);
      await this.engine.upsertLocal(inst.calendarId, patched);
      return patched;
    }
    if (scope === 'following') {
      return this.splitSeries(inst, patch);
    }
    const instanceId = await this.resolveInstanceId(inst);
    const patched = await this.client.patchEvent(inst.calendarId, instanceId, patch);
    await this.engine.upsertLocal(inst.calendarId, patched);
    return patched;
  }

  /** Google's ID for one occurrence, fetched from events.instances (creates nothing). */
  private async resolveInstanceId(inst: EventInstance): Promise<string> {
    if (inst.isException) return inst.eventId;
    const master = inst.master!;
    const originalStart = inst.allDay ? undefined : new Date(inst.instanceStart).toISOString();
    const res = await this.client.listInstances(inst.calendarId, master.id, {
      originalStart,
      timeMin: inst.allDay ? new Date(inst.start.getTime() - DAY).toISOString() : undefined,
      timeMax: inst.allDay ? new Date(inst.start.getTime() + DAY).toISOString() : undefined,
      maxResults: 10,
      showDeleted: true,
    });
    const match = (res.items ?? []).find((e) => {
      const o = e.originalStartTime;
      if (!o) return false;
      if (inst.allDay) return o.date === inst.instanceStart;
      return o.dateTime ? new Date(o.dateTime).toISOString() === inst.instanceStart : false;
    });
    if (!match) throw new Error('Could not find this occurrence in Google Calendar (it may have been deleted).');
    return match.id;
  }

  /** Shorten the series so it ends before this occurrence. */
  private async truncateSeriesBefore(inst: EventInstance): Promise<GcalEvent> {
    const master = inst.master!;
    const untilUtc = new Date(inst.start.getTime() - 1000);
    const recurrence = withUntil(master.recurrence ?? [], untilUtc, inst.allDay);
    const patched = await this.client.patchEvent(inst.calendarId, master.id, { recurrence });
    await this.engine.upsertLocal(inst.calendarId, patched);
    return patched;
  }

  /** "This and following": truncate the old series and start a new one from this occurrence. */
  private async splitSeries(inst: EventInstance, patch: Partial<GcalEvent>): Promise<GcalEvent> {
    const master = inst.master!;
    const tz = inst.timeZone;
    const mt = eventTiming(master, tz);
    if (!mt) throw new Error('Cannot read series timing');
    const duration = mt.end.getTime() - mt.start.getTime();
    // Count occurrences consumed before the split (for COUNT rules).
    const before = expandRecurrence(master, new Date(mt.start.getTime() - 1), inst.start, tz, 100000) ?? [];
    const newRecurrence = (master.recurrence ?? []).map((line) => {
      if (!/^RRULE/i.test(line)) return line;
      const parts = line
        .replace(/^RRULE:/i, '')
        .split(';')
        .filter((p) => !/^UNTIL=/i.test(p))
        .map((p) => {
          const m = /^COUNT=(\d+)$/i.exec(p);
          if (m) return `COUNT=${Math.max(1, Number(m[1]) - before.length)}`;
          return p;
        });
      return `RRULE:${parts.join(';')}`;
    });
    const newEvent: Partial<GcalEvent> = {
      summary: master.summary,
      description: master.description,
      location: master.location,
      colorId: master.colorId,
      transparency: master.transparency,
      visibility: master.visibility,
      reminders: master.reminders,
      extendedProperties: master.extendedProperties ? { private: { ...(master.extendedProperties.private ?? {}) } } : undefined,
      recurrence: newRecurrence,
      start: gcalTime(inst.start, inst.allDay, tz),
      end: gcalTime(new Date(inst.start.getTime() + duration), inst.allDay, tz),
      ...patch,
    };
    if (patch.extendedProperties?.private) {
      const priv = { ...(master.extendedProperties?.private ?? {}) };
      for (const [k, v] of Object.entries(patch.extendedProperties.private)) {
        if (v === null || v === undefined) delete priv[k];
        else priv[k] = v;
      }
      newEvent.extendedProperties = { private: priv };
    }
    const created = await this.client.insertEvent(inst.calendarId, newEvent);
    await this.truncateSeriesBefore(inst);
    await this.engine.upsertLocal(inst.calendarId, created);
    return created;
  }
}

/** Replace/insert UNTIL in the RRULE line(s). */
export function withUntil(recurrence: string[], untilUtc: Date, allDay: boolean): string[] {
  const p = (n: number) => String(n).padStart(2, '0');
  const u = allDay
    ? `${untilUtc.getUTCFullYear()}${p(untilUtc.getUTCMonth() + 1)}${p(untilUtc.getUTCDate())}`
    : `${untilUtc.getUTCFullYear()}${p(untilUtc.getUTCMonth() + 1)}${p(untilUtc.getUTCDate())}T${p(untilUtc.getUTCHours())}${p(untilUtc.getUTCMinutes())}${p(untilUtc.getUTCSeconds())}Z`;
  return recurrence.map((line) => {
    if (!/^RRULE/i.test(line)) return line;
    const parts = line
      .replace(/^RRULE:/i, '')
      .split(';')
      .filter((x) => !/^(UNTIL|COUNT)=/i.test(x));
    parts.push(`UNTIL=${u}`);
    return `RRULE:${parts.join(';')}`;
  });
}

export { formatReminderBody };
