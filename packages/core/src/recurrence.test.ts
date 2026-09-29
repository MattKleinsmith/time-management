import { describe, expect, it } from 'vitest';
import { expandRecurrence, normalizeRecurrenceLines } from './recurrence';
import type { GcalEvent } from './types';

const LA = 'America/Los_Angeles';

function weekly(overrides: Partial<GcalEvent> = {}): GcalEvent {
  return {
    id: 'm1',
    summary: 'Exercise',
    start: { dateTime: '2026-03-02T07:00:00-08:00', timeZone: LA },
    end: { dateTime: '2026-03-02T08:00:00-08:00', timeZone: LA },
    recurrence: ['RRULE:FREQ=WEEKLY;BYDAY=MO,WE,FR'],
    ...overrides,
  };
}

describe('recurrence expansion', () => {
  it('keeps wall-clock time across the DST change', () => {
    const occ = expandRecurrence(weekly(), new Date('2026-03-01T00:00:00Z'), new Date('2026-03-16T00:00:00Z'), LA)!;
    const iso = occ.map((o) => o.start.toISOString());
    expect(iso).toContain('2026-03-02T15:00:00.000Z'); // PST
    expect(iso).toContain('2026-03-09T14:00:00.000Z'); // PDT, still 07:00 local
    expect(occ.every((o) => o.end.getTime() - o.start.getTime() === 3600_000)).toBe(true);
    expect(occ.length).toBe(6);
  });
  it('honours UNTIL given in UTC and EXDATE with TZID', () => {
    const ev = weekly({
      recurrence: ['RRULE:FREQ=WEEKLY;BYDAY=MO,WE,FR;UNTIL=20260311T150000Z', 'EXDATE;TZID=America/Los_Angeles:20260304T070000'],
    });
    const occ = expandRecurrence(ev, new Date('2026-03-01T00:00:00Z'), new Date('2026-04-01T00:00:00Z'), LA)!;
    const iso = occ.map((o) => o.start.toISOString());
    expect(iso).toEqual(['2026-03-02T15:00:00.000Z', '2026-03-06T15:00:00.000Z', '2026-03-09T14:00:00.000Z', '2026-03-11T14:00:00.000Z']);
  });
  it('supports COUNT and daily all-day rules', () => {
    const ev: GcalEvent = {
      id: 'ad',
      start: { date: '2026-05-01' },
      end: { date: '2026-05-02' },
      recurrence: ['RRULE:FREQ=DAILY;COUNT=3'],
    };
    const occ = expandRecurrence(ev, new Date(2026, 3, 1), new Date(2026, 5, 1), 'UTC')!;
    expect(occ.map((o) => o.start.getDate())).toEqual([1, 2, 3]);
    expect(occ[0].start.getHours()).toBe(0);
  });
  it('normalises lines into the fake-UTC frame', () => {
    const lines = normalizeRecurrenceLines(['RRULE:FREQ=DAILY;UNTIL=20260311T150000Z', 'EXDATE:20260304T150000Z'], LA, false);
    expect(lines).toEqual(['RRULE:FREQ=DAILY;UNTIL=20260311T080000Z', 'EXDATE:20260304T070000Z']);
  });
  it('returns nothing for a window before the series start', () => {
    const occ = expandRecurrence(weekly(), new Date('2026-01-01T00:00:00Z'), new Date('2026-02-01T00:00:00Z'), LA)!;
    expect(occ).toEqual([]);
  });
  it('includes DTSTART even when it does not match BYDAY', () => {
    const ev = weekly({ start: { dateTime: '2026-03-03T07:00:00-08:00', timeZone: LA }, end: { dateTime: '2026-03-03T08:00:00-08:00', timeZone: LA } });
    const occ = expandRecurrence(ev, new Date('2026-03-01T00:00:00Z'), new Date('2026-03-08T00:00:00Z'), LA)!;
    expect(occ.map((o) => o.start.toISOString())).toEqual(['2026-03-03T15:00:00.000Z', '2026-03-04T15:00:00.000Z', '2026-03-06T15:00:00.000Z']);
  });
});
