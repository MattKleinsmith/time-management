import { describe, expect, it } from 'vitest';
import { fromFakeUtc, toFakeUtc, toRfc3339InZone, tzOffsetMs, wallClockToInstant } from './time';

describe('time zone helpers', () => {
  it('computes offsets across DST', () => {
    expect(tzOffsetMs('America/Los_Angeles', new Date('2026-01-15T12:00:00Z'))).toBe(-8 * 3600_000);
    expect(tzOffsetMs('America/Los_Angeles', new Date('2026-07-15T12:00:00Z'))).toBe(-7 * 3600_000);
    expect(tzOffsetMs('Asia/Kolkata', new Date('2026-07-15T12:00:00Z'))).toBe(5.5 * 3600_000);
  });
  it('round-trips wall clock <-> instant', () => {
    const inst = wallClockToInstant({ year: 2026, month: 3, day: 10, hour: 9, minute: 30, second: 0 }, 'America/New_York');
    expect(inst.toISOString()).toBe('2026-03-10T13:30:00.000Z');
    expect(toFakeUtc(inst, 'America/New_York').toISOString()).toBe('2026-03-10T09:30:00.000Z');
    expect(fromFakeUtc(new Date('2026-03-10T09:30:00Z'), 'America/New_York').toISOString()).toBe('2026-03-10T13:30:00.000Z');
  });
  it('handles a DST gap deterministically', () => {
    // 2026-03-08 02:30 does not exist in New York; we accept either neighbour but must not throw.
    const d = wallClockToInstant({ year: 2026, month: 3, day: 8, hour: 2, minute: 30, second: 0 }, 'America/New_York');
    expect(Number.isNaN(d.getTime())).toBe(false);
  });
  it('formats RFC3339 in zone', () => {
    expect(toRfc3339InZone(new Date('2026-07-01T16:00:00Z'), 'America/Los_Angeles')).toBe('2026-07-01T09:00:00-07:00');
    expect(toRfc3339InZone(new Date('2026-07-01T16:00:00Z'), 'Asia/Kolkata')).toBe('2026-07-01T21:30:00+05:30');
  });
});
