import { MINUTE, HOUR } from '@tm/core';

let fmt12 = true;
export function setTimeFormat(f: '12h' | '24h') {
  fmt12 = f === '12h';
}

export function fmtTime(d: Date, opts: { omitMinutesIfZero?: boolean } = {}): string {
  const h = d.getHours();
  const m = d.getMinutes();
  if (!fmt12) return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
  const h12 = h % 12 === 0 ? 12 : h % 12;
  const suffix = h < 12 ? 'a' : 'p';
  if (opts.omitMinutesIfZero && m === 0) return `${h12}${suffix}`;
  return `${h12}:${String(m).padStart(2, '0')}${suffix}`;
}

export function fmtHourLabel(h: number): string {
  if (!fmt12) return `${String(h).padStart(2, '0')}:00`;
  if (h === 0 || h === 24) return '12am';
  if (h === 12) return '12pm';
  return h < 12 ? `${h}am` : `${h - 12}pm`;
}

export function fmtRange(start: Date, end: Date, allDay: boolean): string {
  if (allDay) return 'All day';
  return `${fmtTime(start)} – ${fmtTime(end)}`;
}

export function fmtDuration(ms: number): string {
  const totalMin = Math.round(ms / MINUTE);
  if (totalMin < 60) return `${totalMin}m`;
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  return m ? `${h}h ${m}m` : `${h}h`;
}

export function fmtCountdown(ms: number): string {
  const abs = Math.abs(ms);
  if (abs < MINUTE) return ms < 0 ? 'now' : '<1m';
  if (abs < HOUR) return `${Math.round(abs / MINUTE)}m`;
  if (abs < 24 * HOUR) {
    const h = Math.floor(abs / HOUR);
    const m = Math.round((abs % HOUR) / MINUTE);
    return m ? `${h}h ${m}m` : `${h}h`;
  }
  return `${Math.round(abs / (24 * HOUR))}d`;
}

const WD = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MO = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

export function fmtDayHeader(d: Date): { weekday: string; day: number; month: string } {
  return { weekday: WD[d.getDay()], day: d.getDate(), month: MO[d.getMonth()] };
}

export function fmtDate(d: Date, withYear = false): string {
  return `${WD[d.getDay()]}, ${MO[d.getMonth()]} ${d.getDate()}${withYear ? ` ${d.getFullYear()}` : ''}`;
}

export function fmtMonthYear(d: Date): string {
  return `${MO[d.getMonth()]} ${d.getFullYear()}`;
}

export function isSameDay(a: Date, b: Date): boolean {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}

export function toInputDate(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
export function toInputTime(d: Date): string {
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}
export function fromInputs(date: string, time: string): Date {
  const [y, m, d] = date.split('-').map(Number);
  const [hh, mm] = (time || '00:00').split(':').map(Number);
  return new Date(y, m - 1, d, hh, mm, 0, 0);
}

export function roundTo(d: Date, minutes: number): Date {
  const ms = minutes * MINUTE;
  return new Date(Math.round(d.getTime() / ms) * ms);
}

export const GOOGLE_COLORS: Record<string, string> = {
  '1': '#7986cb',
  '2': '#33b679',
  '3': '#8e24aa',
  '4': '#e67c73',
  '5': '#f6bf26',
  '6': '#f4511e',
  '7': '#039be5',
  '8': '#616161',
  '9': '#3f51b5',
  '10': '#0b8043',
  '11': '#d50000',
};
