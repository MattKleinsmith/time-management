import fs from 'node:fs';
import path from 'node:path';

// Minimal .env loader (server dir first, then repo root); real env vars win.
for (const file of [path.resolve(process.cwd(), '.env'), path.resolve(process.cwd(), '../../.env')]) {
  if (!fs.existsSync(file)) continue;
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line);
    if (!m || line.trim().startsWith('#')) continue;
    const val = m[2].replace(/^["']|["']$/g, '');
    if (process.env[m[1]] === undefined) process.env[m[1]] = val;
  }
}

function env(name: string, fallback?: string): string {
  const v = process.env[name];
  if (v === undefined || v === '') {
    if (fallback !== undefined) return fallback;
    return '';
  }
  return v;
}

export const config = {
  port: Number(env('PORT', '8787')),
  /** Public URL the browser uses to reach the app (Vite dev server in dev, this server in prod). */
  appUrl: env('APP_URL', 'http://localhost:5173').replace(/\/$/, ''),
  /** Public URL of this server (where Google redirects back). Defaults to APP_URL. */
  serverUrl: (env('SERVER_URL') || env('APP_URL', 'http://localhost:5173')).replace(/\/$/, ''),
  googleClientId: env('GOOGLE_CLIENT_ID'),
  googleClientSecret: env('GOOGLE_CLIENT_SECRET'),
  sessionSecret: env('SESSION_SECRET', ''),
  dataDir: path.resolve(env('DATA_DIR', path.resolve(process.cwd(), '../../data'))),
  /** Comma-separated list of Google account emails allowed to sign in (empty = first account to sign in). */
  allowedEmails: env('ALLOWED_EMAILS', '')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean),
  vapidPublicKey: env('VAPID_PUBLIC_KEY'),
  vapidPrivateKey: env('VAPID_PRIVATE_KEY'),
  vapidSubject: env('VAPID_SUBJECT', 'mailto:admin@example.com'),
  /** Where the built web app lives (served in production). */
  webDist: path.resolve(env('WEB_DIST', path.resolve(process.cwd(), '../web/dist'))),
  scopes: ['https://www.googleapis.com/auth/calendar.events', 'https://www.googleapis.com/auth/calendar.calendarlist.readonly'],
};

export const isProd = process.env.NODE_ENV === 'production';
