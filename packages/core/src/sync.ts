/**
 * Google Calendar synchronisation: initial full sync, then incremental sync
 * with sync tokens (https://developers.google.com/workspace/calendar/api/guides/sync).
 *
 * The local store is a cache that lets incremental sync work and the UI render
 * offline. Google Calendar remains the source of truth.
 */
import type { CalendarSnapshot } from './model';
import { GcalError, type GcalCalendarListEntry, type GcalClient, type GcalEvent, type EventsListParams } from './types';

export interface CalendarSyncState {
  calendar: GcalCalendarListEntry;
  syncToken?: string;
  events: Record<string, GcalEvent>;
  lastFullSync?: string;
  lastSync?: string;
}

export interface SyncSnapshot {
  version: 1;
  calendars: Record<string, CalendarSyncState>;
  /** Calendar IDs the user chose to sync (empty = all writable + selected). */
  savedAt: string;
}

export interface SyncPersistence {
  load(): Promise<SyncSnapshot | null>;
  save(snapshot: SyncSnapshot): Promise<void>;
  clear(): Promise<void>;
}

export class MemoryPersistence implements SyncPersistence {
  private snap: SyncSnapshot | null = null;
  async load() {
    return this.snap ? structuredClone(this.snap) : null;
  }
  async save(s: SyncSnapshot) {
    this.snap = structuredClone(s);
  }
  async clear() {
    this.snap = null;
  }
}

export interface SyncOptions {
  /** Calendar IDs to sync. If omitted, every calendar the account lists (not hidden) is synced. */
  calendarIds?: string[];
  /** Called after each calendar finishes so the UI can render progressively. */
  onProgress?: (info: { calendarId: string; phase: 'full' | 'incremental'; events: number }) => void;
}

export interface SyncResult {
  calendars: GcalCalendarListEntry[];
  changed: boolean;
  fullSyncs: string[];
  errors: { calendarId: string; error: unknown }[];
}

/**
 * Query parameters that must be identical across every request in a sync cycle.
 * showDeleted must not be false when a syncToken is used (Google returns 400),
 * so it is true for the initial full sync as well; cancelled single events are
 * simply skipped when applied.
 */
const BASE_PARAMS: EventsListParams = { maxResults: 2500, singleEvents: false, showDeleted: true };

export class SyncEngine {
  private state: SyncSnapshot = { version: 1, calendars: {}, savedAt: new Date(0).toISOString() };
  private loaded = false;

  constructor(
    private readonly client: GcalClient,
    private readonly persistence: SyncPersistence,
  ) {}

  async load(): Promise<SyncSnapshot> {
    if (!this.loaded) {
      const s = await this.persistence.load();
      if (s && s.version === 1) this.state = s;
      this.loaded = true;
    }
    return this.state;
  }

  get snapshot(): SyncSnapshot {
    return this.state;
  }

  getCalendarSnapshots(): CalendarSnapshot[] {
    return Object.values(this.state.calendars).map((c) => ({ calendar: c.calendar, events: c.events }));
  }

  getEvent(calendarId: string, eventId: string): GcalEvent | undefined {
    return this.state.calendars[calendarId]?.events[eventId];
  }

  /** Apply a server response (insert/patch/get result) to the cache immediately. */
  async upsertLocal(calendarId: string, ev: GcalEvent): Promise<void> {
    const cal = this.state.calendars[calendarId];
    if (!cal) return;
    if (ev.status === 'cancelled' && !ev.recurringEventId) delete cal.events[ev.id];
    else cal.events[ev.id] = ev;
    await this.persist();
  }

  async removeLocal(calendarId: string, eventId: string): Promise<void> {
    const cal = this.state.calendars[calendarId];
    if (!cal) return;
    delete cal.events[eventId];
    // Exceptions of a deleted series are gone too.
    for (const [id, ev] of Object.entries(cal.events)) {
      if (ev.recurringEventId === eventId) delete cal.events[id];
    }
    await this.persist();
  }

  async reset(): Promise<void> {
    this.state = { version: 1, calendars: {}, savedAt: new Date().toISOString() };
    await this.persistence.clear();
  }

  /** Full or incremental sync of every selected calendar. */
  async sync(opts: SyncOptions = {}): Promise<SyncResult> {
    await this.load();
    const calendars = await this.client.listCalendars();
    const wanted = calendars.filter((c) => !c.deleted && (opts.calendarIds ? opts.calendarIds.includes(c.id) : !c.hidden));
    const result: SyncResult = { calendars, changed: false, fullSyncs: [], errors: [] };

    // Drop calendars that disappeared or were deselected.
    for (const id of Object.keys(this.state.calendars)) {
      if (!wanted.some((c) => c.id === id)) {
        delete this.state.calendars[id];
        result.changed = true;
      }
    }

    for (const cal of wanted) {
      const existing = this.state.calendars[cal.id];
      const st: CalendarSyncState = existing ?? { calendar: cal, events: {} };
      st.calendar = cal;
      this.state.calendars[cal.id] = st;
      try {
        const r = await this.syncCalendar(st);
        if (r.changed) result.changed = true;
        if (r.full) result.fullSyncs.push(cal.id);
        opts.onProgress?.({ calendarId: cal.id, phase: r.full ? 'full' : 'incremental', events: Object.keys(st.events).length });
      } catch (error) {
        result.errors.push({ calendarId: cal.id, error });
      }
    }
    await this.persist();
    return result;
  }

  private async syncCalendar(st: CalendarSyncState): Promise<{ changed: boolean; full: boolean }> {
    if (st.syncToken) {
      try {
        const changed = await this.runListLoop(st, { ...BASE_PARAMS, syncToken: st.syncToken });
        st.lastSync = new Date().toISOString();
        return { changed, full: false };
      } catch (e) {
        if (e instanceof GcalError && e.status === 410) {
          // Sync token expired: clear and perform a full sync (per Google docs).
          st.events = {};
          st.syncToken = undefined;
        } else {
          throw e;
        }
      }
    }
    st.events = {};
    await this.runListLoop(st, { ...BASE_PARAMS });
    st.lastFullSync = new Date().toISOString();
    st.lastSync = st.lastFullSync;
    return { changed: true, full: true };
  }

  private async runListLoop(st: CalendarSyncState, params: EventsListParams): Promise<boolean> {
    let pageToken: string | undefined;
    let changed = false;
    for (let guard = 0; guard < 500; guard++) {
      const res = await this.client.listEvents(st.calendar.id, { ...params, pageToken });
      for (const ev of res.items ?? []) {
        if (applyEvent(st.events, ev)) changed = true;
      }
      if (res.nextPageToken) {
        pageToken = res.nextPageToken;
        continue;
      }
      if (res.nextSyncToken) st.syncToken = res.nextSyncToken;
      return changed;
    }
    throw new Error('sync: too many pages');
  }

  private async persist() {
    this.state.savedAt = new Date().toISOString();
    await this.persistence.save(this.state);
  }
}

/** Merge one listed event into the cache. Returns true if the cache changed. */
export function applyEvent(events: Record<string, GcalEvent>, ev: GcalEvent): boolean {
  if (!ev.id) return false;
  if (ev.status === 'cancelled') {
    if (ev.recurringEventId) {
      // Cancelled exception: keep it so the occurrence is suppressed during expansion.
      const prev = events[ev.id];
      if (prev && prev.status === 'cancelled' && prev.etag === ev.etag) return false;
      events[ev.id] = ev;
      return true;
    }
    if (events[ev.id]) {
      delete events[ev.id];
      // A deleted series takes its exceptions with it.
      for (const [id, e] of Object.entries(events)) if (e.recurringEventId === ev.id) delete events[id];
      return true;
    }
    return false;
  }
  const prev = events[ev.id];
  if (prev && prev.etag && prev.etag === ev.etag) return false;
  events[ev.id] = ev;
  return true;
}
