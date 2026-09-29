/**
 * IndexedDB persistence for the sync cache, local alert state and settings.
 * The cache exists so incremental sync and offline rendering work; Google
 * Calendar stays the source of truth.
 */
import { openDB, type IDBPDatabase } from 'idb';
import { emptyLocalAlertState, type LocalAlertState, type SyncPersistence, type SyncSnapshot } from '@tm/core';

const DB_NAME = 'time-manager';
const DB_VERSION = 1;
const STORE = 'kv';

let dbPromise: Promise<IDBPDatabase> | null = null;
function db() {
  if (!dbPromise) {
    dbPromise = openDB(DB_NAME, DB_VERSION, {
      upgrade(d) {
        if (!d.objectStoreNames.contains(STORE)) d.createObjectStore(STORE);
      },
    });
  }
  return dbPromise;
}

export async function kvGet<T>(key: string): Promise<T | undefined> {
  try {
    return (await (await db()).get(STORE, key)) as T | undefined;
  } catch {
    return undefined;
  }
}
export async function kvSet(key: string, value: unknown): Promise<void> {
  try {
    await (await db()).put(STORE, value, key);
  } catch (e) {
    console.warn('kvSet failed', e);
  }
}
export async function kvDel(key: string): Promise<void> {
  try {
    await (await db()).delete(STORE, key);
  } catch {
    /* ignore */
  }
}

export const KEYS = {
  snapshot: 'sync-snapshot',
  localAlerts: 'local-alerts',
  settings: 'settings',
};

export class IdbPersistence implements SyncPersistence {
  constructor(private readonly key = KEYS.snapshot) {}
  load() {
    return kvGet<SyncSnapshot>(this.key).then((s) => s ?? null);
  }
  save(snapshot: SyncSnapshot) {
    return kvSet(this.key, snapshot);
  }
  clear() {
    return kvDel(this.key);
  }
}

export async function loadLocalAlerts(): Promise<LocalAlertState> {
  const s = await kvGet<LocalAlertState>(KEYS.localAlerts);
  return s && s.acked && s.snoozed ? s : emptyLocalAlertState();
}

export function saveLocalAlerts(state: LocalAlertState) {
  return kvSet(KEYS.localAlerts, state);
}

/** Drop acks/snoozes older than 14 days so the record stays small. */
export function pruneLocalAlerts(state: LocalAlertState): LocalAlertState {
  const cutoff = Date.now() - 14 * 86_400_000;
  const acked: Record<string, string> = {};
  for (const [k, v] of Object.entries(state.acked)) if (new Date(v).getTime() > cutoff) acked[k] = v;
  const snoozed: Record<string, string> = {};
  for (const [k, v] of Object.entries(state.snoozed)) if (new Date(v).getTime() > Date.now() - 86_400_000) snoozed[k] = v;
  return { acked, snoozed };
}

/** In-memory persistence for mock mode so sample data never pollutes the real cache. */
export class MemoryPersistenceIfMock implements SyncPersistence {
  private snap: SyncSnapshot | null = null;
  async load() {
    return this.snap;
  }
  async save(s: SyncSnapshot) {
    this.snap = s;
  }
  async clear() {
    this.snap = null;
  }
}
