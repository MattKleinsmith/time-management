/**
 * Tiny JSON file store: OAuth tokens for the (single) user and Web Push
 * subscriptions. No calendar data lives here.
 */
import fs from 'node:fs';
import path from 'node:path';
import { config } from './config';

export interface StoredTokens {
  refreshToken: string;
  accessToken?: string;
  /** epoch ms */
  expiresAt?: number;
  scope?: string;
}

export interface PushSubscriptionRecord {
  id: string;
  endpoint: string;
  keys: { p256dh: string; auth: string };
  userId: string;
  createdAt: string;
  label?: string;
}

export interface StoreData {
  version: 1;
  users: Record<string, { email: string; tokens: StoredTokens; createdAt: string }>;
  sessions: Record<string, { userId: string; createdAt: string }>;
  push: PushSubscriptionRecord[];
  /** Per-user push scheduler state (which reminders were already sent). */
  pushState: Record<string, { sent: Record<string, number>; syncSnapshot?: unknown; localAlerts?: unknown }>;
}

const empty = (): StoreData => ({ version: 1, users: {}, sessions: {}, push: [], pushState: {} });

export class FileStore {
  private data: StoreData = empty();
  private file: string;
  private writing: Promise<void> = Promise.resolve();

  constructor(dir = config.dataDir) {
    fs.mkdirSync(dir, { recursive: true });
    this.file = path.join(dir, 'store.json');
    if (fs.existsSync(this.file)) {
      try {
        const parsed = JSON.parse(fs.readFileSync(this.file, 'utf8')) as StoreData;
        if (parsed.version === 1) this.data = { ...empty(), ...parsed };
      } catch (e) {
        console.error('store: could not parse store.json, starting empty', e);
      }
    }
  }

  get(): StoreData {
    return this.data;
  }

  async update(fn: (d: StoreData) => void): Promise<void> {
    fn(this.data);
    await this.flush();
  }

  flush(): Promise<void> {
    const json = JSON.stringify(this.data, null, 2);
    this.writing = this.writing.then(() => fs.promises.writeFile(this.file, json, { mode: 0o600 }));
    return this.writing;
  }
}
