import { deviceTimeZone, toRfc3339InZone, type MockGcalClient } from '@tm/core';

/** Sample data for mock mode (no Google account needed). */
export function seedMockCalendar(client: MockGcalClient) {
  const tz = deviceTimeZone();
  client.addCalendar({ id: 'primary', summary: 'mock@example.com', accessRole: 'owner', primary: true, timeZone: tz, backgroundColor: '#3b82f6', selected: true });
  client.addCalendar({ id: 'family', summary: 'Family', accessRole: 'writer', timeZone: tz, backgroundColor: '#22c55e', selected: true });
  client.addCalendar({ id: 'partner', summary: "Partner's calendar", accessRole: 'reader', timeZone: tz, backgroundColor: '#ec4899', selected: true });

  const now = new Date();
  const day = (offset: number, h: number, m = 0) => {
    const d = new Date(now);
    d.setDate(d.getDate() + offset);
    d.setHours(h, m, 0, 0);
    return d;
  };
  const t = (d: Date) => ({ dateTime: toRfc3339InZone(d, tz), timeZone: tz });
  const weekStart = new Date(now);
  weekStart.setDate(weekStart.getDate() - 14);

  client.seed('primary', {
    id: 'exercise',
    summary: 'Exercise',
    start: t(new Date(weekStart.setHours(7, 0, 0, 0))),
    end: t(new Date(weekStart.getTime() + 3600_000)),
    recurrence: ['RRULE:FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR'],
    extendedProperties: { private: { tm_v: '1', tm_alert: 'repeat', tm_int: '5', tm_lead: '10', tm_sound: 'alarm' } },
  });
  client.seed('primary', {
    id: 'standup',
    summary: 'Team standup',
    location: 'Meet',
    start: t(day(-7, 9, 30)),
    end: t(day(-7, 9, 45)),
    recurrence: ['RRULE:FREQ=WEEKLY;BYDAY=MO,WE,FR'],
    extendedProperties: { private: { tm_v: '1', tm_alert: 'once', tm_lead: '2' } },
  });
  client.seed('primary', {
    id: 'projectx',
    summary: 'Work on Project X',
    description: 'Deep work block. Phone in the other room.',
    start: t(day(0, 8, 0)),
    end: t(day(0, 10, 30)),
    extendedProperties: { private: { tm_v: '1', tm_alert: 'repeat', tm_int: '1', tm_lead: '0', tm_tags: 'deep' } },
  });
  // An alert that is active right now (started a few minutes ago, never acknowledged).
  const activeStart = new Date(now.getTime() - 7 * 60_000);
  client.seed('primary', {
    id: 'nagging',
    summary: 'Take medication',
    start: t(activeStart),
    end: t(new Date(activeStart.getTime() + 15 * 60_000)),
    extendedProperties: { private: { tm_v: '1', tm_alert: 'repeat', tm_int: '5', tm_lead: '0' } },
  });
  client.seed('primary', {
    id: 'groceries',
    summary: 'Pick up groceries',
    location: 'Trader Joe’s',
    start: t(day(0, 16, 0)),
    end: t(day(0, 16, 30)),
    extendedProperties: { private: { tm_v: '1', tm_alert: 'repeat', tm_int: '10', tm_lead: '15' } },
  });
  client.seed('primary', { id: 'dentist', summary: 'Dentist', location: '123 Main St', start: t(day(1, 14, 0)), end: t(day(1, 15, 0)) });
  client.seed('primary', { id: 'lunch', summary: 'Lunch with Sam', start: t(day(2, 12, 0)), end: t(day(2, 13, 0)) });
  client.seed('primary', {
    id: 'guest',
    summary: 'Quarterly planning (invited)',
    organizer: { email: 'boss@example.com', displayName: 'Boss', self: false },
    attendees: [
      { email: 'boss@example.com', organizer: true, responseStatus: 'accepted' },
      { email: 'mock@example.com', self: true, responseStatus: 'accepted' },
    ],
    start: t(day(1, 10, 0)),
    end: t(day(1, 11, 30)),
  });
  client.seed('primary', { id: 'allday', summary: 'Company holiday', start: { date: isoDate(day(3, 0)) }, end: { date: isoDate(day(4, 0)) } });
  client.seed('family', { id: 'soccer', summary: 'Kids soccer', start: t(day(0, 17, 30)), end: t(day(0, 18, 30)), recurrence: ['RRULE:FREQ=WEEKLY'] });
  client.seed('partner', { id: 'yoga', summary: 'Yoga', start: t(day(0, 18, 0)), end: t(day(0, 19, 0)), recurrence: ['RRULE:FREQ=WEEKLY;BYDAY=MO,WE'] });
  client.seed('partner', { id: 'book', summary: 'Book club', start: t(day(2, 19, 0)), end: t(day(2, 21, 0)) });
}

function isoDate(d: Date) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
