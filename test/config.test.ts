import { describe, expect, it } from 'vitest';
import { ConfigError, resolveConfig } from '../src/config.js';
import { parseArgRef, parseJsDocShape } from '../src/shapes.js';
import { fixture } from './helpers.js';

const root = fixture('basic');

describe('resolveConfig', () => {
  it('applies user and password templates', () => {
    const c = resolveConfig({ services: [{ name: 'market-data', entry: 'src/ingest/main.ts' }], userTemplate: '${service}-svc' }, { rootDir: root });
    expect(c.services[0]!.user).toBe('market-data-svc');
    expect(c.services[0]!.passwordEnv).toBe('MARKET_DATA_NATS_PASSWORD');
    expect(c.singleService).toBe(false);
  });
  it('falls back to a single service named after package.json or "app"', () => {
    const c = resolveConfig({}, { rootDir: root });
    expect(c.singleService).toBe(true);
    expect(c.services[0]!.name).toBe('app');
  });
  it('rejects duplicates, missing entries, bad streams and bad shapes', () => {
    expect(() => resolveConfig({ services: [{ name: 'a', entry: 'x' }, { name: 'a', entry: 'y' }] }, { rootDir: root })).toThrow(ConfigError);
    expect(() => resolveConfig({ services: [{ name: 'a', entry: [] }] }, { rootDir: root })).toThrow(/entry is required/);
    expect(() => resolveConfig({ streams: 42 as never }, { rootDir: root })).toThrow(/streams must be/);
    expect(() => resolveConfig({ shapes: { extend: [{ kind: 'publish' } as never] } }, { rootDir: root })).toThrow(/needs "kind" and "callee"/);
    expect(() => resolveConfig({ tsconfig: 'missing.json' }, { rootDir: root })).toThrow(/tsconfig not found/);
  });
  it('resolves paths against the config directory', () => {
    const c = resolveConfig({ streams: { file: 'streams.json' }, output: { file: 'out/auth.conf' } }, { rootDir: root });
    expect((c.streams as { file: string }).file.endsWith('/basic/streams.json')).toBe(true);
    expect(c.output.file!.endsWith('/basic/out/auth.conf')).toBe(true);
  });
});

describe('shape grammar', () => {
  it('parses argument references', () => {
    expect(parseArgRef('0')).toBe(0);
    expect(parseArgRef('1.config.durable_name')).toEqual({ arg: 1, path: 'config.durable_name' });
    expect(parseArgRef('x')).toBeNull();
  });
  it('parses @natsacl tags', () => {
    expect(parseJsDocShape('publish subject=0', 'send')).toEqual({ kind: 'publish', callee: 'send', receiverTypes: [], subject: 0 });
    expect(parseJsDocShape('js-subscribe subject=0 durable=1.durable stream=1.stream mode=pull', 'consume')).toEqual({
      kind: 'js-subscribe',
      callee: 'consume',
      receiverTypes: [],
      subject: 0,
      durable: { arg: 1, path: 'durable' },
      stream: { arg: 1, path: 'stream' },
      mode: 'pull',
    });
    expect(parseJsDocShape('teleport subject=0', 'x')).toBeNull();
    expect(parseJsDocShape('publish subject', 'x')).toBeNull();
    expect(parseJsDocShape('publish mode=sideways', 'x')).toBeNull();
  });
});
