import { describe, expect, it } from 'vitest';
import { templateToPattern, type Chunk } from '../src/evaluate.js';

const lit = (s: string): Chunk => ({ lit: s });
const dyn: Chunk = { dyn: true };
const opts = { widenPartialTokens: false, dynamicTail: 'single' as const };

describe('templateToPattern', () => {
  it('renders literals unchanged', () => {
    expect(templateToPattern([lit('SENSORS.reading')], opts)).toEqual({ ok: true, pattern: 'SENSORS.reading', widened: false });
  });
  it('a dynamic whole token becomes *', () => {
    expect(templateToPattern([lit('SENSORS.'), dyn, lit('.status')], opts)).toEqual({ ok: true, pattern: 'SENSORS.*.status', widened: false });
    expect(templateToPattern([lit('SENSORS.'), dyn], opts)).toEqual({ ok: true, pattern: 'SENSORS.*', widened: false });
  });
  it('a dynamic tail can be > when configured', () => {
    expect(templateToPattern([lit('SENSORS.'), dyn], { ...opts, dynamicTail: 'rest' })).toEqual({ ok: true, pattern: 'SENSORS.>', widened: false });
    expect(templateToPattern([lit('SENSORS.'), dyn, lit('.x')], { ...opts, dynamicTail: 'rest' })).toEqual({ ok: true, pattern: 'SENSORS.*.x', widened: false });
  });
  it('two dynamic chunks in one token are still one *', () => {
    expect(templateToPattern([lit('A.'), dyn, dyn, lit('.B')], opts)).toEqual({ ok: true, pattern: 'A.*.B', widened: false });
  });
  it('a partial token is refused, or widened on request', () => {
    const refused = templateToPattern([lit('DEVICE-'), dyn], opts);
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.reason).toBe('partial-token');
    expect(templateToPattern([lit('DEVICE-'), dyn], { ...opts, widenPartialTokens: true })).toEqual({ ok: true, pattern: '*', widened: true });
    expect(templateToPattern([lit('A.'), dyn, lit('-x.B')], { ...opts, widenPartialTokens: true })).toEqual({ ok: true, pattern: 'A.*.B', widened: true });
  });
  it('a subject with no literal token is refused', () => {
    const r = templateToPattern([dyn, lit('.'), dyn], opts);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('dynamic');
  });
  it('malformed subjects are refused', () => {
    expect(templateToPattern([lit('A..B')], opts).ok).toBe(false);
    expect(templateToPattern([lit('A B')], opts).ok).toBe(false);
    expect(templateToPattern([lit('')], opts).ok).toBe(false);
  });
});
