import { describe, expect, it } from 'vitest';
import { MockGcalClient } from './mock';
import { MemoryPersistence, SyncEngine } from './sync';
import type { GcalEvent } from './types';

function setup() {
  const client = new MockGcalClient();
  client.addCalendar({ id: 'primary', summary: 'Me', accessRole: 'owner', timeZone: 'UTC', primary: true });
  const engine = new SyncEngine(client, new MemoryPersistence());
  return { client, engine };
}
const ev = (id: string, extra: Partial<GcalEvent> = {}): GcalEvent => ({
  id,
  summary: id,
  start: { dateTime: '2026-09-29T10:00:00Z' },
  end: { dateTime: '2026-09-29T11:00:00Z' },
  ...extra,
});

describe('SyncEngine', () => {
  it('does a full sync, then incremental syncs using the sync token', async () => {
    const { client, engine } = setup();
    client.seed('primary', ev('a'));
    client.seed('primary', ev('b'));
    const r1 = await engine.sync();
    expect(r1.fullSyncs).toEqual(['primary']);
    expect(Object.keys(engine.snapshot.calendars.primary.events).sort()).toEqual(['a', 'b']);
    const token = engine.snapshot.calendars.primary.syncToken;
    expect(token).toBeTruthy();

    client.external('primary', ev('c'));
    client.external('primary', { ...ev('a'), status: 'cancelled' });
    const r2 = await engine.sync();
    expect(r2.fullSyncs).toEqual([]);
    expect(r2.changed).toBe(true);
    expect(Object.keys(engine.snapshot.calendars.primary.events).sort()).toEqual(['b', 'c']);
    const listCalls = client.requests.filter((r) => r.path === 'events:primary');
    expect((listCalls.at(-1)!.params as { syncToken?: string }).syncToken).toBe(token);
    expect((listCalls.at(-1)!.params as { timeMin?: string }).timeMin).toBeUndefined();
    expect((listCalls.at(-1)!.params as { showDeleted?: boolean }).showDeleted).toBe(true);
    // Every request in the cycle uses the same non-token parameters.
    const shapes = new Set(listCalls.map((c) => JSON.stringify({ ...(c.params as object), syncToken: undefined, pageToken: undefined })));
    expect(shapes.size).toBe(1);

    const r3 = await engine.sync();
    expect(r3.changed).toBe(false);
  });

  it('paginates and only takes nextSyncToken from the last page', async () => {
    const { client, engine } = setup();
    client.pageSize = 2;
    for (let i = 0; i < 5; i++) client.seed('primary', ev(`e${i}`));
    await engine.sync();
    expect(Object.keys(engine.snapshot.calendars.primary.events).length).toBe(5);
    expect(engine.snapshot.calendars.primary.syncToken).toBeTruthy();
  });

  it('recovers from 410 GONE with a full resync', async () => {
    const { client, engine } = setup();
    client.seed('primary', ev('a'));
    await engine.sync();
    client.expireSyncTokens();
    client.external('primary', ev('z'));
    const r = await engine.sync();
    expect(r.fullSyncs).toEqual(['primary']);
    expect(Object.keys(engine.snapshot.calendars.primary.events).sort()).toEqual(['a', 'z']);
  });

  it('keeps cancelled recurring exceptions and drops exceptions of a deleted series', async () => {
    const { client, engine } = setup();
    client.seed('primary', ev('m', { recurrence: ['RRULE:FREQ=DAILY'] }));
    client.seed('primary', { id: 'm_x', status: 'cancelled', recurringEventId: 'm', originalStartTime: { dateTime: '2026-09-30T10:00:00Z' } });
    await engine.sync();
    expect(Object.keys(engine.snapshot.calendars.primary.events).sort()).toEqual(['m', 'm_x']);
    client.external('primary', { ...ev('m', { recurrence: ['RRULE:FREQ=DAILY'] }), status: 'cancelled' });
    await engine.sync();
    expect(Object.keys(engine.snapshot.calendars.primary.events)).toEqual([]);
  });

  it('persists and reloads', async () => {
    const client = new MockGcalClient();
    client.addCalendar({ id: 'primary', summary: 'Me', accessRole: 'owner' });
    client.seed('primary', ev('a'));
    const p = new MemoryPersistence();
    const e1 = new SyncEngine(client, p);
    await e1.sync();
    const e2 = new SyncEngine(client, p);
    await e2.load();
    expect(e2.getEvent('primary', 'a')?.summary).toBe('a');
    client.external('primary', ev('b'));
    const r = await e2.sync();
    expect(r.fullSyncs).toEqual([]);
    expect(e2.getEvent('primary', 'b')).toBeTruthy();
  });
});
