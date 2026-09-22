import { describe, expect, it } from 'vitest';
import { explain } from '../src/index.js';
import { codes, modelFor, user } from './helpers.js';

describe('basic fixture: two services sharing a library', () => {
  const { model, root } = modelFor('basic');
  const ingest = user(model, 'ingest');
  const alerts = user(model, 'alerts');

  it('has no errors', () => {
    expect(codes(model, 'error')).toEqual([]);
  });

  it('resolves constants through a barrel, enums, templates, inlined functions, joins, ternaries and overrides', () => {
    expect(ingest.permissions.publishAllow).toEqual([
      '$JS.ACK.TELEMETRY.ingest-sensor-readings.>',
      '$JS.API.CONSUMER.CREATE.TELEMETRY.ingest-sensor-readings.SENSORS.reading',
      '$JS.API.CONSUMER.INFO.TELEMETRY.ingest-sensor-readings',
      '$JS.API.CONSUMER.MSG.NEXT.TELEMETRY.ingest-sensor-readings',
      '$JS.API.INFO',
      '$JS.API.STREAM.INFO.TELEMETRY',
      'ALERTS.raised',
      'CATALOG.LOOKUP',
      'OPTICAL.TASKS',
      'SENSORS.*.status',
      'SENSORS.*.trimmed',
      'SENSORS.calibrated.*',
      'SENSORS.firmware',
      'SENSORS.heartbeat.*',
      'SENSORS.legacy.>',
      'SENSORS.notified',
      'SENSORS.priority',
      'SENSORS.reading',
      'SENSORS.routine',
      'THERMAL.TASKS',
    ]);
    expect(ingest.permissions.subscribeAllow).toEqual(['_INBOX.>']);
    expect(ingest.permissions.allowResponses).toBe(false);
    expect(ingest.user).toBe('ingest');
  });

  it('pure string transforms over a finite set stay finite', () => {
    expect(ingest.permissions.publishAllow).toContain('THERMAL.TASKS');
    expect(ingest.permissions.publishAllow).toContain('OPTICAL.TASKS');
    expect(ingest.permissions.publishAllow).not.toContain('*.TASKS');
  });

  it('a library call inside a template is a dynamic token, and the fact still belongs to the service', () => {
    expect(ingest.permissions.publishAllow).toContain('SENSORS.*.trimmed');
  });

  it('sees through Pick<> and similar utility types on the receiver', () => {
    expect(ingest.permissions.publishAllow).toContain('SENSORS.notified');
  });

  it('resolves a subject read off a factory-built object', () => {
    const why = explain(model, 'ingest', 'SENSORS.firmware')!;
    expect(why.publish.map((g) => g.grant)).toEqual(['SENSORS.firmware']);
    expect(why.publish[0]!.provenance[0]!.via.some((v) => v.file.endsWith('src/shared/contracts.ts'))).toBe(true);
  });

  it('pairs each subclass subject with its own durable; a computed durable falls back to * for that one only', () => {
    expect(alerts.permissions.publishAllow).toEqual([
      '$JS.ACK.TELEMETRY.*.>',
      '$JS.API.CONSUMER.CREATE.TELEMETRY.*.ALERTS.escalated',
      '$JS.API.CONSUMER.CREATE.TELEMETRY.alerts-acks.ALERTS.acknowledged',
      '$JS.API.CONSUMER.CREATE.TELEMETRY.alerts-incidents.INCIDENTS.>',
      '$JS.API.CONSUMER.CREATE.TELEMETRY.alerts-thresholds.ALERTS.cleared',
      '$JS.API.CONSUMER.CREATE.TELEMETRY.alerts-thresholds.ALERTS.raised',
      '$JS.API.CONSUMER.INFO.TELEMETRY.*',
      '$JS.API.CONSUMER.MSG.NEXT.TELEMETRY.*',
      '$JS.API.INFO',
      '$JS.API.STREAM.INFO.TELEMETRY',
      '$JS.API.STREAM.LIST',
      '$JS.API.STREAM.NAMES',
      'INCIDENTS.closed',
      'INCIDENTS.opened',
    ]);
    expect(alerts.permissions.subscribeAllow).toEqual(['_INBOX.>', 'CATALOG.LOOKUP', 'alerts.TASKS']);
    expect(alerts.permissions.allowResponses).toBe(true);
    expect(alerts.user).toBe('alerts-svc');
    const wide = model.diagnostics.filter((d) => d.code === 'consumer-wide-grant');
    expect(wide.map((d) => d.message)).toEqual([expect.stringContaining('"ALERTS.escalated"')]);
    expect(alerts.permissions.publishAllow).not.toContain('$JS.API.CONSUMER.CREATE.TELEMETRY.*.ALERTS.acknowledged');
  });

  it('a @natsacl service-name declaration expands to each service name', () => {
    expect(alerts.permissions.subscribeAllow).toContain('alerts.TASKS');
    expect(ingest.permissions.subscribeAllow).not.toContain('ingest.TASKS');
    const facts = model.analyses.find((a) => a.name === 'alerts')!.facts.filter((f) => f.subject.includes('${service}'));
    expect(facts.map((f) => f.subject)).toEqual(['${service}.TASKS']);
  });

  it('never grants consumer DELETE to a named durable', () => {
    for (const s of model.services) {
      expect(s.permissions.publishAllow.some((g) => g.startsWith('$JS.API.CONSUMER.DELETE'))).toBe(false);
    }
  });

  it('reads stream definitions from code', () => {
    expect(model.streams).toEqual([expect.objectContaining({ name: 'TELEMETRY', subjects: ['ALERTS.>', 'INCIDENTS.>', 'SENSORS.>'] })]);
  });

  it('attributes a shared base-class subscription to the service whose subclass runs it', () => {
    const consumerGrants = (grants: readonly string[]): string[] => grants.filter((g) => g.startsWith('$JS.API.CONSUMER.CREATE'));
    expect(consumerGrants(ingest.permissions.publishAllow)).toEqual(['$JS.API.CONSUMER.CREATE.TELEMETRY.ingest-sensor-readings.SENSORS.reading']);
    expect(consumerGrants(alerts.permissions.publishAllow).some((g) => g.includes('SENSORS.reading'))).toBe(false);
  });

  it('a subject consumed by both services is granted to both, each through its own subclass', () => {
    const { model: shared } = modelFor('basic', {
      services: [
        { name: 'ingest', entry: ['src/ingest/main.ts', 'src/alerts/threshold.subscriber.ts'] },
        { name: 'alerts', entry: 'src/alerts/main.ts' },
      ],
    });
    for (const name of ['ingest', 'alerts']) {
      expect(user(shared, name).permissions.publishAllow).toContain('$JS.API.CONSUMER.CREATE.TELEMETRY.alerts-thresholds.ALERTS.raised');
    }
  });

  it('reports dead subjects and the override, but nothing else', () => {
    const counts: Record<string, number> = {};
    for (const d of model.diagnostics.filter((d) => d.severity === 'warning')) counts[d.code] = (counts[d.code] ?? 0) + 1;
    expect(counts).toEqual({ 'consumer-wide-grant': 1, 'no-publisher': 3, 'no-subscriber': 9 });
    expect(codes(model, 'info')).toEqual(['override-used']);
  });

  it('explains a grant back to the code', () => {
    const why = explain(model, 'ingest', 'SENSORS.reading');
    expect(why).not.toBeNull();
    expect(why!.publish.map((g) => g.grant)).toEqual(['SENSORS.reading']);
    const provenance = why!.publish[0]!.provenance;
    expect(provenance.length).toBe(1);
    expect(provenance[0]!.origin).toBe('parameter');
    expect(provenance[0]!.location.file.endsWith('src/shared/publisher.ts')).toBe(true);
    expect(provenance[0]!.via.some((v) => v.file.endsWith('src/ingest/reading.service.ts'))).toBe(true);
    expect(explain(model, 'nope', 'X')).toBeNull();
    expect(root.length).toBeGreaterThan(0);
  });

  it('external publishers and subscribers silence the dead-subject lint', () => {
    const { model: quiet } = modelFor('basic', { external: { subscribers: ['SENSORS.>', '*.TASKS'], publishers: ['ALERTS.>', '*.TASKS'] } });
    expect(codes(quiet, 'warning')).toEqual(['consumer-wide-grant']);
  });

  it('consumerScoping wildcard collapses consumer tokens', () => {
    const { model: wide } = modelFor('basic', { jetstream: { consumerScoping: 'wildcard' } });
    expect(user(wide, 'ingest').permissions.publishAllow).toContain('$JS.API.CONSUMER.INFO.TELEMETRY.*');
    expect(user(wide, 'ingest').permissions.publishAllow).not.toContain('$JS.API.CONSUMER.INFO.TELEMETRY.ingest-sensor-readings');
  });

  it('legacy JetStream API adds the DURABLE.CREATE form', () => {
    const { model: legacy } = modelFor('basic', { jetstream: { api: 'legacy' } });
    expect(user(legacy, 'ingest').permissions.publishAllow).toContain('$JS.API.CONSUMER.DURABLE.CREATE.TELEMETRY.ingest-sensor-readings');
  });

  it('a custom inbox prefix replaces _INBOX', () => {
    const { model: m } = modelFor('basic', { inboxPrefix: '_INBOX_svc' });
    expect(user(m, 'ingest').permissions.subscribeAllow).toEqual(['_INBOX_svc.>']);
  });

  it('extra and deny lists from config land in the permissions with config provenance', () => {
    const { model: m } = modelFor('basic', {
      services: [
        { name: 'ingest', entry: 'src/ingest/main.ts', extraPublish: ['METRICS.>', '${service}.HEALTH'], denySubscribe: ['SECRET.>'] },
        { name: 'alerts', entry: 'src/alerts/main.ts' },
      ],
    });
    const o = user(m, 'ingest');
    expect(o.permissions.publishAllow).toContain('METRICS.>');
    expect(o.permissions.publishAllow).toContain('ingest.HEALTH');
    expect(o.permissions.subscribeDeny).toEqual(['SECRET.>']);
    expect(o.provenance['publish METRICS.>']![0]!.origin).toBe('override');
  });

  it('a missing entry is an error diagnostic, not a crash', () => {
    const { model: m } = modelFor('basic', { services: [{ name: 'ghost', entry: 'src/nowhere.ts' }] });
    expect(codes(m, 'error')).toEqual(['entry-missing']);
  });

  it('streams from a file, in nats-cli shape, replace from-code', () => {
    const { model: m } = modelFor('basic', { streams: { file: 'streams.json' } });
    expect(m.streams.map((s) => s.name)).toEqual(['DIAGNOSTICS', 'TELEMETRY']);
    expect(user(m, 'alerts').permissions.publishAllow).toContain('$JS.API.CONSUMER.CREATE.TELEMETRY.alerts-incidents.INCIDENTS.>');
  });

  it('a filter the named stream does not carry is an error and emits no consumer grant', () => {
    const { model: m } = modelFor('basic', { streams: [{ name: 'TELEMETRY', subjects: ['SENSORS.>'] }] });
    const errors = m.diagnostics.filter((d) => d.code === 'filter-not-in-stream');
    expect(errors.map((d) => d.message)).toEqual([
      expect.stringContaining('"INCIDENTS.>"'),
      expect.stringContaining('"ALERTS.acknowledged"'),
      expect.stringContaining('"ALERTS.cleared"'),
      expect.stringContaining('"ALERTS.escalated"'),
      expect.stringContaining('"ALERTS.raised"'),
    ]);
    const a = user(m, 'alerts');
    expect(a.permissions.publishAllow.some((g) => g.includes('ALERTS.') || g.includes('INCIDENTS.>'))).toBe(false);
    expect(a.permissions.publishAllow).toContain('$JS.API.CONSUMER.INFO.TELEMETRY.alerts-incidents');
    expect(m.diagnostics.some((d) => d.code === 'publish-not-in-stream' && d.message.includes('INCIDENTS.opened'))).toBe(true);
    expect(user(m, 'ingest').permissions.publishAllow).toContain('$JS.API.CONSUMER.CREATE.TELEMETRY.ingest-sensor-readings.SENSORS.reading');
  });

  it('a stream named in code that is not provisioned is an error', () => {
    const { model: m } = modelFor('basic', { streams: [{ name: 'OTHER', subjects: ['SENSORS.>'] }] });
    const errors = m.diagnostics.filter((d) => d.code === 'filter-not-in-stream');
    // One diagnostic per call site and service: the shared base call is reported once for each service.
    expect(errors.length).toBe(4);
    expect(errors.every((d) => d.message.includes('names stream "TELEMETRY" but no such stream is provisioned'))).toBe(true);
  });

  it('without any streams, an inferred stream becomes "*" with a warning', () => {
    const { model: m } = modelFor('basic', { streams: undefined });
    expect(user(m, 'alerts').permissions.publishAllow).toContain('$JS.API.CONSUMER.CREATE.TELEMETRY.alerts-incidents.INCIDENTS.>');
    expect(codes(m, 'warning')).not.toContain('stream-unknown');
  });
});

describe('references fixture: a solution-style tsconfig', () => {
  it('loads the files of referenced projects', () => {
    const { model } = modelFor('references');
    expect(user(model, 'app').permissions.publishAllow).toEqual(['REF.ok']);
  });
});

describe('errors fixture: what the analyser refuses', () => {
  const { model } = modelFor('errors');

  it('is single-service, named after the directory package or "app"', () => {
    expect(model.services.map((s) => s.service)).toEqual(['app']);
  });

  it('reports partial tokens, whole-subject parameters without callers, and opaque values, each at the call site', () => {
    const errors = model.diagnostics.filter((d) => d.severity === 'error');
    expect(errors.map((d) => d.location?.line)).toEqual([7, 11, 15]);
    expect(errors[0]!.message).toContain('mixes literal text and a dynamic value inside one token');
    expect(errors[1]!.message).toContain('nothing in the program calls it');
    expect(errors[2]!.message).toContain('process.env.SUBJECT');
  });

  it('still derives every resolvable grant', () => {
    expect(user(model, 'app').permissions.publishAllow).toEqual(['HEALTH.ok']);
  });

  it('widenPartialTokens turns the partial token into "*" and reports the widening', () => {
    const { model: widened } = modelFor('errors', { widenPartialTokens: true });
    expect(user(widened, 'app').permissions.publishAllow).toEqual(['*', 'HEALTH.ok']);
    expect(codes(widened, 'warning')).toContain('widened');
    expect(codes(widened, 'warning')).toContain('over-broad');
  });

  it('an override by file and line replaces the unresolved value', () => {
    const { model: fixed } = modelFor('errors', {
      overrides: [
        { file: 'src/main.ts', line: 11, subject: ['DYNAMIC.a', 'DYNAMIC.b'] },
        { file: 'src/main.ts', line: 15, subject: 'ENV.>' },
        { file: 'src/main.ts', line: 7, subject: 'DEVICE-ish' },
      ],
    });
    expect(codes(fixed, 'error')).toEqual([]);
    expect(user(fixed, 'app').permissions.publishAllow).toEqual(['DEVICE-ish', 'DYNAMIC.a', 'DYNAMIC.b', 'ENV.>', 'HEALTH.ok']);
    expect(codes(fixed, 'info').filter((c) => c === 'override-used')).toHaveLength(3);
  });
});
