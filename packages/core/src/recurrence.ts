/**
 * Client-side expansion of Google Calendar recurring events.
 *
 * Google returns (with singleEvents=false) the recurring "master" event plus
 * exception events (recurringEventId + originalStartTime, possibly cancelled).
 * We expand the master's RRULE/RDATE/EXDATE lines with `rrule` in the event's
 * own time zone and overlay the exceptions.
 */
import * as rruleNs from 'rrule';
import type { RRuleSet } from 'rrule';

// rrule ships a CJS `main` and an ESM `module`; Node ESM sees only `default`.
const rrulePkg = ((rruleNs as unknown as { rrulestr?: unknown }).rrulestr ? rruleNs : (rruleNs as unknown as { default: typeof rruleNs }).default) as typeof rruleNs;
const rrulestr = rrulePkg.rrulestr;
import type { GcalDateTime, GcalEvent } from './types';
import { DAY, fromFakeUtc, isValidTimeZone, parseDateOnly, toFakeUtc, toWallClock } from './time';

export interface EventTiming {
  start: Date;
  end: Date;
  allDay: boolean;
  /** IANA zone the event's wall clock is expressed in. */
  timeZone: string;
}

/** Resolve start/end of a (non-expanded) event into instants. */
export function eventTiming(ev: GcalEvent, fallbackTz: string): EventTiming | null {
  const s = ev.start;
  const e = ev.end;
  if (!s) return null;
  const tz = isValidTimeZone(s.timeZone) ? s.timeZone : fallbackTz;
  if (s.date) {
    const start = parseDateOnly(s.date);
    const end = e?.date ? parseDateOnly(e.date) : new Date(start.getTime() + DAY);
    // All-day events are floating dates; we anchor them to the device's local midnight.
    return { start: localMidnight(start), end: localMidnight(end), allDay: true, timeZone: tz };
  }
  if (s.dateTime) {
    const start = new Date(s.dateTime);
    const end = e?.dateTime ? new Date(e.dateTime) : new Date(start.getTime() + 30 * 60_000);
    if (Number.isNaN(start.getTime())) return null;
    return { start, end: Number.isNaN(end.getTime()) ? start : end, allDay: false, timeZone: tz };
  }
  return null;
}

function localMidnight(fakeUtcDate: Date): Date {
  return new Date(fakeUtcDate.getUTCFullYear(), fakeUtcDate.getUTCMonth(), fakeUtcDate.getUTCDate());
}

/** Canonical key for an originalStartTime / instance start so exceptions can be matched. */
export function originalStartKey(t: GcalDateTime | undefined): string | null {
  if (!t) return null;
  if (t.date) return t.date;
  if (t.dateTime) {
    const d = new Date(t.dateTime);
    return Number.isNaN(d.getTime()) ? null : d.toISOString();
  }
  return null;
}

export function instanceStartKey(start: Date, allDay: boolean): string {
  if (allDay) {
    const y = start.getFullYear();
    const m = String(start.getMonth() + 1).padStart(2, '0');
    const d = String(start.getDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
  }
  return start.toISOString();
}

const DT_RE = /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})(Z?))?$/;

function fakeStamp(fake: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${fake.getUTCFullYear()}${p(fake.getUTCMonth() + 1)}${p(fake.getUTCDate())}T${p(fake.getUTCHours())}${p(fake.getUTCMinutes())}${p(fake.getUTCSeconds())}Z`;
}

/**
 * Rewrite date values inside recurrence lines into the "fake UTC" wall-clock
 * frame of `tz` so a single rrule set can be evaluated without tz support.
 */
export function normalizeRecurrenceLines(lines: string[], tz: string, allDay: boolean): string[] {
  const out: string[] = [];
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    const colon = line.indexOf(':');
    if (colon < 0) continue;
    const head = line.slice(0, colon);
    const value = line.slice(colon + 1);
    const [name, ...paramParts] = head.split(';');
    const params: Record<string, string> = {};
    for (const p of paramParts) {
      const [k, v] = p.split('=');
      if (k) params[k.toUpperCase()] = v ?? '';
    }
    const upper = name.toUpperCase();
    if (upper === 'RRULE' || upper === 'EXRULE') {
      const parts = value.split(';').map((part) => {
        const [k, v] = part.split('=');
        if (k?.toUpperCase() === 'UNTIL' && v) return `UNTIL=${normalizeDateValue(v, params.TZID || tz, tz, allDay)}`;
        return part;
      });
      out.push(`${upper}:${parts.join(';')}`);
    } else if (upper === 'RDATE' || upper === 'EXDATE') {
      const vals = value
        .split(',')
        .map((v) => normalizeDateValue(v.trim(), params.TZID || tz, tz, allDay))
        .filter(Boolean);
      if (vals.length) out.push(`${upper}:${vals.join(',')}`);
    }
  }
  return out;
}

function normalizeDateValue(v: string, valueTz: string, targetTz: string, allDay: boolean): string {
  const m = DT_RE.exec(v);
  if (!m) return v;
  const [, y, mo, d, h, mi, s, z] = m;
  if (!h) {
    // DATE value: rrule wants a time, so use midnight in the wall-clock frame.
    return `${y}${mo}${d}T000000Z`;
  }
  let instant: Date;
  if (z === 'Z') {
    instant = new Date(Date.UTC(+y, +mo - 1, +d, +h, +mi, +s));
  } else {
    const zone = isValidTimeZone(valueTz) ? valueTz : targetTz;
    instant = fromFakeUtc(new Date(Date.UTC(+y, +mo - 1, +d, +h, +mi, +s)), zone);
  }
  const fake = toFakeUtc(instant, targetTz);
  const p = (n: number) => String(n).padStart(2, '0');
  const dateStr = `${fake.getUTCFullYear()}${p(fake.getUTCMonth() + 1)}${p(fake.getUTCDate())}`;
  if (allDay) return `${dateStr}T000000Z`;
  return `${dateStr}T${p(fake.getUTCHours())}${p(fake.getUTCMinutes())}${p(fake.getUTCSeconds())}Z`;
}

export interface ExpandedOccurrence {
  start: Date;
  end: Date;
}

/**
 * Expand a recurring master into occurrences whose start falls in [windowStart, windowEnd).
 * Returns null if the event is not recurring or cannot be parsed.
 */
export function expandRecurrence(
  master: GcalEvent,
  windowStart: Date,
  windowEnd: Date,
  fallbackTz: string,
  maxOccurrences = 2000,
): ExpandedOccurrence[] | null {
  if (!master.recurrence?.length) return null;
  const timing = eventTiming(master, fallbackTz);
  if (!timing) return null;
  const tz = timing.timeZone;
  const duration = timing.end.getTime() - timing.start.getTime();
  const allDay = timing.allDay;
  const dtstart = allDay
    ? new Date(Date.UTC(timing.start.getFullYear(), timing.start.getMonth(), timing.start.getDate()))
    : toFakeUtc(timing.start, tz);
  let set: RRuleSet;
  try {
    // rrulestr ignores the `dtstart` option for sets, so pass DTSTART as a line.
    const text = [`DTSTART:${fakeStamp(dtstart)}`, ...normalizeRecurrenceLines(master.recurrence, tz, allDay)].join('\n');
    const parsed = rrulestr(text, { forceset: true, unfold: true });
    set = parsed as RRuleSet;
  } catch {
    return null;
  }
  // Ensure DTSTART itself is an occurrence (RFC 5545 semantics) unless excluded.
  set.rdate(dtstart);
  const pad = 2 * DAY;
  const fakeWinStart = allDay
    ? new Date(Date.UTC(windowStart.getFullYear(), windowStart.getMonth(), windowStart.getDate()) - pad)
    : new Date(toFakeUtc(windowStart, tz).getTime() - pad);
  const fakeWinEnd = allDay
    ? new Date(Date.UTC(windowEnd.getFullYear(), windowEnd.getMonth(), windowEnd.getDate()) + pad)
    : new Date(toFakeUtc(windowEnd, tz).getTime() + pad);
  const occurrences = set.between(fakeWinStart, fakeWinEnd, true);
  const out: ExpandedOccurrence[] = [];
  const seen = new Set<number>();
  for (const fake of occurrences) {
    const start = allDay ? localMidnight(fake) : fromFakeUtc(fake, tz);
    const t = start.getTime();
    if (seen.has(t)) continue;
    seen.add(t);
    if (t < windowStart.getTime() || t >= windowEnd.getTime()) continue;
    out.push({ start, end: new Date(t + duration) });
    if (out.length >= maxOccurrences) break;
  }
  out.sort((a, b) => a.start.getTime() - b.start.getTime());
  return out;
}

/** Human-readable summary of the recurrence rule (best-effort). */
export function describeRecurrence(lines: string[] | undefined): string {
  if (!lines?.length) return '';
  const rule = lines.find((l) => l.toUpperCase().startsWith('RRULE'));
  if (!rule) return 'Custom recurrence';
  try {
    const r = rrulestr(rule.replace(/^RRULE:/i, 'RRULE:'));
    return r.toText();
  } catch {
    return 'Custom recurrence';
  }
}

/** Wall-clock hour/minute of an instant in a zone, useful for keyboard editing. */
export function wallTime(date: Date, tz: string): { hour: number; minute: number } {
  const w = toWallClock(date, tz);
  return { hour: w.hour, minute: w.minute };
}
