/**
 * Web Push delivery: a server-side platform layer for the core alert planner.
 *
 * Every minute (when VAPID keys are configured) the scheduler runs the shared
 * core: incremental Google Calendar sync for each signed-in user, builds the
 * instances for the next day, asks `planAlerts` what is active, and sends a
 * push notification for each reminder that became due. This is what lets an
 * installed iOS/Android PWA receive nagging alerts while it is closed.
 *
 * The server's sync cache is exactly the same cache the browser keeps; it is
 * never authoritative. Acknowledgements written to Google (tm_ack) are picked
 * up on the next sync; acknowledgements made from the notification itself hit
 * /api/push/ack and are applied immediately.
 */
import { Hono } from 'hono';
import webpush from 'web-push';
import {
  buildInstances,
  createHttpGcalClient,
  emptyLocalAlertState,
  planAlerts,
  SyncEngine,
  type LocalAlertState,
  type SyncPersistence,
  type SyncSnapshot,
  formatReminderBody,
} from '@tm/core';
import { config } from './config';
import type { FileStore } from './store';
import { randomId } from './session';

export function createPushService(store: FileStore, accessTokenFor: (userId: string) => Promise<string>) {
  const enabled = !!(config.vapidPublicKey && config.vapidPrivateKey);
  if (enabled) webpush.setVapidDetails(config.vapidSubject, config.vapidPublicKey, config.vapidPrivateKey);

  const routes = new Hono<{ Variables: { userId: string } }>();

  routes.post('/subscribe', async (c) => {
    if (!enabled) return c.json({ error: 'push disabled' }, 400);
    const body = (await c.req.json()) as { subscription: { endpoint: string; keys: { p256dh: string; auth: string } }; label?: string };
    const sub = body.subscription;
    if (!sub?.endpoint || !sub.keys?.p256dh || !sub.keys?.auth) return c.json({ error: 'invalid subscription' }, 400);
    const userId = c.get('userId');
    await store.update((d) => {
      d.push = d.push.filter((p) => p.endpoint !== sub.endpoint);
      d.push.push({ id: randomId(8), endpoint: sub.endpoint, keys: sub.keys, userId, createdAt: new Date().toISOString(), label: body.label });
    });
    return c.json({ ok: true });
  });

  routes.delete('/subscribe', async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { endpoint?: string };
    await store.update((d) => {
      d.push = d.push.filter((p) => !(p.userId === c.get('userId') && (!body.endpoint || p.endpoint === body.endpoint)));
    });
    return c.json({ ok: true });
  });

  routes.get('/status', (c) => {
    const subs = store.get().push.filter((p) => p.userId === c.get('userId'));
    return c.json({ enabled, subscriptions: subs.map((s) => ({ id: s.id, label: s.label, createdAt: s.createdAt, endpoint: s.endpoint.slice(0, 40) + '…' })) });
  });

  routes.post('/test', async (c) => {
    if (!enabled) return c.json({ error: 'push disabled' }, 400);
    const n = await sendToUser(c.get('userId'), { title: 'Time Manager', body: 'Push notifications are working.', tag: 'tm-test', sound: 'default' });
    return c.json({ sent: n });
  });

  /** Acknowledge / snooze straight from a notification (called by the service worker). */
  routes.post('/ack', async (c) => {
    const body = (await c.req.json()) as { instanceKey: string; action: 'ack' | 'snooze'; minutes?: number };
    const userId = c.get('userId');
    await store.update((d) => {
      const st = (d.pushState[userId] ??= { sent: {} });
      const local = (st.localAlerts as LocalAlertState | undefined) ?? emptyLocalAlertState();
      if (body.action === 'ack') local.acked[body.instanceKey] = new Date().toISOString();
      else local.snoozed[body.instanceKey] = new Date(Date.now() + (body.minutes ?? 5) * 60_000).toISOString();
      st.localAlerts = local;
    });
    return c.json({ ok: true });
  });

  async function sendToUser(userId: string, payload: Record<string, unknown>): Promise<number> {
    const subs = store.get().push.filter((p) => p.userId === userId);
    let sent = 0;
    for (const s of subs) {
      try {
        await webpush.sendNotification({ endpoint: s.endpoint, keys: s.keys }, JSON.stringify(payload), { TTL: 120, urgency: 'high' });
        sent++;
      } catch (e) {
        const status = (e as { statusCode?: number }).statusCode;
        if (status === 404 || status === 410) {
          await store.update((d) => (d.push = d.push.filter((p) => p.endpoint !== s.endpoint)));
        } else {
          console.error('push send failed', status, (e as Error).message);
        }
      }
    }
    return sent;
  }

  const engines = new Map<string, SyncEngine>();

  function engineFor(userId: string, getToken: (id: string) => Promise<string>): SyncEngine {
    let e = engines.get(userId);
    if (e) return e;
    const client = createHttpGcalClient({
      baseUrl: 'https://www.googleapis.com/calendar/v3',
      headers: async () => ({ Authorization: `Bearer ${await getToken(userId)}` }),
    });
    const persistence: SyncPersistence = {
      async load() {
        return (store.get().pushState[userId]?.syncSnapshot as SyncSnapshot | undefined) ?? null;
      },
      async save(snapshot) {
        await store.update((d) => {
          (d.pushState[userId] ??= { sent: {} }).syncSnapshot = snapshot;
        });
      },
      async clear() {
        await store.update((d) => {
          if (d.pushState[userId]) d.pushState[userId].syncSnapshot = undefined;
        });
      },
    };
    e = new SyncEngine(client, persistence);
    engines.set(userId, e);
    return e;
  }

  let timer: NodeJS.Timeout | undefined;
  let running = false;

  async function tick() {
    if (running) return;
    running = true;
    try {
      const users = Object.keys(store.get().users).filter((u) => store.get().push.some((p) => p.userId === u));
      for (const userId of users) {
        try {
          await tickUser(userId, accessTokenFor);
        } catch (e) {
          console.error('push tick failed for', userId, (e as Error).message);
        }
      }
    } finally {
      running = false;
    }
  }

  async function tickUser(userId: string, getToken: (id: string) => Promise<string>) {
    const engine = engineFor(userId, getToken);
    await engine.load();
    await engine.sync();
    const now = new Date();
    const instances = buildInstances(engine.getCalendarSnapshots(), {
      windowStart: new Date(now.getTime() - 24 * 3600_000),
      windowEnd: new Date(now.getTime() + 24 * 3600_000),
      timeZone: 'UTC',
    });
    const st = store.get().pushState[userId] ?? { sent: {} };
    const local = (st.localAlerts as LocalAlertState | undefined) ?? emptyLocalAlertState();
    const plan = planAlerts(instances, now, local);
    const sent = { ...st.sent };
    let changed = false;
    for (const a of plan.active) {
      const key = a.instance.key;
      const already = sent[key] ?? 0;
      if (already >= a.firedCount) continue;
      await sendToUser(userId, {
        title: a.instance.title,
        body: formatReminderBody(a.instance, now),
        tag: `tm-${key}`,
        instanceKey: key,
        sequence: a.firedCount,
        sound: a.policy.sound,
        renotify: true,
      });
      sent[key] = a.firedCount;
      changed = true;
    }
    // Forget bookkeeping for instances no longer in the plan.
    for (const k of Object.keys(sent)) {
      if (!plan.active.some((a) => a.instance.key === k) && !plan.snoozed.some((a) => a.instance.key === k)) {
        delete sent[k];
        changed = true;
      }
    }
    if (changed) await store.update((d) => ((d.pushState[userId] ??= { sent: {} }).sent = sent));
  }

  return {
    enabled,
    routes,
    start() {
      if (!enabled) return;
      timer = setInterval(() => void tick(), 60_000);
      void tick();
    },
    stop() {
      if (timer) clearInterval(timer);
    },
  };
}
