import crypto from 'node:crypto';
import { config } from './config';

let secret = config.sessionSecret;
if (!secret) {
  secret = crypto.randomBytes(32).toString('hex');
  console.warn('SESSION_SECRET not set: sessions will not survive a restart.');
}

export function sign(value: string): string {
  const sig = crypto.createHmac('sha256', secret).update(value).digest('base64url');
  return `${value}.${sig}`;
}

export function verify(signed: string | undefined): string | null {
  if (!signed) return null;
  const idx = signed.lastIndexOf('.');
  if (idx < 0) return null;
  const value = signed.slice(0, idx);
  const expected = sign(value);
  if (expected.length !== signed.length) return null;
  return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(signed)) ? value : null;
}

export function randomId(bytes = 24): string {
  return crypto.randomBytes(bytes).toString('base64url');
}

export const SESSION_COOKIE = 'tm_session';
export const STATE_COOKIE = 'tm_oauth_state';
