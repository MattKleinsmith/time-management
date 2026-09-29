/**
 * Subset of the Google Calendar API v3 resource shapes that Time Manager uses.
 * See https://developers.google.com/workspace/calendar/api/v3/reference/events
 */

export interface GcalDateTime {
  /** RFC3339 timestamp, for timed events. */
  dateTime?: string;
  /** YYYY-MM-DD, for all-day events. */
  date?: string;
  /** IANA time zone name. Required for recurring events. */
  timeZone?: string;
}

export interface GcalPerson {
  id?: string;
  email?: string;
  displayName?: string;
  self?: boolean;
}

export interface GcalAttendee extends GcalPerson {
  organizer?: boolean;
  optional?: boolean;
  resource?: boolean;
  responseStatus?: 'needsAction' | 'declined' | 'tentative' | 'accepted';
  comment?: string;
}

export interface GcalReminders {
  useDefault?: boolean;
  overrides?: { method: 'email' | 'popup'; minutes: number }[];
}

export interface GcalExtendedProperties {
  private?: Record<string, string>;
  shared?: Record<string, string>;
}

export type GcalEventStatus = 'confirmed' | 'tentative' | 'cancelled';

export interface GcalEvent {
  kind?: 'calendar#event';
  id: string;
  etag?: string;
  status?: GcalEventStatus;
  htmlLink?: string;
  created?: string;
  updated?: string;
  summary?: string;
  description?: string;
  location?: string;
  colorId?: string;
  creator?: GcalPerson;
  organizer?: GcalPerson;
  start?: GcalDateTime;
  end?: GcalDateTime;
  endTimeUnspecified?: boolean;
  recurrence?: string[];
  recurringEventId?: string;
  originalStartTime?: GcalDateTime;
  transparency?: 'opaque' | 'transparent';
  visibility?: 'default' | 'public' | 'private' | 'confidential';
  iCalUID?: string;
  sequence?: number;
  attendees?: GcalAttendee[];
  attendeesOmitted?: boolean;
  extendedProperties?: GcalExtendedProperties;
  reminders?: GcalReminders;
  guestsCanModify?: boolean;
  guestsCanInviteOthers?: boolean;
  guestsCanSeeOtherGuests?: boolean;
  locked?: boolean;
  eventType?: 'birthday' | 'default' | 'focusTime' | 'fromGmail' | 'outOfOffice' | 'workingLocation';
  hangoutLink?: string;
  [extra: string]: unknown;
}

export type GcalAccessRole = 'freeBusyReader' | 'reader' | 'writer' | 'writerWithoutPrivateAccess' | 'owner';

export interface GcalCalendarListEntry {
  kind?: 'calendar#calendarListEntry';
  id: string;
  summary?: string;
  summaryOverride?: string;
  description?: string;
  timeZone?: string;
  colorId?: string;
  backgroundColor?: string;
  foregroundColor?: string;
  selected?: boolean;
  hidden?: boolean;
  deleted?: boolean;
  primary?: boolean;
  accessRole: GcalAccessRole;
  defaultReminders?: { method: string; minutes: number }[];
}

export interface GcalEventsListResponse {
  kind?: 'calendar#events';
  etag?: string;
  summary?: string;
  updated?: string;
  timeZone?: string;
  accessRole?: GcalAccessRole;
  nextPageToken?: string;
  nextSyncToken?: string;
  items?: GcalEvent[];
}

export interface GcalCalendarListResponse {
  items?: GcalCalendarListEntry[];
  nextPageToken?: string;
  nextSyncToken?: string;
}

export interface EventsListParams {
  syncToken?: string;
  pageToken?: string;
  maxResults?: number;
  singleEvents?: boolean;
  showDeleted?: boolean;
  timeMin?: string;
  timeMax?: string;
}

/** Thrown by GcalClient implementations for non-2xx responses. */
export class GcalError extends Error {
  constructor(
    public readonly status: number,
    message: string,
    public readonly body?: unknown,
  ) {
    super(message);
    this.name = 'GcalError';
  }
}

export interface GcalClient {
  listCalendars(): Promise<GcalCalendarListEntry[]>;
  listEvents(calendarId: string, params: EventsListParams): Promise<GcalEventsListResponse>;
  getEvent(calendarId: string, eventId: string): Promise<GcalEvent>;
  insertEvent(calendarId: string, event: Partial<GcalEvent>): Promise<GcalEvent>;
  patchEvent(calendarId: string, eventId: string, patch: Partial<GcalEvent>): Promise<GcalEvent>;
  updateEvent(calendarId: string, eventId: string, event: GcalEvent): Promise<GcalEvent>;
  deleteEvent(calendarId: string, eventId: string): Promise<void>;
  /** Google's own expansion of a recurring series; used for "this and following" edits. */
  listInstances(
    calendarId: string,
    eventId: string,
    params: { timeMin?: string; timeMax?: string; originalStart?: string; pageToken?: string; maxResults?: number; showDeleted?: boolean },
  ): Promise<GcalEventsListResponse>;
}
