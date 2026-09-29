# Time Manager

A personal time-management app layered on **Google Calendar**: a denser, keyboard-friendly desktop interface, a
phone-first "Now / Next / Alarm" view, and **nagging alerts that keep reminding you until you acknowledge them**.

Google Calendar stays the canonical schedule, so anyone you share your calendar with sees the full detail in ordinary
Google Calendar. Time Manager's per-event configuration lives in Google's `extendedProperties.private` on the event —
never in the description, never in a second database.

```
Google Calendar  ──(Calendar API, sync tokens)──▶  @tm/core  ──▶  Desktop UI / PWA / (later) native iOS
   canonical schedule + sharing                     model, sync,       ▲
   extendedProperties.private = tm_* config         recurrence,        └── platform alert delivery
                                                     alert planner          (foreground, Web Push, native bridge)
```

## What works today (Phase 1 + Phase 2)

- Google OAuth (authorization-code flow with refresh token, `calendar.events` + `calendar.calendarlist.readonly` only)
- Full sync then incremental sync with `nextSyncToken`, 410 GONE recovery, pagination
- All calendars you can see: owned, shared, read-only, events you were invited to (permissions explained in the UI)
- Recurring events expanded client-side (RRULE / RDATE / EXDATE in the event's own time zone, DST-safe), with
  moved and cancelled occurrences overlaid
- Create / edit / move / resize / delete events; recurring scope prompt (this event / this and following / all)
- "Configure for Time Manager" on any event → `tm_*` private extended properties (compact, versioned `tm_v=1`)
- Alert policies: none · once · every 1/5/10 min · custom interval · until acknowledged or until the event ends,
  lead time, sound choice, tags
- Acknowledge / snooze (1–60 min); acks are stored locally **and** mirrored to the event (`tm_ack`) when writable,
  so acknowledging on the phone silences the desktop too
- Desktop: 1–14 day dense time grid, zoom, drag to move, drag bottom edge to resize, drag on empty space to create,
  Alt-drag to duplicate, search, full keyboard control (`?` shows the map)
- Mobile: Now view (current activity with progress, next activity, active alarms with Ack/Snooze, quick
  "+15m / Start now / Tomorrow" rescheduling), agenda, 3-day grid, bottom-sheet editor
- PWA: installable, offline shell, notifications via the service worker, sounds (WebAudio), vibration
- Static hosting mode (GitHub Pages) with browser-side Google sign-in
- Optional **Web Push**: the server runs the same core planner every minute and pushes each reminder, so an installed
  PWA keeps nagging while closed (iOS 16.4+ Home Screen app)
- Native bridge contract for a future iOS wrapper (`docs/NATIVE_BRIDGE.md`)

## Easiest way to try it: the static GitHub Pages build

Every push to `main` (and to `claude/**` branches) runs `.github/workflows/pages.yml`, which builds the PWA in
**static mode** and publishes it to `https://<user>.github.io/time-management/`. In static mode there is no
server: the browser signs in to Google directly (OAuth implicit flow, redirect based, no client secret) and calls
the Calendar API itself. Everything else is identical, including install-to-Home-Screen. Only server-side Web
Push is unavailable there.

One-time setup (5 minutes, works from a phone):

1. https://console.cloud.google.com → create a project → **APIs & Services → Library** → enable **Google Calendar API**.
2. **OAuth consent screen** → External → add your Google account under **Test users**.
3. **Credentials → Create credentials → OAuth client ID → Web application** and add the authorized redirect URI
   `https://<user>.github.io/time-management/` (exactly, with the trailing slash). Add
   `http://localhost:5173/` too if you will run the dev server in static mode.
4. Open the site, tap **Setup / change client ID**, paste the client ID, then **Sign in with Google**.
   (Or store it as a repository variable `GOOGLE_CLIENT_ID` so the workflow bakes it in.)

Access tokens last an hour; the app renews them silently by bouncing through Google when you return to it.

## Quick start (with the server)

Requirements: Node 20+ (tested on 22) and a Google Cloud project.

### 1. Create the Google OAuth client

1. https://console.cloud.google.com → create/select a project.
2. **APIs & Services → Library** → enable **Google Calendar API**.
3. **APIs & Services → OAuth consent screen** → External, fill in the app name, add yourself under **Test users**
   (a personal app can stay in "Testing"; no verification needed. Google may expire refresh tokens of
   testing-mode apps after 7 days — if that happens, either publish the app (no verification needed for
   your own use with a warning screen) or just sign in again.)
4. **APIs & Services → Credentials → Create credentials → OAuth client ID → Web application**.
   Authorized redirect URIs:
   - `http://localhost:5173/auth/callback` (development)
   - `https://YOUR-DOMAIN/auth/callback` (production)
5. Copy the client ID and secret.

### 2. Configure

```bash
cp packages/server/.env.example packages/server/.env
# edit: GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, SESSION_SECRET (any random string)
npm install
```

### 3. Run in development

```bash
npm run dev        # server on :8787 + Vite on :5173 (Vite proxies /api and /auth to the server)
```

Open http://localhost:5173 and sign in with Google. Or open http://localhost:5173/?mock=1 for a demo with sample
data and no Google account.

### 4. Run in production (any Node host)

```bash
npm run build                     # builds packages/web/dist
APP_URL=https://tm.example.com NODE_ENV=production npm start
```

The server serves the built PWA and the API on `PORT` (default 8787). Put it behind HTTPS (Caddy, nginx, Fly.io,
Railway, a Raspberry Pi with a tunnel…). HTTPS is required for installation, notifications and Web Push on iPhone.
Keep `DATA_DIR` (default `./data`) on persistent storage: it holds only your OAuth refresh token, push
subscriptions and the push scheduler's sync cache — no calendar of record.

### 5. Install on iPhone

Safari → open the site → Share → **Add to Home Screen**. Open it from the Home Screen, then in **More → Alerts**
allow notifications and, if the server has VAPID keys, enable *Background alerts (Web Push)*.

### 6. Optional: Web Push (alerts while the app is closed)

```bash
npx web-push generate-vapid-keys
# put the keys in packages/server/.env as VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY, set VAPID_SUBJECT=mailto:you@…
```

Restart the server. Each device enables push from Settings. Notification buttons **Acknowledge** / **Snooze 5m**
work straight from the lock screen (via the service worker) and are reported to the server so the push scheduler
stops too.

## Keyboard (desktop)

`n` new · `t` today · `←/→` navigate · `d/w/g/h` day / multi-day / agenda / now · `1–9` days in view ·
`j/k` select next/prev · `Enter` edit · `Delete` delete · `[`/`]` move ±15 min · `Shift+[`/`]` resize ·
`a` acknowledge · `s` snooze 5 min · `r` sync · `/` search · `+/-` zoom · `,` settings · `?` help

## How Time Manager data is stored on the event

`extendedProperties.private` (visible only to your account, on your copy of the event):

| key | meaning |
| --- | --- |
| `tm_v` | schema version (`1`) |
| `tm_alert` | `none` · `once` · `repeat` |
| `tm_lead` | minutes before start to begin alerting |
| `tm_int` | repeat interval (minutes) |
| `tm_until` | `ack` (until acknowledged) · `end` (until the event ends) |
| `tm_sound` | `chime` · `alarm` · `silent` (absent = default) |
| `tm_tags` | comma-separated tags |
| `tm_own` | `1` on a recurring-event exception that carries its own config (otherwise exceptions inherit the series) |
| `tm_ack` | `<instanceStart>|<ackTime>` — last acknowledged occurrence (series-level for recurring events) |
| `tm_snooze` | `<instanceStart>|<until>` |

For a recurring event the configuration is written to the **parent** event by default; "this occurrence only"
creates a single exception exactly like Google Calendar does. Ordinary events without `tm_v` are shown normally and
can be configured with one click. Read-only events (calendars where you are a reader, locked events) are displayed
but never modified; the UI explains why and mentions the planned "Create configurable copy" feature.

## Repository layout

```
packages/core     pure TypeScript: Calendar API types, tz helpers, tm_* metadata codec, recurrence expansion,
                  sync engine, alert planner, operations (create/move/configure/ack/snooze/delete), mock API
packages/server   tiny Hono server: Google OAuth, /api/gcal proxy, sessions, optional Web Push scheduler
packages/web      React + Vite PWA: desktop grid, mobile Now view, editor, settings, service worker
docs/             ARCHITECTURE.md, NATIVE_BRIDGE.md
```

## Tests

```bash
npm test            # core unit tests (recurrence/DST, sync tokens & 410, metadata, alert planner, operations)
npm run typecheck
```

Browser smoke test (mock data, desktop + iPhone viewport, drag/drop, editor, alerts):

```bash
npm run build && (cd packages/server && NODE_ENV=production npx tsx src/index.ts &) && npm run e2e   # needs a Chromium (npx playwright install chromium, or CHROME_PATH=…)
```

## Known limitations / next steps

- Alerts in the browser fire while the page is open (foreground or a background tab where the browser allows
  timers). A closed/suspended iOS PWA only gets alerts through Web Push (optional server feature) or the future
  native wrapper. This is the documented platform limitation the architecture is built around.
- Drag-and-drop in the time grid is mouse-only; on touch use the editor's quick chips or the Now view's actions.
- "This and following" splits the series (truncates the old one with `UNTIL`, inserts a new series). Existing
  exceptions after the split point stay attached to the old series, as Google itself does when you split.
- Web Push acknowledgements from the lock screen are stored server-side and locally; they reach the event's
  `tm_ack` once the app is opened and acknowledges again, or the next time the app syncs and you tap Acknowledge.
- Phase 3 (native iOS wrapper with local notifications / alarms) is specified in `docs/NATIVE_BRIDGE.md` but not built.
