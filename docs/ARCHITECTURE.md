# Architecture

## Principles

1. **Google Calendar is the schedule.** Every event, its time, recurrence, description, attendees and visibility
   are ordinary Google Calendar data, so sharing through Google works unchanged.
2. **App configuration rides on the event** in `extendedProperties.private` (`tm_*` keys, `tm_v` versioned), never
   in the description. Google enforces 44-char keys / 1024-char values / 300 properties / 32 kB per event; we use
   ~10 short keys.
3. **No application database.** The browser keeps an IndexedDB *cache* (events + sync token) because Google's
   incremental sync requires the client to hold the previous state; it is disposable ("Re-download calendar").
   The optional push scheduler keeps the same cache on the server for the same reason.
4. **The core never relies on a JavaScript timer surviving in the background.** It produces a schedule; platform
   layers deliver it.

## Packages

### `@tm/core` (pure TypeScript, no DOM)

| module | responsibility |
| --- | --- |
| `types.ts` | Calendar API v3 resource subset, `GcalClient` interface, `GcalError` |
| `time.ts` | Intl-based zone math (wall clock ⇄ instant, DST-safe), RFC3339 formatting |
| `metadata.ts` | `TmConfig` ⇄ `tm_*` properties, patch semantics (`null` deletes a key) |
| `recurrence.ts` | RRULE/RDATE/EXDATE expansion with `rrule`, in the event's zone; DTSTART always included |
| `model.ts` | `buildInstances()` → concrete `EventInstance`s for a window; exception overlay; permissions |
| `sync.ts` | `SyncEngine`: full sync → `nextSyncToken` → incremental; pagination; 410 → full resync; `showDeleted=true` on every request (required with sync tokens) |
| `alerts.ts` | `alertStatusFor()` / `planAlerts()` / `scheduleReminders()` — pure functions of (instances, acks, now) |
| `operations.ts` | `EventOperations`: create, change time, details, configure, acknowledge, snooze, delete with recurring scopes |
| `delivery.ts` | `AlertDelivery` interface + native bridge message shape |
| `client.ts` | fetch-based `GcalClient` (direct API or same-origin proxy) |
| `mock.ts` | in-memory Calendar API simulator (sync tokens, pages, 410, instances) for tests and demo mode |

### Sync

```
listCalendars()
for each calendar:
  if syncToken: GET events?syncToken=…&maxResults=2500&singleEvents=false&showDeleted=true  (+pageToken pages)
     410 → drop cache, fall through
  else:          GET events?maxResults=2500&singleEvents=false&showDeleted=true              (+pageToken pages)
  apply items: cancelled single → delete; cancelled exception → keep (suppresses the occurrence);
               cancelled master → delete master + its exceptions
  store nextSyncToken from the last page
```

`singleEvents=false` keeps the recurring parent + exceptions in the cache (one record per series, not thousands
of instances), and the core expands occurrences locally for whatever window the UI shows.

### Recurring events

- Occurrence key = `originalStartTime` (ISO instant, or `YYYY-MM-DD` for all-day). Exceptions are matched on it.
- An exception uses its **own** `tm_*` config only when `tm_own=1`; otherwise it inherits the series config, even
  if Google copied the parent's properties into it.
- Editing scope: `series` patches the parent (no exceptions created); `instance` patches Google's instance id
  (looked up with `events.instances?originalStart=…`, never guessed); `following` = truncate parent with `UNTIL`
  and insert a new series (COUNT is reduced by the occurrences already consumed).

### Alerts

For an instance with policy *P* and now *t*:

```
alertStart = start − lead
scheduled  if t < alertStart
acked      if local ack for instance key, or tm_ack.instanceStart ≥ this occurrence (series) / == (single)
snoozed    if a snooze (local or tm_snooze) ends after t
active     otherwise, until expiresAt = min(alertStart + maxNagHours, event end if until=end, +60 min if once)
  repeat:  reminders at alertStart + k·interval (or from the end of the last snooze); firedCount = k+1
```

`planAlerts()` returns active / snoozed / scheduled + the next moment anything changes.
`scheduleReminders(from, to)` returns explicit `{fireAt, title, body, sound, sequence}` entries — this is what a
native layer or push scheduler pre-registers with the OS.

### Acknowledgement storage

Ack/snooze are always written locally (IndexedDB) and, when the event is writable, mirrored to the event as
`tm_ack` / `tm_snooze` (on the series parent for recurring events). Any device that syncs sees the ack. Read-only
events fall back to local-only acks.

### `@tm/server`

- `/auth/login` → Google (offline access, consent) → `/auth/callback` exchanges the code, identifies the account by
  its primary calendar id (no extra scopes), stores the refresh token in `data/store.json` (mode 0600), sets a
  signed httpOnly session cookie. `ALLOWED_EMAILS` restricts sign-in.
- `/api/gcal/*` → proxies to `https://www.googleapis.com/calendar/v3/*` with a fresh access token (refreshed via the
  refresh token). Mutations require the `X-Requested-With: TimeManager` header (CSRF guard).
- `/api/push/*` → subscriptions, test, ack. With VAPID keys, a 60-second scheduler runs the shared core sync +
  planner per user and sends a push for every reminder that became due.
- Serves `packages/web/dist` in production.

### `@tm/web`

- `lib/store.ts` (zustand): engine, instances cache, view state, commands with scope prompts.
- `lib/delivery.ts`: foreground ticker → `alertTick()` every second while visible; delivers new reminders via
  `WebAlertDelivery` (overlay + SW notification + WebAudio + vibration) and posts the upcoming plan to a native
  bridge if present. On `visibilitychange` it re-plans immediately, so anything missed while suspended is surfaced.
- `sw.ts`: precache, Web Push → notification, notification actions write acks to IndexedDB and `/api/push/ack`.

## Platform alert delivery matrix

| platform | mechanism | works when |
| --- | --- | --- |
| Desktop browser tab | ticker + Notification API + audio | tab open (background tabs: timers throttled to ≥1/min, still fine for nagging) |
| Installed PWA (Android) | same + Web Push | app open; closed if Web Push configured |
| Installed PWA (iOS 16.4+) | Web Push (lock-screen notification, default sound); in-app overlay when open | closed/locked only with Web Push; no custom sounds |
| Native iOS wrapper (Phase 3) | `UNUserNotificationCenter` local notifications pre-scheduled from `scheduleReminders()`, critical/time-sensitive if entitled | always |
