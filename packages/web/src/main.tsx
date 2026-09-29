import React from 'react';
import { createRoot } from 'react-dom/client';
import { registerSW } from 'virtual:pwa-register';
import App from './App';
import './styles.css';
import { useStore } from './lib/store';
import { startAlertLoop } from './lib/delivery';
import { loadLocalAlerts } from './lib/persistence';

registerSW({ immediate: true });

// Messages from the service worker (notification actions).
navigator.serviceWorker?.addEventListener('message', async (ev) => {
  const data = ev.data as { type?: string; instanceKey?: string };
  if (data?.type === 'local-alerts-changed') {
    useStore.getState().updateLocalAlerts(await loadLocalAlerts());
  }
  if (data?.type === 'focus-instance' && data.instanceKey) useStore.getState().focusInstance(data.instanceKey);
});

// ?ack=<key> / ?snooze=<key> deep links from notifications.
const params = new URLSearchParams(location.search);
const ackKey = params.get('ack');
const snoozeKey = params.get('snooze');
const focusKey = params.get('focus');
if (ackKey || snoozeKey || focusKey) history.replaceState({}, '', location.pathname);

createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);

void useStore.getState().boot().then(() => {
  startAlertLoop();
  const s = useStore.getState();
  if (ackKey) s.updateLocalAlerts({ ...s.localAlerts, acked: { ...s.localAlerts.acked, [ackKey]: new Date().toISOString() } });
  if (snoozeKey) s.updateLocalAlerts({ ...s.localAlerts, snoozed: { ...s.localAlerts.snoozed, [snoozeKey]: new Date(Date.now() + 5 * 60_000).toISOString() } });
  if (focusKey) setTimeout(() => useStore.getState().focusInstance(focusKey), 500);
});

setInterval(() => useStore.getState().tickNow(), 15_000);
