/// <reference lib="webworker" />
/**
 * Service worker: offline shell (precache) + Web Push + notification actions.
 * Acknowledge/snooze from a notification are written to IndexedDB so the app
 * picks them up, and mirrored to the server (which also drives Web Push).
 */
import { precacheAndRoute, cleanupOutdatedCaches } from 'workbox-precaching';
import { clientsClaim } from 'workbox-core';
import { openDB } from 'idb';

declare let self: ServiceWorkerGlobalScope;

self.skipWaiting();
clientsClaim();
cleanupOutdatedCaches();
precacheAndRoute(self.__WB_MANIFEST);

async function updateLocalAlerts(fn: (s: { acked: Record<string, string>; snoozed: Record<string, string> }) => void) {
  const db = await openDB('time-manager', 1, {
    upgrade(d) {
      if (!d.objectStoreNames.contains('kv')) d.createObjectStore('kv');
    },
  });
  const cur = ((await db.get('kv', 'local-alerts')) as { acked: Record<string, string>; snoozed: Record<string, string> } | undefined) ?? { acked: {}, snoozed: {} };
  fn(cur);
  await db.put('kv', cur, 'local-alerts');
  const clientList = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
  for (const c of clientList) c.postMessage({ type: 'local-alerts-changed' });
}

self.addEventListener('push', (event) => {
  const data = (() => {
    try {
      return event.data?.json() as { title?: string; body?: string; tag?: string; instanceKey?: string; sound?: string };
    } catch {
      return { title: 'Time Manager', body: event.data?.text() };
    }
  })();
  const options: NotificationOptions & { renotify?: boolean; actions?: { action: string; title: string }[] } = {
    body: data.body,
    tag: data.tag ?? 'tm',
    renotify: true,
    requireInteraction: true,
    data: { instanceKey: data.instanceKey },
    icon: new URL('icons/icon-192.png', self.registration.scope).toString(),
    badge: new URL('icons/icon-192.png', self.registration.scope).toString(),
    silent: data.sound === 'silent',
    actions: data.instanceKey
      ? [
          { action: 'ack', title: 'Acknowledge' },
          { action: 'snooze', title: 'Snooze 5m' },
        ]
      : [],
  };
  event.waitUntil(self.registration.showNotification(data.title ?? 'Time Manager', options));
});

self.addEventListener('notificationclick', (event) => {
  const key = (event.notification.data as { instanceKey?: string } | undefined)?.instanceKey;
  const action = event.action;
  event.notification.close();
  event.waitUntil(
    (async () => {
      if (key && (action === 'ack' || action === 'snooze')) {
        await updateLocalAlerts((s) => {
          if (action === 'ack') s.acked[key] = new Date().toISOString();
          else s.snoozed[key] = new Date(Date.now() + 5 * 60_000).toISOString();
        });
        await fetch(new URL('api/push/ack', self.registration.scope).toString(), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'TimeManager' },
          body: JSON.stringify({ instanceKey: key, action, minutes: 5 }),
        }).catch(() => undefined);
        return;
      }
      const all = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
      const url = key ? `${self.registration.scope}?focus=${encodeURIComponent(key)}` : self.registration.scope;
      const existing = all[0];
      if (existing) {
        await existing.focus();
        existing.postMessage({ type: 'focus-instance', instanceKey: key });
      } else await self.clients.openWindow(url);
    })(),
  );
});
