/**
 * The generated permissions, loaded into a real nats-server and exercised with the
 * real client: every grant the fixture's code needs must work, and the operations the
 * code does not perform must be refused. Runs when Docker is available; skipped otherwise.
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { AckPolicy, connect, StringCodec, type NatsConnection } from 'nats';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { render } from '../../src/index.js';
import { modelFor } from '../helpers.js';

const IMAGE = process.env.NATSACL_NATS_IMAGE ?? 'nats:2.10-alpine';
const dockerAvailable = ((): boolean => {
  try {
    execFileSync('docker', ['info'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
})();

const PASSWORDS = { INGEST_NATS_PASSWORD: 'ingest-pw', ALERTS_NATS_PASSWORD: 'alerts-pw', ADMIN_NATS_PASSWORD: 'admin-pw' };
const sc = StringCodec();

describe.skipIf(!dockerAvailable)('permissions enforced by a real nats-server', () => {
  let container = '';
  let url = '';
  let dir = '';
  const connections: NatsConnection[] = [];

  async function connectAs(user: string, pass: string): Promise<NatsConnection> {
    const nc = await connect({ servers: url, user, pass, timeout: 3000, reconnect: false });
    connections.push(nc);
    return nc;
  }

  /**
   * The client reports a refused publish only as a status event carrying the code
   * `PERMISSIONS_VIOLATION`; a refused subscription also fails the subscription's iterator.
   */
  function violations(nc: NatsConnection): { readonly count: () => number } {
    let count = 0;
    void (async () => {
      for await (const s of nc.status()) {
        const text = typeof s.data === 'string' ? s.data : JSON.stringify(s.data);
        if (s.type === 'error' && /PERMISSIONS_VIOLATION/.test(text)) count++;
      }
    })().catch(() => undefined);
    return { count: () => count };
  }

  async function eventually(check: () => boolean, ms = 3000): Promise<boolean> {
    const until = Date.now() + ms;
    while (Date.now() < until) {
      if (check()) return true;
      await new Promise((r) => setTimeout(r, 50));
    }
    return check();
  }

  beforeAll(async () => {
    const { model, config } = modelFor('basic');
    dir = mkdtempSync(resolve(tmpdir(), 'natsacl-nats-'));
    writeFileSync(resolve(dir, 'auth.conf'), render(model, config, 'server'));
    writeFileSync(resolve(dir, 'nats-server.conf'), 'listen: 0.0.0.0:4222\njetstream { store_dir: /tmp/jetstream }\ninclude "auth.conf"\n');
    const envFlags = Object.entries(PASSWORDS).flatMap(([k, v]) => ['-e', `${k}=${v}`]);
    container = execFileSync('docker', ['run', '-d', '--rm', '-p', '127.0.0.1::4222', '-v', `${dir}:/etc/nats:ro`, ...envFlags, IMAGE, '-c', '/etc/nats/nats-server.conf'], { encoding: 'utf8' }).trim();
    const mapped = execFileSync('docker', ['port', container, '4222/tcp'], { encoding: 'utf8' }).trim().split('\n')[0]!;
    url = `nats://${mapped.replace('0.0.0.0', '127.0.0.1')}`;
    let lastError: unknown;
    for (let attempt = 0; attempt < 40; attempt++) {
      try {
        const nc = await connect({ servers: url, user: 'admin', pass: PASSWORDS.ADMIN_NATS_PASSWORD, timeout: 1000, reconnect: false });
        await nc.close();
        lastError = undefined;
        break;
      } catch (err) {
        lastError = err;
        await new Promise((r) => setTimeout(r, 500));
      }
    }
    if (lastError) throw new Error(`nats-server did not come up: ${String(lastError)}\n${execFileSync('docker', ['logs', container], { encoding: 'utf8' })}`);
  }, 120_000);

  afterAll(async () => {
    for (const nc of connections) await nc.close().catch(() => undefined);
    if (container) execFileSync('docker', ['rm', '-f', container], { stdio: 'ignore' });
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it('the admin user provisions the stream the code consumes from', async () => {
    const admin = await connectAs('admin', PASSWORDS.ADMIN_NATS_PASSWORD);
    const jsm = await admin.jetstreamManager();
    const info = await jsm.streams.add({ name: 'TELEMETRY', subjects: ['SENSORS.>', 'ALERTS.>', 'INCIDENTS.>'] });
    expect(info.config.name).toBe('TELEMETRY');
  });

  it('alerts-svc can create its filtered consumer, publish, consume and ack', async () => {
    const alerts = await connectAs('alerts-svc', PASSWORDS.ALERTS_NATS_PASSWORD);
    const jsm = await alerts.jetstreamManager({ timeout: 3000 });
    const js = alerts.jetstream({ timeout: 3000 });
    await jsm.consumers.add('TELEMETRY', { durable_name: 'alerts-incidents', filter_subject: 'INCIDENTS.>', ack_policy: AckPolicy.Explicit });
    const ack = await js.publish('INCIDENTS.opened', sc.encode('{}'));
    expect(ack.stream).toBe('TELEMETRY');
    const consumer = await js.consumers.get('TELEMETRY', 'alerts-incidents');
    const msg = await consumer.next({ expires: 3000 });
    expect(msg?.subject).toBe('INCIDENTS.opened');
    msg!.ack();
    await alerts.flush();
  }, 30_000);

  it('alerts-svc cannot create a consumer on a filter its code never subscribes to', async () => {
    const alerts = await connectAs('alerts-svc', PASSWORDS.ALERTS_NATS_PASSWORD);
    const jsm = await alerts.jetstreamManager({ timeout: 2000 });
    await expect(jsm.consumers.add('TELEMETRY', { durable_name: 'alerts-snoop', filter_subject: 'SENSORS.>', ack_policy: AckPolicy.Explicit })).rejects.toThrow();
  }, 30_000);

  it('alerts-svc is refused a core publish and a core subscribe outside its grants, and allowed its own', async () => {
    const alerts = await connectAs('alerts-svc', PASSWORDS.ALERTS_NATS_PASSWORD);
    const seen = violations(alerts);

    alerts.publish('INCIDENTS.opened', sc.encode('{}')); // in its grants: no violation
    await alerts.flush();
    await new Promise((r) => setTimeout(r, 300));
    expect(seen.count()).toBe(0);

    alerts.publish('SENSORS.reading', sc.encode('x')); // ingest's subject: refused
    await alerts.flush();
    expect(await eventually(() => seen.count() === 1)).toBe(true);

    const sub = alerts.subscribe('SENSORS.reading');
    let error: { code?: string; message?: string } | null = null;
    try {
      for await (const m of sub) void m;
    } catch (err) {
      error = err as { code?: string; message?: string };
    }
    expect(error?.code).toBe('PERMISSIONS_VIOLATION');
    expect(error?.message).toMatch(/Subscription to "SENSORS\.reading"/);
  }, 30_000);

  it('request/reply works across the two users through allow_responses', async () => {
    const alerts = await connectAs('alerts-svc', PASSWORDS.ALERTS_NATS_PASSWORD);
    const ingest = await connectAs('ingest', PASSWORDS.INGEST_NATS_PASSWORD);
    const sub = alerts.subscribe('CATALOG.LOOKUP');
    void (async () => {
      for await (const m of sub) m.respond(sc.encode('{"model":"TH-200"}'));
    })();
    await alerts.flush();
    const reply = await ingest.request('CATALOG.LOOKUP', sc.encode('sensor-1'), { timeout: 3000 });
    expect(sc.decode(reply.data)).toContain('TH-200');
  }, 30_000);

  it('alerts-svc can bind, read, write and watch the KV bucket the admin provisioned; ingest cannot even bind', async () => {
    const admin = await connectAs('admin', PASSWORDS.ADMIN_NATS_PASSWORD);
    await admin.jetstream().views.kv('cfg', { history: 5 });

    const alerts = await connectAs('alerts-svc', PASSWORDS.ALERTS_NATS_PASSWORD);
    const kv = await alerts.jetstream({ timeout: 3000 }).views.kv('cfg', { bindOnly: true });
    await kv.put('threshold', sc.encode('42'));
    const entry = await kv.get('threshold');
    expect(entry?.string()).toBe('42');
    const watch = await kv.watch({ key: 'threshold' });
    const iterator = watch[Symbol.asyncIterator]();
    const seen = await Promise.race([iterator.next(), new Promise<{ done: true; value: undefined }>((r) => setTimeout(() => r({ done: true, value: undefined }), 4000))]);
    expect(seen.done).toBe(false);
    if (!seen.done) expect(seen.value.key).toBe('threshold');
    watch.stop();
    const keys = await kv.keys();
    const collected: string[] = [];
    for await (const k of keys) collected.push(k);
    expect(collected).toEqual(['threshold']);
    await kv.delete('threshold');
    expect((await kv.get('threshold'))?.operation).toBe('DEL');

    // Binding with bindOnly makes no server call; the refusal shows on the first read.
    const ingest = await connectAs('ingest', PASSWORDS.INGEST_NATS_PASSWORD);
    const foreign = await ingest.jetstream({ timeout: 2000 }).views.kv('cfg', { bindOnly: true });
    await expect(foreign.get('threshold')).rejects.toThrow();
  }, 40_000);

  it('ingest can pull-subscribe with its durable, publish its own subjects, and is refused a JetStream publish it never makes', async () => {
    const ingest = await connectAs('ingest', PASSWORDS.INGEST_NATS_PASSWORD);
    const js = ingest.jetstream({ timeout: 3000 });
    const sub = await js.pullSubscribe('SENSORS.reading', { stream: 'TELEMETRY', config: { durable_name: 'ingest-sensor-readings', ack_policy: AckPolicy.Explicit } });
    ingest.publish('SENSORS.reading', sc.encode('{"id":"s1"}'));
    await ingest.flush();
    sub.pull({ batch: 1, expires: 3000 });
    const iterator = sub[Symbol.asyncIterator]();
    const first = await Promise.race([iterator.next(), new Promise<{ done: true; value: undefined }>((r) => setTimeout(() => r({ done: true, value: undefined }), 4000))]);
    expect(first.done).toBe(false);
    if (!first.done) {
      expect(first.value.subject).toBe('SENSORS.reading');
      first.value.ack();
    }
    await expect(js.publish('INCIDENTS.opened', sc.encode('{}'))).rejects.toThrow();
  }, 30_000);
});
