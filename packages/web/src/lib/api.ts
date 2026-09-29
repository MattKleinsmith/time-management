import { createHttpGcalClient, MockGcalClient, type GcalClient } from '@tm/core';
import { seedMockCalendar } from './mockData';

export interface Me {
  email: string;
  push: boolean;
  vapidPublicKey: string | null;
}

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

export const API_HEADERS = { 'X-Requested-With': 'TimeManager' };

export async function fetchMe(): Promise<Me | null> {
  if (isMockMode()) return { email: 'mock@example.com', push: false, vapidPublicKey: null };
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
