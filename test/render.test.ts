import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { render } from '../src/index.js';
import { modelFor } from './helpers.js';

describe('renderers', () => {
  const { model, config, root } = modelFor('basic');

  it('server conf matches the golden file', () => {
    const golden = readFileSync(resolve(root, 'nats/auth.conf'), 'utf8');
    expect(render(model, config, 'server')).toBe(golden);
  });

  it('an nkey user carries no password reference', () => {
    const nkey = 'U' + 'A'.repeat(55);
    const { model: m, config: c } = modelFor('basic', {
      services: [
        { name: 'ingest', entry: 'src/ingest/main.ts', nkey },
        { name: 'alerts', entry: 'src/alerts/main.ts', passwordEnv: 'ALERTS_SECRET' },
      ],
    });
    const out = render(m, c, 'server');
    expect(out).toContain(`nkey: "${nkey}"`);
    expect(out).not.toContain('user: "ingest"');
    expect(out).toContain('password: $ALERTS_SECRET');
  });

  it('server conf can be wrapped in an account', () => {
    const { model: m, config: c } = modelFor('basic', { output: { account: 'APP' } });
    const out = render(m, c, 'server');
    expect(out).toContain('accounts {\n  APP {\n    jetstream: enabled\n    users: [');
    expect(out).toContain('user: "ingest"');
  });

  it('nsc script recreates each user with repeated flags', () => {
    const out = render(model, config, 'nsc');
    expect(out).toContain(`nsc delete user --account "$ACCOUNT" --name 'alerts-svc'`);
    expect(out).toContain(`--allow-pub '$JS.API.CONSUMER.CREATE.TELEMETRY.alerts-incidents.INCIDENTS.>'`);
    expect(out).toContain(`--allow-sub 'CATALOG.LOOKUP'`);
    expect(out).toContain('--allow-pub-response');
    expect(out.startsWith('#!/usr/bin/env bash')).toBe(true);
  });

  it('jwt permissions use NATS JWT vocabulary', () => {
    const parsed = JSON.parse(render(model, config, 'jwt')) as { users: { user: string; permissions: { pub: { allow: string[] }; resp?: unknown } }[] };
    const alerts = parsed.users.find((u) => u.user === 'alerts-svc')!;
    expect(alerts.permissions.pub.allow).toContain('INCIDENTS.opened');
    expect(alerts.permissions.resp).toEqual({ max: 1, ttl: 0 });
  });

  it('json output is machine-independent: every path is relative to the project root', () => {
    const out = render(model, config, 'json');
    expect(out).not.toContain(root);
    expect(out).toContain('"file": "src/shared/publisher.ts"');
    expect(JSON.parse(out).services.length).toBe(2);
  });

  it('markdown lists every grant with the code behind it', () => {
    const out = render(model, config, 'markdown');
    expect(out).toContain('## ingest (user `ingest`)');
    expect(out).toContain('| `SENSORS.reading` | publish at src/shared/publisher.ts:');
    expect(out).toContain('May publish to the reply subject');
    expect(out).toContain('## Diagnostics');
  });
});
