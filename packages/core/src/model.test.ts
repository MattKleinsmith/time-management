import { describe, expect, it } from 'vitest';
import { buildInstances, computePermissions, currentInstance, nextInstance } from './model';
import type { GcalCalendarListEntry, GcalEvent } from './types';

const LA = 'America/Los_Angeles';
const cal: GcalCalendarListEntry = { id: 'primary', summary: 'Me', accessRole: 'owner', timeZone: LA };
const shared: GcalCalendarListEntry = { id: 'wife', summary: 'Wife', accessRole: 'reader', timeZone: LA };

const master: GcalEvent = {
  id: 'm1',
  summary: 'Standup',
  start: { dateTime: '2026-09-28T09:00:00-07:00', timeZone: LA },
  end: { dateTime: '2026-09-28T09:15:00-07:00', timeZone: LA },
  recurrence: ['RRULE:FREQ=DAILY'],
  extendedProperties: { private: { tm_v: '1', tm_alert: 'repeat', tm_int: '5' } },
};

describe('buildInstances', () => {
  const win = { windowStart: new Date('2026-09-28T07:00:00Z'), windowEnd: new Date('2026-10-02T07:00:00Z'), timeZone: LA };

  it('expands a series, applies moved and cancelled exceptions, inherits TM config', () => {
    const moved: GcalEvent = {
      id: 'm1_20260929T160000Z',
      recurringEventId: 'm1',
      originalStartTime: { dateTime: '2026-09-29T09:00:00-07:00', timeZone: LA },
      start: { dateTime: '2026-09-29T11:00:00-07:00', timeZone: LA },
      end: { dateTime: '2026-09-29T11:15:00-07:00', timeZone: LA },
      summary: 'Standup (late)',
      extendedProperties: { private: { tm_v: '1', tm_alert: 'repeat', tm_int: '5' } }, // copied by Google, no tm_own
    };
    const cancelled: GcalEvent = {
      id: 'm1_20260930T160000Z',
      status: 'cancelled',
      recurringEventId: 'm1',
      originalStartTime: { dateTime: '2026-09-30T09:00:00-07:00', timeZone: LA },
    };
    const own: GcalEvent = {
      id: 'm1_20261001T160000Z',
      summary: 'Standup',
      recurringEventId: 'm1',
      originalStartTime: { dateTime: '2026-10-01T09:00:00-07:00', timeZone: LA },
      start: { dateTime: '2026-10-01T09:00:00-07:00', timeZone: LA },
      end: { dateTime: '2026-10-01T09:15:00-07:00', timeZone: LA },
      extendedProperties: { private: { tm_v: '1', tm_alert: 'none', tm_own: '1' } },
    };
    const list = buildInstances([{ calendar: cal, events: { m1: master, a: moved, b: cancelled, c: own } }], win);
    expect(list.map((i) => [i.start.toISOString(), i.title, i.tmSource, i.tm?.alert.mode])).toEqual([
      ['2026-09-28T16:00:00.000Z', 'Standup', 'series', 'repeat'],
      ['2026-09-29T18:00:00.000Z', 'Standup (late)', 'series', 'repeat'],
      ['2026-10-01T16:00:00.000Z', 'Standup', 'instance', 'none'],
    ]);
    expect(list[1].isException).toBe(true);
    expect(list[1].instanceStart).toBe('2026-09-29T16:00:00.000Z');
    expect(list[0].key).toBe('primary/m1/2026-09-28T16:00:00.000Z');
  });

  it('shows read-only events with permissions explained', () => {
    const ev: GcalEvent = { id: 's', summary: 'Her thing', start: { dateTime: '2026-09-29T10:00:00-07:00' }, end: { dateTime: '2026-09-29T11:00:00-07:00' } };
    const [inst] = buildInstances([{ calendar: shared, events: { s: ev } }], win);
    expect(inst.permissions.canConfigure).toBe(false);
    expect(inst.permissions.reason).toMatch(/reader/);
    expect(inst.tm).toBeNull();
  });

  it('distinguishes guest events', () => {
    const ev: GcalEvent = {
      id: 'g',
      organizer: { email: 'boss@example.com', self: false },
      attendees: [{ email: 'me@example.com', self: true, responseStatus: 'accepted' }],
    };
    const p = computePermissions(ev, cal);
    expect(p.canEditDetails).toBe(false);
    expect(p.canConfigure).toBe(true);
    expect(computePermissions({ ...ev, guestsCanModify: true }, cal).canEditDetails).toBe(true);
  });

  it('finds current and next', () => {
    const list = buildInstances([{ calendar: cal, events: { m1: master } }], win);
    const now = new Date('2026-09-29T16:05:00Z');
    expect(currentInstance(list, now)?.start.toISOString()).toBe('2026-09-29T16:00:00.000Z');
    expect(nextInstance(list, now)?.start.toISOString()).toBe('2026-09-30T16:00:00.000Z');
  });
});
