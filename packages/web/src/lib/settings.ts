import { DEFAULT_ALERT, type AlertPolicy } from '@tm/core';

export interface Settings {
  daysInView: number;
  pxPerHour: number;
  snapMinutes: number;
  weekStartsOn: 0 | 1 | 6;
  /** null = show every calendar that Google marks selected. */
  visibleCalendarIds: string[] | null;
  syncIntervalSec: number;
  defaultAlert: AlertPolicy;
  /** Events created inside Time Manager get the default alert policy automatically. */
  autoConfigureNewEvents: boolean;
  soundEnabled: boolean;
  vibrate: boolean;
  maxNagHours: number;
  timeFormat: '12h' | '24h';
  /** Hours hidden at the top/bottom of the grid (still scrollable via "show all"). */
  dayStartHour: number;
  dayEndHour: number;
  showWeekends: boolean;
  defaultDurationMin: number;
  defaultCalendarId: string | null;
  theme: 'dark' | 'light' | 'system';
}

export const DEFAULT_SETTINGS: Settings = {
  daysInView: 7,
  pxPerHour: 56,
  snapMinutes: 15,
  weekStartsOn: 1,
  visibleCalendarIds: null,
  syncIntervalSec: 120,
  defaultAlert: { ...DEFAULT_ALERT },
  autoConfigureNewEvents: true,
  soundEnabled: true,
  vibrate: true,
  maxNagHours: 12,
  timeFormat: '12h',
  dayStartHour: 0,
  dayEndHour: 24,
  showWeekends: true,
  defaultDurationMin: 30,
  defaultCalendarId: null,
  theme: 'dark',
};

export function mergeSettings(saved: Partial<Settings> | undefined): Settings {
  return { ...DEFAULT_SETTINGS, ...(saved ?? {}), defaultAlert: { ...DEFAULT_ALERT, ...(saved?.defaultAlert ?? {}) } };
}
