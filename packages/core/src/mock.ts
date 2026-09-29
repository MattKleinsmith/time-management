/**
 * In-memory Google Calendar API simulator: sync tokens, pagination, 410 on
 * expired tokens, instance lookup. Used by tests and by the web "mock mode".
 */
import { expandRecurrence, instanceStartKey } from './recurrence';
import {
  GcalError,
  type EventsListParams,
  type GcalCalendarListEntry,
  type GcalClient,
  type GcalEvent,
  type GcalEventsListResponse,
} from './types';

interface Change {
  seq: number;
  event: GcalEvent;
}

export class MockGcalClient implements GcalClient {
  calendars: GcalCalendarListEntry[] = [];
  private events = new Map<string, Map<string, GcalEvent>>();
  private log = new Map<string, Change[]>();
  private seq = 0;
  private tokenBase = 0;
  /** Requests observed (for tests). */
  requests: { method: string; path: string; params?: unknown; body?: unknown }[] = [];
  pageSize = 2500;
  failNext: GcalError | null = null;

  addCalendar(cal: GcalCalendarListEntry) {
    this.calendars.push(cal);
    this.events.set(cal.id, new Map());
    this.log.set(cal.id, []);
  }

  seed(calendarId: string, ev: GcalEvent) {
    const e = { ...ev, etag: `"${++this.seq}"`, updated: new Date().toISOString() };
    this.events.get(calendarId)!.set(e.id, e);
    this.log.get(calendarId)!.push({ seq: this.seq, event: e });
    return e;
  }

  /** Simulate a change made directly in Google Calendar. */
  external(calendarId: string, ev: GcalEvent) {
    return this.seed(calendarId, ev);
  }

  expireSyncTokens() {
    this.tokenBase = this.seq + 1;
  }

  private check() {
    if (this.failNext) {
      const e = this.failNext;
      this.failNext = null;
      throw e;
    }
  }

  async listCalendars() {
    this.requests.push({ method: 'GET', path: 'calendarList' });
    return this.calendars.map((c) => ({ ...c }));
  }

  async listEvents(calendarId: string, params: EventsListParams): Promise<GcalEventsListResponse> {
    this.requests.push({ method: 'GET', path: `events:${calendarId}`, params });
    this.check();
    const cal = this.events.get(calendarId);
    if (!cal) throw new GcalError(404, 'Not Found');
    if (params.syncToken) {
      if (params.timeMin || params.timeMax) throw new GcalError(400, 'syncToken cannot be used with timeMin/timeMax');
      if (params.showDeleted === false) throw new GcalError(400, 'showDeleted cannot be false when syncToken is set');
      const [, tokenSeqStr] = params.syncToken.split(':');
      const tokenSeq = Number(tokenSeqStr);
      if (tokenSeq < this.tokenBase) throw new GcalError(410, 'Sync token is no longer valid, a full sync is required.');
      const changes = this.log.get(calendarId)!.filter((c) => c.seq > tokenSeq);
      const latest = new Map<string, GcalEvent>();
      for (const c of changes) latest.set(c.event.id, c.event);
      const all = [...latest.values()];
      return this.paginate(all, params.pageToken, `sync:${this.seq}`);
    }
    const all = [...cal.values()].filter((e) => e.status !== 'cancelled' || (params.showDeleted ?? false) || !!e.recurringEventId);
    return this.paginate(all, params.pageToken, `sync:${this.seq}`);
  }

  private paginate(all: GcalEvent[], pageToken: string | undefined, syncToken: string): GcalEventsListResponse {
    const offset = pageToken ? Number(pageToken) : 0;
    const items = all.slice(offset, offset + this.pageSize).map((e) => structuredClone(e));
    const next = offset + this.pageSize;
    if (next < all.length) return { items, nextPageToken: String(next) };
    return { items, nextSyncToken: syncToken };
  }

  async getEvent(calendarId: string, eventId: string) {
    const ev = this.events.get(calendarId)?.get(eventId);
    if (!ev) throw new GcalError(404, 'Not Found');
    return structuredClone(ev);
  }

  async insertEvent(calendarId: string, event: Partial<GcalEvent>) {
    this.requests.push({ method: 'POST', path: `events:${calendarId}`, body: event });
    this.check();
    const id = event.id ?? `ev${++this.seq}`;
    return structuredClone(this.seed(calendarId, { status: 'confirmed', ...event, id } as GcalEvent));
  }

  async patchEvent(calendarId: string, eventId: string, patch: Partial<GcalEvent>) {
    this.requests.push({ method: 'PATCH', path: `events:${calendarId}/${eventId}`, body: patch });
    this.check();
    const cal = this.events.get(calendarId)!;
    let ev = cal.get(eventId);
    if (!ev) {
      // Patching an instance id materialises an exception (like Google).
      ev = this.materializeInstance(calendarId, eventId);
      if (!ev) throw new GcalError(404, 'Not Found');
    }
    const merged: GcalEvent = { ...ev };
    for (const [k, v] of Object.entries(patch)) {
      if (k === 'extendedProperties') {
        const priv = { ...(ev.extendedProperties?.private ?? {}) };
        for (const [pk, pv] of Object.entries((v as { private?: Record<string, string | null> })?.private ?? {})) {
          if (pv === null || pv === undefined) delete priv[pk];
          else priv[pk] = pv;
        }
        merged.extendedProperties = { ...(ev.extendedProperties ?? {}), private: priv };
      } else if (v === null) {
        delete (merged as Record<string, unknown>)[k];
      } else {
        (merged as Record<string, unknown>)[k] = structuredClone(v);
      }
    }
    return structuredClone(this.seed(calendarId, merged));
  }

  async updateEvent(calendarId: string, eventId: string, event: GcalEvent) {
    this.requests.push({ method: 'PUT', path: `events:${calendarId}/${eventId}`, body: event });
    return structuredClone(this.seed(calendarId, { ...event, id: eventId }));
  }

  async deleteEvent(calendarId: string, eventId: string) {
    this.requests.push({ method: 'DELETE', path: `events:${calendarId}/${eventId}` });
    this.check();
    const cal = this.events.get(calendarId)!;
    let ev = cal.get(eventId) ?? this.materializeInstance(calendarId, eventId);
    if (!ev) throw new GcalError(404, 'Not Found');
    this.seed(calendarId, { ...ev, status: 'cancelled' });
    if (!ev.recurringEventId) {
      for (const e of cal.values()) if (e.recurringEventId === eventId && e.status !== 'cancelled') this.seed(calendarId, { ...e, status: 'cancelled' });
    }
  }

  async listInstances(calendarId: string, eventId: string, params: { timeMin?: string; timeMax?: string; originalStart?: string }) {
    this.requests.push({ method: 'GET', path: `instances:${calendarId}/${eventId}`, params });
    const cal = this.events.get(calendarId)!;
    const master = cal.get(eventId);
    if (!master) throw new GcalError(404, 'Not Found');
    const tz = master.start?.timeZone ?? 'UTC';
    const from = params.originalStart ? new Date(new Date(params.originalStart).getTime() - 1) : params.timeMin ? new Date(params.timeMin) : new Date(0);
    const to = params.originalStart ? new Date(new Date(params.originalStart).getTime() + 1) : params.timeMax ? new Date(params.timeMax) : new Date(8.64e15 / 2);
    const occ = expandRecurrence(master, from, to, tz) ?? [];
    const items: GcalEvent[] = occ.map((o) => this.instanceFor(master, o.start, o.end, !!master.start?.date));
    return { items };
  }

  private instanceId(masterId: string, start: Date, allDay: boolean) {
    const p = (n: number) => String(n).padStart(2, '0');
    if (allDay) return `${masterId}_${instanceStartKey(start, true).replace(/-/g, '')}`;
    return `${masterId}_${start.getUTCFullYear()}${p(start.getUTCMonth() + 1)}${p(start.getUTCDate())}T${p(start.getUTCHours())}${p(start.getUTCMinutes())}${p(start.getUTCSeconds())}Z`;
  }

  private instanceFor(master: GcalEvent, start: Date, end: Date, allDay: boolean): GcalEvent {
    const id = this.instanceId(master.id, start, allDay);
    const cal = this.events.get(this.calendarOf(master.id))!;
    const existing = cal.get(id);
    if (existing) return structuredClone(existing);
    const { recurrence: _r, ...rest } = master;
    return {
      ...structuredClone(rest),
      id,
      recurringEventId: master.id,
      originalStartTime: allDay ? { date: instanceStartKey(start, true) } : { dateTime: start.toISOString(), timeZone: master.start?.timeZone },
      start: allDay ? { date: instanceStartKey(start, true) } : { dateTime: start.toISOString(), timeZone: master.start?.timeZone },
      end: allDay ? { date: instanceStartKey(end, true) } : { dateTime: end.toISOString(), timeZone: master.start?.timeZone },
    };
  }

  private calendarOf(eventId: string): string {
    for (const [cid, m] of this.events) if (m.has(eventId)) return cid;
    throw new GcalError(404, 'Not Found');
  }

  private materializeInstance(calendarId: string, instanceId: string): GcalEvent | undefined {
    const idx = instanceId.lastIndexOf('_');
    if (idx < 0) return undefined;
    const masterId = instanceId.slice(0, idx);
    const stamp = instanceId.slice(idx + 1);
    const master = this.events.get(calendarId)?.get(masterId);
    if (!master?.recurrence) return undefined;
    const allDay = !!master.start?.date;
    let start: Date;
    if (allDay) {
      start = new Date(+stamp.slice(0, 4), +stamp.slice(4, 6) - 1, +stamp.slice(6, 8));
    } else {
      start = new Date(
        Date.UTC(+stamp.slice(0, 4), +stamp.slice(4, 6) - 1, +stamp.slice(6, 8), +stamp.slice(9, 11), +stamp.slice(11, 13), +stamp.slice(13, 15)),
      );
    }
    const dur = new Date(master.end!.dateTime ?? master.end!.date!).getTime() - new Date(master.start!.dateTime ?? master.start!.date!).getTime();
    return this.instanceFor(master, start, new Date(start.getTime() + dur), allDay);
  }
}
