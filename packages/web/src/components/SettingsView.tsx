import { useEffect, useState } from 'react';
import { useStore } from '../lib/store';
import { TmConfigForm } from './EventEditor';
import { defaultTmConfig } from '@tm/core';
import { apiPost, BASE, isMockMode, isStaticMode, logout } from '../lib/api';
import { unlockAudio, playSound } from '../lib/delivery';

function urlBase64ToUint8Array(base64String: string) {
  const padding = '='.repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(base64);
  return Uint8Array.from([...raw].map((c) => c.charCodeAt(0)));
}

export function SettingsView() {
  const settings = useStore((s) => s.settings);
  const calendars = useStore((s) => s.calendars);
  const me = useStore((s) => s.me);
  const notif = useStore((s) => s.notificationPermission);
  const lastSyncAt = useStore((s) => s.lastSyncAt);
  const engine = useStore((s) => s.engine);
  const { setSettings, resetCache, setNotificationPermission, setAudioUnlocked, toast } = useStore.getState();
  const [pushSubscribed, setPushSubscribed] = useState<boolean | null>(null);
  const isStandalone = typeof window !== 'undefined' && (window.matchMedia('(display-mode: standalone)').matches || (navigator as { standalone?: boolean }).standalone === true);
  const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent);

  useEffect(() => {
    void (async () => {
      const reg = await navigator.serviceWorker?.getRegistration();
      const sub = await reg?.pushManager?.getSubscription();
      setPushSubscribed(!!sub);
    })();
  }, []);

  async function enablePush() {
    if (!me?.vapidPublicKey) return;
    try {
      const perm = await Notification.requestPermission();
      setNotificationPermission(perm);
      if (perm !== 'granted') return;
      const reg = await navigator.serviceWorker.ready;
      const sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: urlBase64ToUint8Array(me.vapidPublicKey) });
      await apiPost('/api/push/subscribe', { subscription: sub.toJSON(), label: navigator.userAgent.slice(0, 60) });
      setPushSubscribed(true);
      toast('success', 'Push notifications enabled on this device');
    } catch (e) {
      toast('error', `Push setup failed: ${(e as Error).message}`);
    }
  }
  async function disablePush() {
    const reg = await navigator.serviceWorker?.getRegistration();
    const sub = await reg?.pushManager?.getSubscription();
    if (sub) {
      await apiPost('/api/push/subscribe', { endpoint: sub.endpoint }, 'DELETE').catch(() => undefined);
      await sub.unsubscribe();
    }
    setPushSubscribed(false);
  }

  const visible = settings.visibleCalendarIds;
  const toggleCal = (id: string) => {
    const base = visible ?? calendars.filter((c) => c.selected !== false).map((c) => c.id);
    const next = base.includes(id) ? base.filter((x) => x !== id) : [...base, id];
    setSettings({ visibleCalendarIds: next });
  };

  return (
    <div className="settings">
      <section>
        <h2>Account</h2>
        <p>
          Signed in as <strong>{me?.email}</strong>
          {isMockMode() ? ' (demo mode with sample data)' : ''}. {lastSyncAt ? `Last synced ${lastSyncAt.toLocaleString()}.` : ''}
        </p>
        <div className="quick-row">
          <button className="btn" onClick={() => void resetCache()}>
            Re-download calendar (full sync)
          </button>
          <button
            className="btn"
            onClick={async () => {
              await logout(false);
              location.href = BASE;
            }}
          >
            Sign out
          </button>
          {!isMockMode() ? (
            <button
              className="btn danger"
              onClick={async () => {
                if (confirm('Disconnect Time Manager from your Google account? Your calendar is untouched.')) {
                  await logout(true);
                  location.href = BASE;
                }
              }}
            >
              Disconnect Google
            </button>
          ) : null}
        </div>
        {engine ? (
          <p className="muted small">
            Cached: {Object.values(engine.snapshot.calendars).map((c) => `${c.calendar.summaryOverride ?? c.calendar.summary} (${Object.keys(c.events).length})`).join(', ')}
          </p>
        ) : null}
      </section>

      <section>
        <h2>Calendars shown</h2>
        {calendars.map((c) => {
          const on = visible ? visible.includes(c.id) : c.selected !== false;
          return (
            <label key={c.id} className="row">
              <input type="checkbox" checked={on} onChange={() => toggleCal(c.id)} />
              <span className="dot" style={{ background: c.backgroundColor ?? '#888' }} />
              {c.summaryOverride ?? c.summary}
              <span className="muted small"> · {c.accessRole}</span>
            </label>
          );
        })}
        <div className="field">
          <label>Default calendar for new events</label>
          <select value={settings.defaultCalendarId ?? ''} onChange={(e) => setSettings({ defaultCalendarId: e.target.value || null })}>
            <option value="">Primary</option>
            {calendars
              .filter((c) => ['owner', 'writer'].includes(c.accessRole))
              .map((c) => (
                <option key={c.id} value={c.id}>
                  {c.summaryOverride ?? c.summary}
                </option>
              ))}
          </select>
        </div>
      </section>

      <section>
        <h2>Alerts</h2>
        <p className="muted small">Default policy for events you create here (and for "Configure for Time Manager").</p>
        <TmConfigForm
          value={defaultTmConfig({ alert: settings.defaultAlert })}
          onChange={(cfg) => cfg && setSettings({ defaultAlert: cfg.alert })}
        />
        <label className="row">
          <input type="checkbox" checked={settings.autoConfigureNewEvents} onChange={(e) => setSettings({ autoConfigureNewEvents: e.target.checked })} />
          Configure new events for Time Manager automatically
        </label>
        <label className="row">
          <input type="checkbox" checked={settings.soundEnabled} onChange={(e) => setSettings({ soundEnabled: e.target.checked })} /> Play sounds
          <button
            className="chip"
            onClick={() => {
              if (unlockAudio()) setAudioUnlocked(true);
              playSound('alarm');
            }}
          >
            test
          </button>
        </label>
        <label className="row">
          <input type="checkbox" checked={settings.vibrate} onChange={(e) => setSettings({ vibrate: e.target.checked })} /> Vibrate (where supported)
        </label>
        <div className="row">
          <label>Stop nagging after</label>
          <input type="number" min={1} max={72} value={settings.maxNagHours} onChange={(e) => setSettings({ maxNagHours: Math.max(1, Number(e.target.value) || 12) })} style={{ width: 70 }} />
          <span className="muted">hours if never acknowledged</span>
        </div>
        <div className="field">
          <label>Browser notifications</label>
          {notif === 'unsupported' ? (
            <p className="muted small">Not supported in this browser{isIOS && !isStandalone ? ' — on iPhone, add the app to your Home Screen first (Share → Add to Home Screen).' : '.'}</p>
          ) : notif === 'granted' ? (
            <p className="muted small">Allowed.</p>
          ) : notif === 'denied' ? (
            <p className="muted small">Blocked in browser settings.</p>
          ) : (
            <button className="btn" onClick={() => Notification.requestPermission().then((p) => setNotificationPermission(p))}>
              Allow notifications
            </button>
          )}
        </div>
        <div className="field">
          <label>Background alerts (Web Push)</label>
          {me?.push ? (
            pushSubscribed ? (
              <div className="quick-row">
                <span className="muted small">Enabled on this device.</span>
                <button className="btn small" onClick={() => apiPost('/api/push/test', {}).then(() => toast('info', 'Test push sent'))}>
                  Send test
                </button>
                <button className="btn small" onClick={disablePush}>
                  Disable
                </button>
              </div>
            ) : (
              <div>
                <button className="btn" onClick={enablePush} disabled={notif === 'unsupported'}>
                  Enable on this device
                </button>
                <p className="muted small">The server checks your calendar every minute and pushes each reminder, so nagging continues while the app is closed. On iPhone this requires iOS 16.4+ and the app installed to the Home Screen.</p>
              </div>
            )
          ) : (
            <p className="muted small">
              {isStaticMode()
                ? 'Not available on the static (GitHub Pages) build: there is no server to send pushes. Alerts fire while Time Manager is open; a native wrapper or the server build adds background delivery.'
                : 'Not configured on the server (set VAPID keys to enable). Without it, alerts fire only while Time Manager is open in the foreground.'}
            </p>
          )}
        </div>
        <p className="muted small">
          A native iOS wrapper can subscribe to the same reminder schedule through the bridge described in docs/NATIVE_BRIDGE.md to
          deliver true background alarms.
        </p>
      </section>

      <section>
        <h2>Display</h2>
        <div className="row">
          <label>Theme</label>
          <select value={settings.theme} onChange={(e) => setSettings({ theme: e.target.value as typeof settings.theme })}>
            <option value="dark">Dark</option>
            <option value="light">Light</option>
            <option value="system">System</option>
          </select>
        </div>
        <div className="row">
          <label>Time format</label>
          <select value={settings.timeFormat} onChange={(e) => setSettings({ timeFormat: e.target.value as '12h' | '24h' })}>
            <option value="12h">12-hour</option>
            <option value="24h">24-hour</option>
          </select>
        </div>
        <div className="row">
          <label>Days in grid</label>
          <input type="number" min={1} max={14} value={settings.daysInView} onChange={(e) => setSettings({ daysInView: Math.min(14, Math.max(1, Number(e.target.value) || 7)) })} style={{ width: 70 }} />
        </div>
        <div className="row">
          <label>Week starts on</label>
          <select value={settings.weekStartsOn} onChange={(e) => setSettings({ weekStartsOn: Number(e.target.value) as 0 | 1 | 6 })}>
            <option value={1}>Monday</option>
            <option value={0}>Sunday</option>
            <option value={6}>Saturday</option>
          </select>
        </div>
        <div className="row">
          <label>Grid hours</label>
          <input type="number" min={0} max={23} value={settings.dayStartHour} onChange={(e) => setSettings({ dayStartHour: Math.min(settings.dayEndHour - 1, Math.max(0, Number(e.target.value) || 0)) })} style={{ width: 60 }} />
          <span className="muted">to</span>
          <input type="number" min={1} max={24} value={settings.dayEndHour} onChange={(e) => setSettings({ dayEndHour: Math.max(settings.dayStartHour + 1, Math.min(24, Number(e.target.value) || 24)) })} style={{ width: 60 }} />
        </div>
        <div className="row">
          <label>Row height</label>
          <input type="range" min={24} max={200} value={settings.pxPerHour} onChange={(e) => setSettings({ pxPerHour: Number(e.target.value) })} />
          <span className="muted">{settings.pxPerHour}px / hour</span>
        </div>
        <div className="row">
          <label>Snap to</label>
          <select value={settings.snapMinutes} onChange={(e) => setSettings({ snapMinutes: Number(e.target.value) })}>
            {[5, 10, 15, 30].map((m) => (
              <option key={m} value={m}>
                {m} min
              </option>
            ))}
          </select>
        </div>
        <div className="row">
          <label>Default duration</label>
          <select value={settings.defaultDurationMin} onChange={(e) => setSettings({ defaultDurationMin: Number(e.target.value) })}>
            {[15, 30, 45, 60, 90].map((m) => (
              <option key={m} value={m}>
                {m} min
              </option>
            ))}
          </select>
        </div>
        <div className="row">
          <label>Sync every</label>
          <select value={settings.syncIntervalSec} onChange={(e) => setSettings({ syncIntervalSec: Number(e.target.value) })}>
            {[30, 60, 120, 300, 600].map((sec) => (
              <option key={sec} value={sec}>
                {sec < 60 ? `${sec}s` : `${sec / 60} min`}
              </option>
            ))}
          </select>
        </div>
      </section>
      {!isStandalone && isIOS ? (
        <section>
          <h2>Install on iPhone</h2>
          <p className="muted small">In Safari tap Share → "Add to Home Screen". The installed app can show notifications and receive Web Push.</p>
        </section>
      ) : null}
    </div>
  );
}
