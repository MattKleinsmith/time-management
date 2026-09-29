import { createHttpGcalClient, GcalError, MockGcalClient, type GcalClient } from '@tm/core';
import { seedMockCalendar } from './mockData';
import { ensureToken, getClientId, getStoredToken, revokeAndClear, signOutLocal, startLogin, tokenIsUsable } from './auth';

export interface Me {
  email: string;
  push: boolean;
  vapidPublicKey: string | null;
}

export type AuthMode = 'mock' | 'static' | 'server';

/** Where the app is served from (e.g. "/" or "/time-management/"). */
export const BASE = import.meta.env.BASE_URL;
export const asset = (p: string) => BASE + p.replace(/^\//, '');

export const isMockMode = (): boolean => {
  if (import.meta.env.VITE_MOCK === '1') return true;
  try {
    const p = new URLSearchParams(location.search);
    if (p.get('mock') === '1') {
      localStorage.setItem('tm-mock', '1');
      return true;
    }
    if (p.get('mock') === '0') localStorage.removeItem('tm-mock');
    return localStorage.getItem('tm-mock') === '1';
  } catch {
    return false;
  }
};

/** Static mode = no backend; the browser talks to Google directly (GitHub Pages build). */
export const isStaticMode = (): boolean => import.meta.env.VITE_AUTH_MODE === 'static';

export const authMode = (): AuthMode => (isMockMode() ? 'mock' : isStaticMode() ? 'static' : 'server');

export const API_HEADERS = { 'X-Requested-With': 'TimeManager' };

async function primaryEmail(accessToken: string): Promise<string> {
  const res = await fetch('https://www.googleapis.com/calendar/v3/users/me/calendarList?minAccessRole=owner&maxResults=250', {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (res.status === 401) throw new GcalError(401, 'unauthorized');
  if (!res.ok) throw new Error(`calendarList failed: ${res.status}`);
  const json = (await res.json()) as { items?: { id: string; primary?: boolean }[] };
  const primary = json.items?.find((c) => c.primary) ?? json.items?.[0];
  return primary?.id ?? 'me';
}

export async function fetchMe(): Promise<Me | null> {
  if (isMockMode()) return { email: 'mock@example.com', push: false, vapidPublicKey: null };
  if (isStaticMode()) {
    const t = getStoredToken();
    if (!tokenIsUsable(t)) {
      if (t && getClientId()) {
        startLogin({ silent: true });
        return null;
      }
      return null;
    }
    try {
      const email = sessionStorage.getItem('tm-email') || (await primaryEmail(t.accessToken));
      sessionStorage.setItem('tm-email', email);
      return { email, push: false, vapidPublicKey: null };
    } catch (e) {
      if (e instanceof GcalError && e.status === 401) {
        signOutLocal();
        return null;
      }
      // Offline or flaky network: continue with the cached calendar; sync will report the error.
      console.warn('could not identify account, continuing offline', e);
      return { email: sessionStorage.getItem('tm-email') || 'Google account (offline)', push: false, vapidPublicKey: null };
    }
  }
  const res = await fetch('/api/me', { headers: API_HEADERS, credentials: 'same-origin' });
  if (res.status === 401) return null;
  if (!res.ok) throw new Error(`/api/me failed: ${res.status}`);
  return (await res.json()) as Me;
}

export async function logout(disconnect = false): Promise<void> {
  if (isMockMode()) {
    localStorage.removeItem('tm-mock');
    return;
  }
  if (isStaticMode()) {
    sessionStorage.removeItem('tm-email');
    if (disconnect) await revokeAndClear();
    else signOutLocal();
    return;
  }
  await fetch(`/auth/logout${disconnect ? '?disconnect=1' : ''}`, { method: 'POST', headers: API_HEADERS, credentials: 'same-origin' });
}

let mockClient: MockGcalClient | null = null;
export function getMockClient(): MockGcalClient {
  if (!mockClient) {
    mockClient = new MockGcalClient();
    seedMockCalendar(mockClient);
  }
  return mockClient;
}

export function createClient(onUnauthorized: () => void): GcalClient {
  if (isMockMode()) return getMockClient();
  if (isStaticMode()) {
    return createHttpGcalClient({
      baseUrl: 'https://www.googleapis.com/calendar/v3',
      headers: () => {
        const t = ensureToken();
        if (!t) throw new GcalError(401, 'Google session expired; signing in again…');
        return { Authorization: `Bearer ${t.accessToken}` };
      },
      onUnauthorized: async () => {
        signOutLocal();
        onUnauthorized();
        return false;
      },
    });
  }
  return createHttpGcalClient({
    baseUrl: '/api/gcal',
    headers: () => API_HEADERS,
    onUnauthorized: async () => {
      onUnauthorized();
      return false;
    },
  });
}

export async function apiPost<T>(path: string, body?: unknown, method = 'POST'): Promise<T> {
  const res = await fetch(path, {
    method,
    headers: { ...API_HEADERS, 'Content-Type': 'application/json' },
    credentials: 'same-origin',
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`${path} failed: ${res.status}`);
  return (await res.json()) as T;
}
