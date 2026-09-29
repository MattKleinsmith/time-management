/**
 * Static-hosting authentication (GitHub Pages etc.): Google's browser OAuth
 * flow with response_type=token. No backend, no client secret; the access
 * token lives in localStorage for ~1 hour and is renewed with prompt=none.
 * https://developers.google.com/identity/protocols/oauth2/javascript-implicit-flow
 */

export const SCOPES = ['https://www.googleapis.com/auth/calendar.events', 'https://www.googleapis.com/auth/calendar.calendarlist.readonly'];

const TOKEN_KEY = 'tm-google-token';
const CLIENT_KEY = 'tm-google-client-id';
const STATE_KEY = 'tm-oauth-state';
const RETURN_KEY = 'tm-oauth-return';

export interface StoredToken {
  accessToken: string;
  expiresAt: number; // epoch ms
  scope: string;
}

export function redirectUri(): string {
  // Must match the URI registered in the Google Cloud console exactly.
  return location.origin + import.meta.env.BASE_URL;
}

export function getClientId(): string {
  try {
    return localStorage.getItem(CLIENT_KEY) || (import.meta.env.VITE_GOOGLE_CLIENT_ID as string | undefined) || '';
  } catch {
    return (import.meta.env.VITE_GOOGLE_CLIENT_ID as string | undefined) || '';
  }
}

export function setClientId(id: string) {
  localStorage.setItem(CLIENT_KEY, id.trim());
}

export function getStoredToken(): StoredToken | null {
  try {
    const raw = localStorage.getItem(TOKEN_KEY);
    if (!raw) return null;
    const t = JSON.parse(raw) as StoredToken;
    return t.accessToken && t.expiresAt ? t : null;
  } catch {
    return null;
  }
}

export function tokenIsUsable(t: StoredToken | null, marginMs = 60_000): t is StoredToken {
  return !!t && t.expiresAt - Date.now() > marginMs;
}

function clearToken() {
  localStorage.removeItem(TOKEN_KEY);
}

/** Navigate to Google. `silent` uses prompt=none (works only when already consented and signed in). */
export function startLogin(opts: { silent?: boolean; clientId?: string } = {}): void {
  const clientId = opts.clientId ?? getClientId();
  if (!clientId) throw new Error('Google OAuth client ID is not configured');
  const state = Math.random().toString(36).slice(2) + Date.now().toString(36);
  sessionStorage.setItem(STATE_KEY, state);
  sessionStorage.setItem(RETURN_KEY, location.pathname + location.search);
  const u = new URL('https://accounts.google.com/o/oauth2/v2/auth');
  u.searchParams.set('client_id', clientId);
  u.searchParams.set('redirect_uri', redirectUri());
  u.searchParams.set('response_type', 'token');
  u.searchParams.set('scope', SCOPES.join(' '));
  u.searchParams.set('include_granted_scopes', 'true');
  u.searchParams.set('state', state);
  if (opts.silent) u.searchParams.set('prompt', 'none');
  location.assign(u.toString());
}

/**
 * Call once at startup: if the URL carries an OAuth response fragment, store it.
 * Returns an error string when Google reported one (e.g. interaction_required after a silent attempt).
 */
export function consumeRedirect(): { handled: boolean; error?: string } {
  if (!location.hash.includes('access_token=') && !location.hash.includes('error=')) return { handled: false };
  const params = new URLSearchParams(location.hash.slice(1));
  const expectedState = sessionStorage.getItem(STATE_KEY);
  sessionStorage.removeItem(STATE_KEY);
  const returnTo = sessionStorage.getItem(RETURN_KEY) || import.meta.env.BASE_URL;
  sessionStorage.removeItem(RETURN_KEY);
  history.replaceState({}, '', returnTo);
  if (params.get('state') !== expectedState) return { handled: true, error: 'OAuth state mismatch; please sign in again.' };
  const error = params.get('error');
  if (error) return { handled: true, error };
  const accessToken = params.get('access_token');
  const expiresIn = Number(params.get('expires_in') || '3600');
  if (!accessToken) return { handled: true, error: 'No access token returned' };
  const token: StoredToken = { accessToken, expiresAt: Date.now() + expiresIn * 1000, scope: params.get('scope') ?? '' };
  localStorage.setItem(TOKEN_KEY, JSON.stringify(token));
  return { handled: true };
}

/** Returns a usable token or starts a silent renewal (which navigates away). */
export function ensureToken(): StoredToken | null {
  const t = getStoredToken();
  if (tokenIsUsable(t)) return t;
  if (t && getClientId()) {
    // Expired but previously signed in: renew silently.
    startLogin({ silent: true });
    return null;
  }
  return null;
}

export async function revokeAndClear(): Promise<void> {
  const t = getStoredToken();
  clearToken();
  if (t) {
    try {
      await fetch(`https://oauth2.googleapis.com/revoke?token=${encodeURIComponent(t.accessToken)}`, { method: 'POST', mode: 'no-cors' });
    } catch {
      /* ignore */
    }
  }
}

export function signOutLocal() {
  clearToken();
}
