/**
 * Time Manager per-event configuration, stored in Google Calendar
 * `extendedProperties.private` (never in the description).
 *
 * Keys are prefixed `tm_` and kept compact (Google limits: 44-char keys,
 * 1024-char values, 300 properties / 32kB per event). `tm_v` versions the schema.
 */
import type { GcalEvent } from './types';

export const TM_SCHEMA_VERSION = '1';
export const TM_KEY_PREFIX = 'tm_';

export type AlertMode = 'none' | 'once' | 'repeat';
export type AlertUntil = 'ack' | 'end';
export type AlertSound = 'default' | 'chime' | 'alarm' | 'silent';

export interface AlertPolicy {
  mode: AlertMode;
  /** Minutes before the event start to begin alerting (0 = at start; negative = after start). */
  leadMin: number;
  /** Repeat interval in minutes (repeat mode only). */
  intervalMin: number;
  /** When repeating stops on its own: at acknowledgement only, or at event end. */
  until: AlertUntil;
  sound: AlertSound;
}

export interface AlertAck {
  /** ISO instant (or YYYY-MM-DD) of the instance start that was acknowledged. */
  instanceStart: string;
  /** ISO instant when it was acknowledged. */
  at: string;
}

export interface AlertSnooze {
  instanceStart: string;
  until: string;
}

export interface TmConfig {
  v: string;
  alert: AlertPolicy;
  /**
   * Set on a recurring-event exception that carries its own Time Manager
   * configuration. Without it, an exception inherits the series configuration
   * (Google copies the parent's properties into exceptions it creates).
   */
  own: boolean;
  ack?: AlertAck;
  snooze?: AlertSnooze;
  /** Free-form tags for filtering / colouring inside Time Manager. */
  tags: string[];
}

export const DEFAULT_ALERT: AlertPolicy = {
  mode: 'repeat',
  leadMin: 0,
  intervalMin: 5,
  until: 'ack',
  sound: 'default',
};

export const ALERT_PRESETS: { id: string; label: string; policy: Partial<AlertPolicy> }[] = [
  { id: 'none', label: 'No alert', policy: { mode: 'none' } },
  { id: 'once', label: 'Alert once', policy: { mode: 'once' } },
  { id: 'r1', label: 'Repeat every 1 min until acknowledged', policy: { mode: 'repeat', intervalMin: 1, until: 'ack' } },
  { id: 'r5', label: 'Repeat every 5 min until acknowledged', policy: { mode: 'repeat', intervalMin: 5, until: 'ack' } },
  { id: 'r10', label: 'Repeat every 10 min until acknowledged', policy: { mode: 'repeat', intervalMin: 10, until: 'ack' } },
];

export function defaultTmConfig(overrides: Partial<TmConfig> = {}): TmConfig {
  return { v: TM_SCHEMA_VERSION, alert: { ...DEFAULT_ALERT }, own: false, tags: [], ...overrides };
}

function num(v: string | undefined, fallback: number): number {
  if (v === undefined || v === '') return fallback;
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

/** Does this event carry Time Manager metadata at all? */
export function hasTmMetadata(event: Pick<GcalEvent, 'extendedProperties'> | undefined | null): boolean {
  const p = event?.extendedProperties?.private;
  return !!p && typeof p.tm_v === 'string' && p.tm_v !== '';
}

/** Parse Time Manager metadata from an event. Returns null for ordinary events. */
export function parseTmConfig(event: Pick<GcalEvent, 'extendedProperties'> | undefined | null): TmConfig | null {
  const p = event?.extendedProperties?.private;
  if (!p || !p.tm_v) return null;
  const modeRaw = p.tm_alert;
  const mode: AlertMode = modeRaw === 'none' || modeRaw === 'once' || modeRaw === 'repeat' ? modeRaw : 'none';
  const untilRaw = p.tm_until;
  const until: AlertUntil = untilRaw === 'end' ? 'end' : 'ack';
  const soundRaw = p.tm_sound;
  const sound: AlertSound =
    soundRaw === 'chime' || soundRaw === 'alarm' || soundRaw === 'silent' || soundRaw === 'default' ? soundRaw : 'default';
  const cfg: TmConfig = {
    v: p.tm_v,
    alert: {
      mode,
      leadMin: num(p.tm_lead, 0),
      intervalMin: Math.max(1, num(p.tm_int, DEFAULT_ALERT.intervalMin)),
      until,
      sound,
    },
    own: p.tm_own === '1',
    tags: p.tm_tags ? p.tm_tags.split(',').map((t) => t.trim()).filter(Boolean) : [],
  };
  if (p.tm_ack) {
    const [instanceStart, at] = p.tm_ack.split('|');
    if (instanceStart) cfg.ack = { instanceStart, at: at || instanceStart };
  }
  if (p.tm_snooze) {
    const [instanceStart, until] = p.tm_snooze.split('|');
    if (instanceStart && until) cfg.snooze = { instanceStart, until };
  }
  return cfg;
}

/**
 * Serialise a config into private extended properties. Keys that should be
 * removed are set to null, which is what Google's patch semantics use to delete
 * a single property while leaving other apps' properties untouched.
 */
export function serializeTmConfig(cfg: TmConfig): Record<string, string | null> {
  const out: Record<string, string | null> = {
    tm_v: TM_SCHEMA_VERSION,
    tm_alert: cfg.alert.mode,
    tm_lead: String(cfg.alert.leadMin),
    tm_int: cfg.alert.mode === 'repeat' ? String(cfg.alert.intervalMin) : null,
    tm_until: cfg.alert.mode === 'repeat' ? cfg.alert.until : null,
    tm_sound: cfg.alert.sound === 'default' ? null : cfg.alert.sound,
    tm_own: cfg.own ? '1' : null,
    tm_tags: cfg.tags.length ? cfg.tags.join(',') : null,
    tm_ack: cfg.ack ? `${cfg.ack.instanceStart}|${cfg.ack.at}` : null,
    tm_snooze: cfg.snooze ? `${cfg.snooze.instanceStart}|${cfg.snooze.until}` : null,
  };
  for (const [k, v] of Object.entries(out)) {
    if (k.length > 44) throw new Error(`extended property key too long: ${k}`);
    if (v && v.length > 1024) throw new Error(`extended property value too long: ${k}`);
  }
  return out;
}

/** Properties patch that removes every Time Manager key (keeps other apps' keys). */
export function clearTmConfigPatch(event: Pick<GcalEvent, 'extendedProperties'>): Record<string, null> {
  const out: Record<string, null> = {};
  for (const k of Object.keys(event.extendedProperties?.private ?? {})) {
    if (k.startsWith(TM_KEY_PREFIX)) out[k] = null;
  }
  return out;
}

/** Build the `extendedProperties` fragment for an events.patch request. */
export function tmPatchBody(cfg: TmConfig): { extendedProperties: { private: Record<string, string | null> } } {
  return { extendedProperties: { private: serializeTmConfig(cfg) } };
}

/**
 * Apply a private-properties patch locally, mirroring Google's merge semantics
 * (null deletes a key, other keys are preserved). Used for optimistic updates.
 */
export function applyPrivatePropsPatch(event: GcalEvent, patch: Record<string, string | null>): GcalEvent {
  const priv: Record<string, string> = { ...(event.extendedProperties?.private ?? {}) };
  for (const [k, v] of Object.entries(patch)) {
    if (v === null) delete priv[k];
    else priv[k] = v;
  }
  return { ...event, extendedProperties: { ...(event.extendedProperties ?? {}), private: priv } };
}
