/**
 * Time-zone helpers built on Intl so the core has no dependency on a tz database.
 * The "wall clock" representation is a Date whose UTC fields hold the local
 * wall-clock fields of the target zone (the trick rrule needs for zoned recurrence).
 */

const dtfCache = new Map<string, Intl.DateTimeFormat>();

function dtf(tz: string): Intl.DateTimeFormat {
  let f = dtfCache.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
    dtfCache.set(tz, f);
  }
  return f;
}

export function isValidTimeZone(tz: string | undefined): tz is string {
  if (!tz) return false;
  try {
    dtf(tz);
    return true;
  } catch {
    return false;
  }
}

export interface WallClock {
  year: number;
  month: number; // 1-12
  day: number;
  hour: number;
  minute: number;
  second: number;
}

/** Wall clock fields of `date` in zone `tz`. */
export function toWallClock(date: Date, tz: string): WallClock {
  const parts = dtf(tz).formatToParts(date);
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value ?? '0');
  return {
    year: get('year'),
    month: get('month'),
    day: get('day'),
    hour: get('hour') % 24,
    minute: get('minute'),
    second: get('second'),
  };
}

/** Offset (ms) of `tz` from UTC at instant `date` (positive east of UTC). */
export function tzOffsetMs(tz: string, date: Date): number {
  const w = toWallClock(date, tz);
  const asUtc = Date.UTC(w.year, w.month - 1, w.day, w.hour, w.minute, w.second);
  return asUtc - Math.floor(date.getTime() / 1000) * 1000;
}

/** Real instant for a wall-clock time in `tz`. Handles DST gaps/overlaps deterministically. */
export function wallClockToInstant(w: WallClock, tz: string): Date {
  const guess = Date.UTC(w.year, w.month - 1, w.day, w.hour, w.minute, w.second);
  const off1 = tzOffsetMs(tz, new Date(guess));
  let t = guess - off1;
  const off2 = tzOffsetMs(tz, new Date(t));
  if (off2 !== off1) t = guess - off2;
  return new Date(t);
}

/** "Fake UTC" Date whose UTC fields are the wall clock of `date` in `tz`. */
export function toFakeUtc(date: Date, tz: string): Date {
  const w = toWallClock(date, tz);
  return new Date(Date.UTC(w.year, w.month - 1, w.day, w.hour, w.minute, w.second));
}

/** Inverse of toFakeUtc. */
export function fromFakeUtc(fake: Date, tz: string): Date {
  return wallClockToInstant(
    {
      year: fake.getUTCFullYear(),
      month: fake.getUTCMonth() + 1,
      day: fake.getUTCDate(),
      hour: fake.getUTCHours(),
      minute: fake.getUTCMinutes(),
      second: fake.getUTCSeconds(),
    },
    tz,
  );
}

export const MINUTE = 60_000;
export const HOUR = 3_600_000;
export const DAY = 86_400_000;

/** Parse YYYY-MM-DD into a fake-UTC midnight Date. */
export function parseDateOnly(s: string): Date {
  const [y, m, d] = s.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d));
}

/** Format a fake-UTC date as YYYY-MM-DD. */
export function formatDateOnly(fake: Date): string {
  const y = fake.getUTCFullYear();
  const m = String(fake.getUTCMonth() + 1).padStart(2, '0');
  const d = String(fake.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

/** Local (device zone) start of the day containing `date`. */
export function startOfDay(date: Date): Date {
  const d = new Date(date);
  d.setHours(0, 0, 0, 0);
  return d;
}

export function addDays(date: Date, n: number): Date {
  const d = new Date(date);
  d.setDate(d.getDate() + n);
  return d;
}

/** Local calendar-date key YYYY-MM-DD in the device zone. */
export function localDateKey(date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

/** Format an instant as RFC3339 with the given zone's offset (what Google expects with timeZone). */
export function toRfc3339InZone(date: Date, tz: string): string {
  const w = toWallClock(date, tz);
  const off = tzOffsetMs(tz, date);
  const sign = off < 0 ? '-' : '+';
  const abs = Math.abs(off);
  const oh = String(Math.floor(abs / HOUR)).padStart(2, '0');
  const om = String(Math.floor((abs % HOUR) / MINUTE)).padStart(2, '0');
  const p = (n: number) => String(n).padStart(2, '0');
  return `${w.year}-${p(w.month)}-${p(w.day)}T${p(w.hour)}:${p(w.minute)}:${p(w.second)}${sign}${oh}:${om}`;
}

export function deviceTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  } catch {
    return 'UTC';
  }
}
