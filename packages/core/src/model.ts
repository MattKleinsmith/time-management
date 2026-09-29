/**
 * The core view model: concrete event instances derived from the Google
 * Calendar cache (singles, expanded recurring occurrences, exceptions).
 */
import { hasTmMetadata, parseTmConfig, type TmConfig } from './metadata';
import { eventTiming, expandRecurrence, instanceStartKey, originalStartKey } from './recurrence';
import type { GcalAccessRole, GcalCalendarListEntry, GcalEvent } from './types';

export interface Permissions {
  /** Calendar allows writes at all. */
  calendarWritable: boolean;
  /** The user may change title/time/etc. (organizer, or guests may modify). */
  canEditDetails: boolean;
  /** The user may attach private extended properties to their copy of the event. */
  canConfigure: boolean;
  /** The user may delete the event from this calendar. */
  canDelete: boolean;
  /** Short explanation when something is not allowed. */
  reason?: string;
}

export interface EventInstance {
  /** Stable unique key: calendarId/eventId/instanceStart */
  key: string;
  calendarId: string;
  /** ID of the concrete Google event backing this instance (exception id or master id). */
  eventId: string;
  /** Master (series) event ID when this instance belongs to a series. */
  masterId?: string;
  /** Instance key used for acknowledgement bookkeeping (YYYY-MM-DD for all-day). */
  instanceStart: string;
  isRecurring: boolean;
  isException: boolean;
  start: Date;
  end: Date;
  allDay: boolean;
  timeZone: string;
  title: string;
  description?: string;
  location?: string;
  status: 'confirmed' | 'tentative';
  colorId?: string;
  /** The Google event this instance was derived from (exception or master). */
  event: GcalEvent;
  master?: GcalEvent;
  /** Time Manager config (own or inherited from the series). Null for ordinary events. */
  tm: TmConfig | null;
  tmSource: 'instance' | 'series' | null;
  permissions: Permissions;
  calendar: GcalCalendarListEntry;
}

export interface CalendarSnapshot {
  calendar: GcalCalendarListEntry;
  events: Record<string, GcalEvent>;
}

const WRITE_ROLES: GcalAccessRole[] = ['owner', 'writer', 'writerWithoutPrivateAccess'];

export function computePermissions(ev: GcalEvent, calendar: GcalCalendarListEntry): Permissions {
  const calendarWritable = WRITE_ROLES.includes(calendar.accessRole);
  if (!calendarWritable) {
    return {
      calendarWritable: false,
      canEditDetails: false,
      canConfigure: false,
      canDelete: false,
      reason: `You have "${calendar.accessRole}" access to this calendar, so Google will not let this event be modified.`,
    };
  }
  if (calendar.accessRole === 'writerWithoutPrivateAccess' && ev.visibility === 'private') {
    return {
      calendarWritable: true,
      canEditDetails: false,
      canConfigure: false,
      canDelete: false,
      reason: 'This is a private event on a calendar where you cannot edit private events.',
    };
  }
  const isOrganizer = ev.organizer?.self !== false || !ev.attendees?.length;
  const locked = ev.locked === true;
  const canEditDetails = !locked && (isOrganizer || ev.guestsCanModify === true);
  const perms: Permissions = {
    calendarWritable: true,
    canEditDetails,
    canConfigure: true,
    canDelete: true,
  };
  if (!canEditDetails) {
    perms.reason = locked
      ? 'This event is locked by Google and its main fields cannot be changed.'
      : 'You are a guest on this event; only the organizer can change its details. Time Manager settings are stored on your own copy and still work.';
  }
  return perms;
}

export interface BuildInstancesOptions {
  windowStart: Date;
  windowEnd: Date;
  /** Fallback zone for events lacking a timeZone. */
  timeZone: string;
  /** Include events with status "tentative". Default true. */
  includeTentative?: boolean;
}

/**
 * Build the flat list of instances for a window from a set of calendar snapshots.
 */
export function buildInstances(snapshots: CalendarSnapshot[], opts: BuildInstancesOptions): EventInstance[] {
  const out: EventInstance[] = [];
  const { windowStart, windowEnd } = opts;
  for (const snap of snapshots) {
    const events = Object.values(snap.events);
    const exceptionsByMaster = new Map<string, GcalEvent[]>();
    for (const ev of events) {
      if (ev.recurringEventId) {
        const list = exceptionsByMaster.get(ev.recurringEventId) ?? [];
        list.push(ev);
        exceptionsByMaster.set(ev.recurringEventId, list);
      }
    }
    for (const ev of events) {
      if (ev.recurringEventId) continue; // handled via master
      if (ev.status === 'cancelled') continue;
      if (ev.status === 'tentative' && opts.includeTentative === false) continue;
      if (ev.recurrence?.length) {
        expandSeries(ev, exceptionsByMaster.get(ev.id) ?? [], snap, opts, out);
      } else {
        const timing = eventTiming(ev, opts.timeZone);
        if (!timing) continue;
        if (timing.end.getTime() <= windowStart.getTime() || timing.start.getTime() >= windowEnd.getTime()) continue;
        out.push(makeInstance(snap, ev, undefined, timing.start, timing.end, timing.allDay, timing.timeZone, false));
      }
    }
    // Orphan exceptions (master not in cache, e.g. master on a different calendar) are ignored.
  }
  out.sort((a, b) => a.start.getTime() - b.start.getTime() || a.end.getTime() - b.end.getTime());
  return out;
}

function expandSeries(
  master: GcalEvent,
  exceptions: GcalEvent[],
  snap: CalendarSnapshot,
  opts: BuildInstancesOptions,
  out: EventInstance[],
) {
  const { windowStart, windowEnd } = opts;
  const timing = eventTiming(master, opts.timeZone);
  if (!timing) return;
  const duration = timing.end.getTime() - timing.start.getTime();
  // Expand a slightly earlier window so long instances that started before the window still show.
  const expandFrom = new Date(windowStart.getTime() - Math.max(duration, 0));
  const occurrences = expandRecurrence(master, expandFrom, windowEnd, opts.timeZone) ?? [];
  const exByKey = new Map<string, GcalEvent>();
  for (const ex of exceptions) {
    const k = originalStartKey(ex.originalStartTime);
    if (k) exByKey.set(k, ex);
  }
  const emitted = new Set<string>();
  for (const occ of occurrences) {
    const k = timing.allDay ? instanceStartKey(occ.start, true) : occ.start.toISOString();
    const ex = exByKey.get(k);
    if (ex) {
      emitted.add(k);
      if (ex.status === 'cancelled') continue;
      const exTiming = eventTiming(ex, opts.timeZone);
      if (!exTiming) continue;
      if (exTiming.end.getTime() <= windowStart.getTime() || exTiming.start.getTime() >= windowEnd.getTime()) continue;
      out.push(makeInstance(snap, ex, master, exTiming.start, exTiming.end, exTiming.allDay, exTiming.timeZone, true, k));
      continue;
    }
    if (occ.end.getTime() <= windowStart.getTime() || occ.start.getTime() >= windowEnd.getTime()) continue;
    out.push(makeInstance(snap, master, master, occ.start, occ.end, timing.allDay, timing.timeZone, false, k));
  }
  // Exceptions moved into the window from outside it.
  for (const [k, ex] of exByKey) {
    if (emitted.has(k) || ex.status === 'cancelled') continue;
    const exTiming = eventTiming(ex, opts.timeZone);
    if (!exTiming) continue;
    if (exTiming.end.getTime() <= windowStart.getTime() || exTiming.start.getTime() >= windowEnd.getTime()) continue;
    out.push(makeInstance(snap, ex, master, exTiming.start, exTiming.end, exTiming.allDay, exTiming.timeZone, true, k));
  }
}

function makeInstance(
  snap: CalendarSnapshot,
  ev: GcalEvent,
  master: GcalEvent | undefined,
  start: Date,
  end: Date,
  allDay: boolean,
  timeZone: string,
  isException: boolean,
  originalKey?: string,
): EventInstance {
  const instanceStart = originalKey ?? instanceStartKey(start, allDay);
  let tm: TmConfig | null = null;
  let tmSource: EventInstance['tmSource'] = null;
  if (master && master !== ev) {
    // Exception: use its own config only when explicitly marked, else inherit.
    const own = parseTmConfig(ev);
    if (own?.own) {
      tm = own;
      tmSource = 'instance';
    } else if (hasTmMetadata(master)) {
      tm = parseTmConfig(master);
      tmSource = 'series';
    }
  } else if (hasTmMetadata(ev)) {
    tm = parseTmConfig(ev);
    tmSource = master ? 'series' : 'instance';
  }
  return {
    key: `${snap.calendar.id}/${master ? master.id : ev.id}/${instanceStart}`,
    calendarId: snap.calendar.id,
    eventId: ev.id,
    masterId: master?.id,
    instanceStart,
    isRecurring: !!master,
    isException,
    start,
    end,
    allDay,
    timeZone,
    title: ev.summary?.trim() || '(No title)',
    description: ev.description,
    location: ev.location,
    status: ev.status === 'tentative' ? 'tentative' : 'confirmed',
    colorId: ev.colorId,
    event: ev,
    master,
    tm,
    tmSource,
    permissions: computePermissions(ev, snap.calendar),
    calendar: snap.calendar,
  };
}

/** The instance happening at `now` (longest-running first if several overlap). */
export function currentInstance(instances: EventInstance[], now: Date): EventInstance | undefined {
  const t = now.getTime();
  return instances
    .filter((i) => !i.allDay && i.start.getTime() <= t && i.end.getTime() > t)
    .sort((a, b) => a.start.getTime() - b.start.getTime())[0];
}

/** The next instance starting after `now`. */
export function nextInstance(instances: EventInstance[], now: Date): EventInstance | undefined {
  const t = now.getTime();
  return instances.filter((i) => !i.allDay && i.start.getTime() > t).sort((a, b) => a.start.getTime() - b.start.getTime())[0];
}
