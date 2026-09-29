import { serve } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import fs from 'node:fs';
import path from 'node:path';
import { Hono } from 'hono';
import { getCookie, setCookie, deleteCookie } from 'hono/cookie';
import { config, isProd } from './config';
import { authUrl, exchangeCode, primaryCalendarEmail, revokeToken } from './google';
import { makeAccessTokenProvider } from './tokens';
import { FileStore } from './store';
import { randomId, sign, verify, SESSION_COOKIE, STATE_COOKIE } from './session';
import { createPushService } from './push';

const store = new FileStore();
const app = new Hono<{ Variables: { userId: string } }>();
const accessTokenFor = makeAccessTokenProvider(store);
const push = createPushService(store, accessTokenFor);

const secureCookies = config.appUrl.startsWith('https://');
const cookieOpts = { httpOnly: true, secure: secureCookies, sameSite: 'Lax' as const, path: '/' };

// ---- auth -----------------------------------------------------------------

app.get('/auth/login', (c) => {
  if (!config.googleClientId || !config.googleClientSecret) {
    return c.text('GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET are not configured on the server. See README.', 500);
  }
  const state = randomId(16);
  setCookie(c, STATE_COOKIE, sign(state), { ...cookieOpts, maxAge: 600 });
  return c.redirect(authUrl(state));
});

app.get('/auth/callback', async (c) => {
  const state = c.req.query('state');
  const code = c.req.query('code');
  const error = c.req.query('error');
  const expected = verify(getCookie(c, STATE_COOKIE));
  deleteCookie(c, STATE_COOKIE, cookieOpts);
  if (error) return c.text(`Google sign-in failed: ${error}`, 400);
  if (!code || !state || !expected || state !== expected) return c.text('Invalid OAuth state. Please try signing in again.', 400);
  try {
    const tokens = await exchangeCode(code);
    const email = await primaryCalendarEmail(tokens.access_token);
    if (config.allowedEmails.length && !config.allowedEmails.includes(email)) {
      await revokeToken(tokens.access_token);
      return c.text(`The account ${email} is not allowed to use this Time Manager instance.`, 403);
    }
    const existingUsers = Object.keys(store.get().users);
    if (!config.allowedEmails.length && existingUsers.length && !existingUsers.includes(email)) {
      await revokeToken(tokens.access_token);
      return c.text('This Time Manager instance is already claimed by another Google account (set ALLOWED_EMAILS to allow more).', 403);
    }
    const sessionId = randomId();
    await store.update((d) => {
      const prev = d.users[email];
      d.users[email] = {
        email,
        createdAt: prev?.createdAt ?? new Date().toISOString(),
        tokens: {
          refreshToken: tokens.refresh_token ?? prev?.tokens.refreshToken ?? '',
          accessToken: tokens.access_token,
          expiresAt: Date.now() + tokens.expires_in * 1000,
          scope: tokens.scope,
        },
      };
      d.sessions[sessionId] = { userId: email, createdAt: new Date().toISOString() };
    });
    if (!store.get().users[email].tokens.refreshToken) {
      return c.text('Google did not return a refresh token. Remove the app at https://myaccount.google.com/permissions and sign in again.', 500);
    }
    setCookie(c, SESSION_COOKIE, sign(sessionId), { ...cookieOpts, maxAge: 60 * 60 * 24 * 365 });
    return c.redirect(config.appUrl + '/');
  } catch (e) {
    console.error('oauth callback failed', e);
    return c.text(`Sign-in failed: ${(e as Error).message}`, 500);
  }
});

app.post('/auth/logout', async (c) => {
  const sessionId = verify(getCookie(c, SESSION_COOKIE));
  const session = sessionId ? store.get().sessions[sessionId] : undefined;
  if (sessionId) await store.update((d) => delete d.sessions[sessionId]);
  const disconnect = c.req.query('disconnect') === '1';
  if (disconnect && session) {
    const user = store.get().users[session.userId];
    if (user) {
      await revokeToken(user.tokens.refreshToken);
      await store.update((d) => {
        delete d.users[session.userId];
        d.push = d.push.filter((p) => p.userId !== session.userId);
      });
    }
  }
  deleteCookie(c, SESSION_COOKIE, cookieOpts);
  return c.json({ ok: true });
});

// ---- session middleware ---------------------------------------------------

app.use('/api/*', async (c, next) => {
  const sessionId = verify(getCookie(c, SESSION_COOKIE));
  const session = sessionId ? store.get().sessions[sessionId] : undefined;
  if (!session || !store.get().users[session.userId]) return c.json({ error: 'unauthenticated' }, 401);
  // CSRF guard for cookie-authenticated mutations.
  if (c.req.method !== 'GET' && c.req.header('x-requested-with') !== 'TimeManager') return c.json({ error: 'missing X-Requested-With' }, 403);
  c.set('userId', session.userId);
  await next();
});

app.get('/api/me', (c) => {
  const user = store.get().users[c.get('userId')];
  return c.json({
    email: user.email,
    push: push.enabled,
    vapidPublicKey: push.enabled ? config.vapidPublicKey : null,
    scopes: config.scopes,
  });
});

// ---- Google Calendar proxy ------------------------------------------------


app.all('/api/gcal/*', async (c) => {
  const userId = c.get('userId');
  const subPath = c.req.path.replace(/^\/api\/gcal/, '');
  if (!/^\/(calendars|users\/me\/calendarList|colors)(\/|$)/.test(subPath)) return c.json({ error: 'path not allowed' }, 403);
  const url = new URL('https://www.googleapis.com/calendar/v3' + subPath);
  const incoming = new URL(c.req.url);
  incoming.searchParams.forEach((v, k) => url.searchParams.append(k, v));
  let token: string;
  try {
    token = await accessTokenFor(userId);
  } catch (e) {
    console.error('token refresh failed', e);
    return c.json({ error: 'reauth_required', message: (e as Error).message }, 401);
  }
  const method = c.req.method;
  const body = method === 'GET' || method === 'HEAD' || method === 'DELETE' ? undefined : await c.req.text();
  const res = await fetch(url, {
    method,
    headers: { Authorization: `Bearer ${token}`, ...(body ? { 'Content-Type': 'application/json' } : {}), Accept: 'application/json' },
    body,
  });
  const text = await res.text();
  return c.body(text, res.status as 200, { 'Content-Type': res.headers.get('content-type') ?? 'application/json' });
});

// ---- Web Push -------------------------------------------------------------

app.route('/api/push', push.routes);

// ---- static web app (production) -----------------------------------------

if (fs.existsSync(config.webDist)) {
  const rel = path.relative(process.cwd(), config.webDist) || '.';
  app.use('/*', serveStatic({ root: rel }));
  app.get('*', (c) => {
    if (c.req.path.startsWith('/api/') || c.req.path.startsWith('/auth/')) return c.notFound();
    return c.html(fs.readFileSync(path.join(config.webDist, 'index.html'), 'utf8'));
  });
} else if (isProd) {
  console.warn(`web dist not found at ${config.webDist}; run "npm run build" first.`);
}

serve({ fetch: app.fetch, port: config.port }, (info) => {
  console.log(`Time Manager server listening on http://localhost:${info.port}`);
  console.log(`  app url:      ${config.appUrl}`);
  console.log(`  redirect uri: ${config.serverUrl}/auth/callback`);
  console.log(`  google oauth: ${config.googleClientId ? 'configured' : 'NOT CONFIGURED'}`);
  console.log(`  web push:     ${push.enabled ? 'enabled' : 'disabled (set VAPID_* to enable)'}`);
  push.start();
});
