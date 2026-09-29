import { describe, expect, it } from 'vitest';
import { alertStatusFor, emptyLocalAlertState, planAlerts, scheduleReminders } from './alerts';
import { buildInstances } from './model';
import type { GcalCalendarListEntry, GcalEvent } from './types';

const cal: GcalCalendarListEntry = { id: 'primary', summary: 'Me', accessRole: 'owner', timeZone: 'UTC' };
function inst(props: Record<string, string>, extra: Partial<GcalEvent> = {}) {
  const ev: GcalEvent = {
    id: 'e',
    summary: 'Exercise',
    start: { dateTime: '2026-09-29T07:00:00Z' },
    end: { dateTime: '2026-09-29T08:00:00Z' },
    extendedProperties: { private: { tm_v: '1', ...props } },
    ...extra,
  };
  return buildInstances([{ calendar: cal, events: { e: ev } }], {
    windowStart: new Date('2026-09-29T00:00:00Z'),
    windowEnd: new Date('2026-09-30T00:00:00Z'),
    timeZone: 'UTC',
  })[0];
}

describe('alert planner', () => {
  it('is scheduled before the alert start (with lead time)', () => {
    const s = alertStatusFor(inst({ tm_alert: 'repeat', tm_int: '5', tm_lead: '10' }), new Date('2026-09-29T06:30:00Z'), emptyLocalAlertState())!;
    expect(s.phase).toBe('scheduled');
    expect(s.nextFireAt?.toISOString()).toBe('2026-09-29T06:50:00.000Z');
  });
  it('repeats every interval until acknowledged', () => {
    const i = inst({ tm_alert: 'repeat', tm_int: '5' });
    const s = alertStatusFor(i, new Date('2026-09-29T07:12:00Z'), emptyLocalAlertState())!;
    expect(s.phase).toBe('active');
    expect(s.firedCount).toBe(3);
    expect(s.nextFireAt?.toISOString()).toBe('2026-09-29T07:15:00.000Z');
    // Still nagging hours later (until acknowledged)
    expect(alertStatusFor(i, new Date('2026-09-29T11:00:00Z'), emptyLocalAlertState())!.phase).toBe('active');
    // Safety cap
    expect(alertStatusFor(i, new Date('2026-09-30T06:00:00Z'), emptyLocalAlertState())!.phase).toBe('expired');
  });
  it('stops at event end when until=end', () => {
    const i = inst({ tm_alert: 'repeat', tm_int: '5', tm_until: 'end' });
    expect(alertStatusFor(i, new Date('2026-09-29T07:59:00Z'), emptyLocalAlertState())!.phase).toBe('active');
    expect(alertStatusFor(i, new Date('2026-09-29T08:01:00Z'), emptyLocalAlertState())!.phase).toBe('expired');
  });
  it('honours local and remote acknowledgement', () => {
    const i = inst({ tm_alert: 'repeat', tm_int: '5' });
    const local = emptyLocalAlertState();
    local.acked[i.key] = 'x';
    expect(alertStatusFor(i, new Date('2026-09-29T07:12:00Z'), local)!.phase).toBe('acknowledged');
    const remote = inst({ tm_alert: 'repeat', tm_int: '5', tm_ack: '2026-09-29T07:00:00.000Z|2026-09-29T07:03:00.000Z' });
    expect(alertStatusFor(remote, new Date('2026-09-29T07:12:00Z'), emptyLocalAlertState())!.phase).toBe('acknowledged');
  });
  it('series ack covers earlier occurrences only', () => {
    const ev: GcalEvent = {
      id: 'm',
      summary: 'Standup',
      start: { dateTime: '2026-09-28T09:00:00Z' },
      end: { dateTime: '2026-09-28T09:15:00Z' },
      recurrence: ['RRULE:FREQ=DAILY'],
      extendedProperties: { private: { tm_v: '1', tm_alert: 'once', tm_ack: '2026-09-29T09:00:00.000Z|2026-09-29T09:01:00.000Z' } },
    };
    const list = buildInstances([{ calendar: cal, events: { m: ev } }], {
      windowStart: new Date('2026-09-28T00:00:00Z'),
      windowEnd: new Date('2026-10-01T00:00:00Z'),
      timeZone: 'UTC',
    });
    const now = new Date('2026-09-30T09:05:00Z');
    const phases = list.map((i) => alertStatusFor(i, now, emptyLocalAlertState())!.phase);
    expect(phases).toEqual(['acknowledged', 'acknowledged', 'active']);
  });
  it('snoozes and resumes repeating from the end of the snooze', () => {
    const i = inst({ tm_alert: 'repeat', tm_int: '5' });
    const local = emptyLocalAlertState();
    local.snoozed[i.key] = '2026-09-29T07:30:00.000Z';
    const s1 = alertStatusFor(i, new Date('2026-09-29T07:12:00Z'), local)!;
    expect(s1.phase).toBe('snoozed');
    expect(s1.nextFireAt?.toISOString()).toBe('2026-09-29T07:30:00.000Z');
    const s2 = alertStatusFor(i, new Date('2026-09-29T07:33:00Z'), local)!;
    expect(s2.phase).toBe('active');
    expect(s2.nextFireAt?.toISOString()).toBe('2026-09-29T07:35:00.000Z');
  });
  it('produces a reminder schedule for platform layers', () => {
    const i = inst({ tm_alert: 'repeat', tm_int: '10' });
    const rems = scheduleReminders([i], new Date('2026-09-29T06:00:00Z'), new Date('2026-09-29T07:35:00Z'), emptyLocalAlertState());
    expect(rems.map((r) => r.fireAt.toISOString())).toEqual(['2026-09-29T07:00:00.000Z', '2026-09-29T07:10:00.000Z', '2026-09-29T07:20:00.000Z', '2026-09-29T07:30:00.000Z']);
    expect(rems[0].sequence).toBe(1);
    const plan = planAlerts([i], new Date('2026-09-29T06:00:00Z'), emptyLocalAlertState());
    expect(plan.scheduled.length).toBe(1);
    expect(plan.nextChangeAt?.toISOString()).toBe('2026-09-29T07:00:00.000Z');
  });
  it('ignores ordinary events and no-alert configs', () => {
    expect(alertStatusFor(inst({ tm_alert: 'none' }), new Date(), emptyLocalAlertState())).toBeNull();
  });
});
