import { refreshAccessToken } from './google';
import type { FileStore } from './store';

/** Fresh access token for a user, refreshing via the stored refresh token when needed. */
export function makeAccessTokenProvider(store: FileStore) {
  const inflight = new Map<string, Promise<string>>();
  return async function accessTokenFor(userId: string): Promise<string> {
    const user = store.get().users[userId];
    if (!user) throw new Error('unknown user');
    const t = user.tokens;
    if (t.accessToken && t.expiresAt && t.expiresAt - Date.now() > 60_000) return t.accessToken;
    let p = inflight.get(userId);
    if (!p) {
      p = (async () => {
        const fresh = await refreshAccessToken(t.refreshToken);
        await store.update((d) => {
          d.users[userId].tokens.accessToken = fresh.access_token;
          d.users[userId].tokens.expiresAt = Date.now() + fresh.expires_in * 1000;
        });
        return fresh.access_token;
      })().finally(() => inflight.delete(userId));
      inflight.set(userId, p);
    }
    return p;
  };
}
