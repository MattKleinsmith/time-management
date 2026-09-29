/**
 * fetch-based Google Calendar API client. Works against the real API (with a
 * bearer token) or against a same-origin proxy that injects credentials.
 */
import {
  GcalError,
  type EventsListParams,
  type GcalCalendarListEntry,
  type GcalCalendarListResponse,
  type GcalClient,
  type GcalEvent,
  type GcalEventsListResponse,
} from './types';

export interface HttpGcalClientOptions {
  /** e.g. "https://www.googleapis.com/calendar/v3" or "/api/gcal". */
  baseUrl: string;
  fetch?: typeof fetch;
  /** Extra headers per request (Authorization for direct API use). */
  headers?: () => Promise<Record<string, string>> | Record<string, string>;
  /** Called on 401 so the host can refresh credentials; return true to retry once. */
  onUnauthorized?: () => Promise<boolean>;
}

const EVENT_FIELDS =
  'kind,etag,nextPageToken,nextSyncToken,timeZone,accessRole,items(id,etag,status,htmlLink,created,updated,summary,description,location,colorId,creator,organizer,start,end,endTimeUnspecified,recurrence,recurringEventId,originalStartTime,transparency,visibility,iCalUID,sequence,attendees,attendeesOmitted,extendedProperties,reminders,guestsCanModify,locked,eventType,hangoutLink)';

export function createHttpGcalClient(opts: HttpGcalClientOptions): GcalClient {
  const f = opts.fetch ?? globalThis.fetch.bind(globalThis);
  const base = opts.baseUrl.replace(/\/$/, '');

  async function request<T>(method: string, path: string, query?: Record<string, unknown>, body?: unknown, retry = true): Promise<T> {
    const url = new URL(base + path, 'http://placeholder.invalid');
    const isAbsolute = /^https?:/i.test(base);
    for (const [k, v] of Object.entries(query ?? {})) {
      if (v === undefined || v === null || v === '') continue;
      url.searchParams.set(k, String(v));
    }
    const finalUrl = isAbsolute ? url.toString() : url.pathname + url.search;
    const headers: Record<string, string> = { Accept: 'application/json', ...(await opts.headers?.()) };
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    const res = await f(finalUrl, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), credentials: 'same-origin' });
    if (res.status === 401 && retry && opts.onUnauthorized) {
      if (await opts.onUnauthorized()) return request<T>(method, path, query, body, false);
    }
    if (res.status === 204) return undefined as T;
    const text = await res.text();
    let json: unknown = undefined;
    try {
      json = text ? JSON.parse(text) : undefined;
    } catch {
      json = text;
    }
    if (!res.ok) {
      const msg =
        (json as { error?: { message?: string } })?.error?.message ?? (typeof json === 'string' ? json : `${res.status} ${res.statusText}`);
      throw new GcalError(res.status, msg, json);
    }
    return json as T;
  }

  const enc = encodeURIComponent;

  return {
    async listCalendars() {
      const items: GcalCalendarListEntry[] = [];
      let pageToken: string | undefined;
      do {
        const res = await request<GcalCalendarListResponse>('GET', '/users/me/calendarList', { pageToken, maxResults: 250, showHidden: true });
        items.push(...(res.items ?? []));
        pageToken = res.nextPageToken;
      } while (pageToken);
      return items;
    },
    async listEvents(calendarId: string, params: EventsListParams) {
      try {
        return await request<GcalEventsListResponse>('GET', `/calendars/${enc(calendarId)}/events`, { ...params, fields: EVENT_FIELDS });
      } catch (e) {
        // A rejected field selector must never break sync: fall back to the full resource.
        if (e instanceof GcalError && e.status === 400 && /field/i.test(e.message)) {
          return request<GcalEventsListResponse>('GET', `/calendars/${enc(calendarId)}/events`, { ...params });
        }
        throw e;
      }
    },
    getEvent(calendarId, eventId) {
      return request<GcalEvent>('GET', `/calendars/${enc(calendarId)}/events/${enc(eventId)}`);
    },
    insertEvent(calendarId, event) {
      return request<GcalEvent>('POST', `/calendars/${enc(calendarId)}/events`, undefined, event);
    },
    patchEvent(calendarId, eventId, patch) {
      return request<GcalEvent>('PATCH', `/calendars/${enc(calendarId)}/events/${enc(eventId)}`, undefined, patch);
    },
    updateEvent(calendarId, eventId, event) {
      return request<GcalEvent>('PUT', `/calendars/${enc(calendarId)}/events/${enc(eventId)}`, undefined, event);
    },
    async deleteEvent(calendarId, eventId) {
      await request<void>('DELETE', `/calendars/${enc(calendarId)}/events/${enc(eventId)}`);
    },
    listInstances(calendarId, eventId, params) {
      return request<GcalEventsListResponse>('GET', `/calendars/${enc(calendarId)}/events/${enc(eventId)}/instances`, { ...params });
    },
  };
}
