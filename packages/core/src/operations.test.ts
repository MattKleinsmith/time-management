import { describe, expect, it } from 'vitest';
import { emptyLocalAlertState, type LocalAlertState } from './alerts';
import { defaultTmConfig } from './metadata';
import { MockGcalClient } from './mock';
import { buildInstances } from './model';
import { EventOperations, ReadOnlyEventError, withUntil } from './operations';
import { MemoryPersistence, SyncEngine } from './sync';
import type { GcalEvent } from './types';

const LA = 'America/Los_Angeles';

async function setup() {
  const client = new MockGcalClient();
  client.addCalendar({ id: 'primary', summary: 'Me', accessRole: 'owner', timeZone: LA, primary: true });
  client.addCalendar({ id: 'ro', summary: 'Shared', accessRole: 'reader', timeZone: LA });
  const master: GcalEvent = {
    id: 'm1',
    summary: 'Exercise',
    start: { dateTime: '2026-09-28T07:00:00-07:00', timeZone: LA },
    end: { dateTime: '2026-09-28T08:00:00-07:00', timeZone: LA },
    recurrence: ['RRULE:FREQ=DAILY;COUNT=10'],
  };
  client.seed('primary', master);
  client.seed('primary', { id: 's1', summary: 'Dentist', start: { dateTime: '2026-09-29T10:00:00-07:00', timeZone: LA }, end: { dateTime: '2026-09-29T11:00:00-07:00', timeZone: LA } });
  client.seed('ro', { id: 'r1', summary: 'Her meeting', start: { dateTime: '2026-09-29T12:00:00-07:00', timeZone: LA }, end: { dateTime: '2026-09-29T13:00:00-07:00', timeZone: LA } });
  const engine = new SyncEngine(client, new MemoryPersistence());
  await engine.sync();
  let local: LocalAlertState = emptyLocalAlertState();
  const ops = new EventOperations({ client, engine, localAlerts: { get: () => local, set: (n) => (local = n) } });
  const instances = () =>
    buildInstances(engine.getCalendarSnapshots(), { windowStart: new Date('2026-09-28T00:00:00Z'), windowEnd: new Date('2026-10-10T00:00:00Z'), timeZone: LA });
  return { client, engine, ops, instances, local: () => local };
}

describe('EventOperations', () => {
  it('configures the series parent by default (no exceptions created)', async () => {
    const { client, ops, instances } = await setup();
    const occ = instances().find((i) => i.masterId === 'm1' && i.start.toISOString() === '2026-09-30T14:00:00.000Z')!;
    await ops.setTmConfig(occ, defaultTmConfig());
    const patches = client.requests.filter((r) => r.method === 'PATCH');
    expect(patches.length).toBe(1);
    expect(patches[0].path).toBe('events:primary/m1');
    const after = instances().filter((i) => i.masterId === 'm1');
    expect(after.every((i) => i.tm?.alert.mode === 'repeat' && i.tmSource === 'series')).toBe(true);
    expect(after.every((i) => !i.isException)).toBe(true);
  });

  it('configures a single occurrence as an explicit exception with tm_own', async () => {
    const { client, ops, instances } = await setup();
    const occ = instances().find((i) => i.masterId === 'm1' && i.start.toISOString() === '2026-09-30T14:00:00.000Z')!;
    await ops.setTmConfig(occ, defaultTmConfig({ alert: { ...defaultTmConfig().alert, intervalMin: 1 } }), 'instance');
    const patch = client.requests.find((r) => r.method === 'PATCH')!;
    expect(patch.path).toBe('events:primary/m1_20260930T140000Z');
    expect((patch.body as GcalEvent).extendedProperties!.private!.tm_own).toBe('1');
    const after = instances().filter((i) => i.masterId === 'm1');
    expect(after.filter((i) => i.isException).length).toBe(1);
    expect(after.find((i) => i.isException)!.tm!.alert.intervalMin).toBe(1);
    expect(after.find((i) => !i.isException)!.tm).toBeNull();
  });

  it('refuses to modify read-only events and never duplicates them', async () => {
    const { client, ops, instances } = await setup();
    const ro = instances().find((i) => i.calendarId === 'ro')!;
    await expect(ops.setTmConfig(ro, defaultTmConfig())).rejects.toBeInstanceOf(ReadOnlyEventError);
    await expect(ops.changeTime(ro, { start: new Date(), end: new Date() })).rejects.toBeInstanceOf(ReadOnlyEventError);
    expect(client.requests.filter((r) => r.method !== 'GET').length).toBe(0);
  });

  it('moves a single occurrence, the whole series, or this-and-following', async () => {
    const { client, ops, instances } = await setup();
    const occ = instances().find((i) => i.masterId === 'm1' && i.start.toISOString() === '2026-09-30T14:00:00.000Z')!;
    await ops.changeTime(occ, { start: new Date('2026-09-30T15:00:00Z'), end: new Date('2026-09-30T16:00:00Z') }, 'instance');
    let list = instances().filter((i) => i.masterId === 'm1');
    expect(list.find((i) => i.instanceStart === '2026-09-30T14:00:00.000Z')!.start.toISOString()).toBe('2026-09-30T15:00:00.000Z');
    expect(list.filter((i) => i.isException).length).toBe(1);

    const other = list.find((i) => i.start.toISOString() === '2026-10-01T14:00:00.000Z')!;
    await ops.changeTime(other, { start: new Date('2026-10-01T14:30:00Z'), end: new Date('2026-10-01T15:30:00Z') }, 'series');
    list = instances().filter((i) => i.masterId === 'm1');
    expect(list.find((i) => !i.isException && i.instanceStart.startsWith('2026-09-28'))!.start.toISOString()).toBe('2026-09-28T14:30:00.000Z');
    // Master start shifted by 30 minutes: the original instances now start at 14:30Z
    expect(list.filter((i) => !i.isException).every((i) => i.start.getUTCMinutes() === 30)).toBe(true);

    const split = list.find((i) => !i.isException && i.start.toISOString() === '2026-10-03T14:30:00.000Z')!;
    await ops.changeTime(split, { start: new Date('2026-10-03T16:00:00Z'), end: new Date('2026-10-03T17:00:00Z') }, 'following');
    const all = instances();
    const oldSeries = all.filter((i) => i.masterId === 'm1');
    const newSeries = all.filter((i) => i.isRecurring && i.masterId !== 'm1');
    expect(oldSeries.every((i) => i.start.getTime() < new Date('2026-10-03T14:30:00Z').getTime())).toBe(true);
    expect(newSeries[0].start.toISOString()).toBe('2026-10-03T16:00:00.000Z');
    expect(newSeries[0].master!.recurrence![0]).toMatch(/COUNT=5$/);
    expect(newSeries.length).toBe(5);
    expect(client.requests.filter((r) => r.method === 'POST').length).toBe(1);
  });

  it('deletes one occurrence as a cancelled exception', async () => {
    const { ops, instances } = await setup();
    const occ = instances().find((i) => i.masterId === 'm1' && i.start.toISOString() === '2026-09-30T14:00:00.000Z')!;
    await ops.deleteEvent(occ, 'instance');
    const list = instances().filter((i) => i.masterId === 'm1');
    expect(list.some((i) => i.start.toISOString() === '2026-09-30T14:00:00.000Z')).toBe(false);
    expect(list.length).toBe(9);
  });

  it('acknowledges: locally always, remotely on the series parent when writable', async () => {
    const { client, ops, instances, local } = await setup();
    const occ = instances().find((i) => i.masterId === 'm1')!;
    await ops.setTmConfig(occ, defaultTmConfig());
    const target = instances().find((i) => i.masterId === 'm1' && i.instanceStart === '2026-09-30T14:00:00.000Z')!;
    await ops.acknowledge(target);
    expect(local().acked[target.key]).toBeTruthy();
    const patch = client.requests.filter((r) => r.method === 'PATCH').at(-1)!;
    expect(patch.path).toBe('events:primary/m1');
    expect((patch.body as GcalEvent).extendedProperties!.private!.tm_ack).toMatch(/^2026-09-30T14:00:00.000Z\|/);
    const ro = instances().find((i) => i.calendarId === 'ro')!;
    await ops.acknowledge(ro);
    expect(local().acked[ro.key]).toBeTruthy();
  });

  it('creates events with metadata in extendedProperties only', async () => {
    const { client, ops } = await setup();
    const created = await ops.createEvent({
      calendarId: 'primary',
      title: 'Pick up groceries',
      start: new Date('2026-09-29T23:00:00Z'),
      end: new Date('2026-09-29T23:30:00Z'),
      allDay: false,
      timeZone: LA,
      description: 'Milk, eggs',
      tm: defaultTmConfig(),
    });
    expect(created.description).toBe('Milk, eggs');
    expect(created.extendedProperties!.private!.tm_v).toBe('1');
    const body = client.requests.find((r) => r.method === 'POST')!.body as GcalEvent;
    expect(body.start).toEqual({ dateTime: '2026-09-29T16:00:00-07:00', timeZone: LA });
  });

  it('withUntil replaces COUNT/UNTIL', () => {
    expect(withUntil(['RRULE:FREQ=DAILY;COUNT=10'], new Date('2026-10-03T13:59:59Z'), false)).toEqual(['RRULE:FREQ=DAILY;UNTIL=20261003T135959Z']);
  });
});
