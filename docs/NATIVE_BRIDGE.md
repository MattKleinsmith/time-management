# Native bridge (Phase 3)

The web app is the whole product; a native iOS wrapper only needs to (1) host it in a `WKWebView`, (2) receive the
reminder schedule, and (3) turn it into local notifications that fire while the phone is locked.

## Contract

The web app calls, whenever the schedule changes (≈ every second only if something changed):

```js
window.webkit.messageHandlers.timeManager.postMessage({
  type: 'schedule',
  reminders: [
    { instanceKey: 'primary/abc123/2026-09-29T14:00:00.000Z',
      title: 'Exercise', body: 'starts in 10 min · Gym',
      fireAt: '2026-09-29T13:50:00.000Z', sound: 'alarm', sequence: 0 },
    // … up to 60 entries covering the next 12 hours, already expanded per repeat interval
  ]
});
// and
{ type: 'cancel', instanceKey: '…' }   // after acknowledge / snooze
```

(`window.TimeManagerNative.postMessage(jsonString)` is used instead when that object exists, e.g. Android.)

The reminders are produced by `scheduleReminders()` in `@tm/core/alerts.ts`: acknowledgement, snooze, lead time
and repeat interval are already applied. The wrapper should:

1. Cancel all pending `UNNotificationRequest`s whose identifier starts with `tm:` and re-add one request per
   reminder (`identifier = "tm:<instanceKey>:<sequence>"`, `UNCalendarNotificationTrigger` at `fireAt`,
   `interruptionLevel = .timeSensitive`, sound mapped from `sound`).
2. On `cancel`, remove pending + delivered requests for that `instanceKey`.
3. Register notification actions **Acknowledge** and **Snooze 5 min**; when tapped, open the web view at
   `/?ack=<instanceKey>` or `/?snooze=<instanceKey>` (already handled by the web app).
4. On `applicationDidBecomeActive`, evaluate `window.dispatchEvent(new Event('focus'))` so the web app re-plans.

Because the schedule only covers 12 hours, the wrapper should also use a `BGAppRefreshTask` (or simply rely on
the user opening the app) to let the web app refresh it. Web Push (server-side) remains available as a second
channel; both can coexist because notifications are tagged per instance.
