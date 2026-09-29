/** Google OAuth 2.0 (authorization code flow with refresh tokens) and token refresh. */
import { config } from './config';

const AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const REVOKE_URL = 'https://oauth2.googleapis.com/revoke';

export function redirectUri(): string {
  return `${config.serverUrl}/auth/callback`;
}

export function authUrl(state: string): string {
  const u = new URL(AUTH_URL);
  u.searchParams.set('client_id', config.googleClientId);
  u.searchParams.set('redirect_uri', redirectUri());
  u.searchParams.set('response_type', 'code');
  u.searchParams.set('scope', config.scopes.join(' '));
  u.searchParams.set('access_type', 'offline');
  u.searchParams.set('prompt', 'consent');
  u.searchParams.set('include_granted_scopes', 'true');
  u.searchParams.set('state', state);
  return u.toString();
}

export interface TokenResponse {
  access_token: string;
  expires_in: number;
  refresh_token?: string;
  scope?: string;
  token_type: string;
}

async function tokenRequest(params: Record<string, string>): Promise<TokenResponse> {
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: config.googleClientId, client_secret: config.googleClientSecret, ...params }),
  });
  const json = (await res.json()) as TokenResponse & { error?: string; error_description?: string };
  if (!res.ok) throw new Error(`Google token error: ${json.error} ${json.error_description ?? ''}`);
  return json;
}

export function exchangeCode(code: string): Promise<TokenResponse> {
  return tokenRequest({ code, grant_type: 'authorization_code', redirect_uri: redirectUri() });
}

export function refreshAccessToken(refreshToken: string): Promise<TokenResponse> {
  return tokenRequest({ refresh_token: refreshToken, grant_type: 'refresh_token' });
}

export async function revokeToken(token: string): Promise<void> {
  await fetch(`${REVOKE_URL}?token=${encodeURIComponent(token)}`, { method: 'POST' }).catch(() => undefined);
}

/** The primary calendar's id is the account email: identifies the user without extra OAuth scopes. */
export async function primaryCalendarEmail(accessToken: string): Promise<string> {
  const res = await fetch('https://www.googleapis.com/calendar/v3/users/me/calendarList?minAccessRole=owner&maxResults=250', {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) throw new Error(`calendarList failed: ${res.status}`);
  const json = (await res.json()) as { items?: { id: string; primary?: boolean }[] };
  const primary = json.items?.find((c) => c.primary) ?? json.items?.[0];
  if (!primary) throw new Error('No primary calendar found');
  return primary.id.toLowerCase();
}
