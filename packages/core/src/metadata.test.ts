import { describe, expect, it } from 'vitest';
import { applyPrivatePropsPatch, defaultTmConfig, hasTmMetadata, parseTmConfig, serializeTmConfig } from './metadata';

describe('Time Manager metadata', () => {
  it('ignores ordinary events', () => {
    expect(parseTmConfig({})).toBeNull();
    expect(parseTmConfig({ extendedProperties: { private: { other_app: 'x' } } })).toBeNull();
    expect(hasTmMetadata({ extendedProperties: { private: { tm_v: '1' } } })).toBe(true);
  });
  it('round-trips a config', () => {
    const cfg = defaultTmConfig({ alert: { mode: 'repeat', leadMin: 10, intervalMin: 5, until: 'ack', sound: 'alarm' }, tags: ['deep', 'work'] });
    cfg.ack = { instanceStart: '2026-09-29T14:00:00.000Z', at: '2026-09-29T14:02:00.000Z' };
    const props = serializeTmConfig(cfg);
    expect(props.tm_v).toBe('1');
    expect(props.tm_int).toBe('5');
    expect(props.tm_own).toBeNull();
    const priv: Record<string, string> = {};
    for (const [k, v] of Object.entries(props)) if (v !== null) priv[k] = v;
    const parsed = parseTmConfig({ extendedProperties: { private: priv } })!;
    expect(parsed.alert).toEqual(cfg.alert);
    expect(parsed.tags).toEqual(['deep', 'work']);
    expect(parsed.ack).toEqual(cfg.ack);
  });
  it('keeps keys within Google limits and never touches the description', () => {
    const props = serializeTmConfig(defaultTmConfig());
    for (const k of Object.keys(props)) expect(k.length).toBeLessThanOrEqual(44);
    expect(Object.keys(props).every((k) => k.startsWith('tm_'))).toBe(true);
  });
  it('applies patch semantics locally (null deletes, other keys preserved)', () => {
    const ev = { id: 'a', extendedProperties: { private: { other: '1', tm_v: '1', tm_int: '5' } } };
    const next = applyPrivatePropsPatch(ev, { tm_int: null, tm_alert: 'once' });
    expect(next.extendedProperties!.private).toEqual({ other: '1', tm_v: '1', tm_alert: 'once' });
  });
});
