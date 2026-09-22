import type { ArgRef, ShapeSpec } from './config.js';

/**
 * Built-in call shapes for the official clients — `nats` (v2) and the
 * `@nats-io/*` packages (v3) share these type and method names.
 *
 * Each entry says which argument carries the subject (and, for JetStream, the
 * stream and durable name). A durable the analyser can resolve lets it scope
 * the consumer API grants to that name; one it cannot falls back to `*` for the
 * consumer token, which the lint reports.
 */
export const DEFAULT_SHAPES: readonly ShapeSpec[] = [
  // ─── Core NATS ─────────────────────────────────────────────────────────────
  { kind: 'publish', callee: 'publish', receiverTypes: ['NatsConnection'], subject: 0 },
  { kind: 'request', callee: 'request', receiverTypes: ['NatsConnection'], subject: 0 },
  { kind: 'request', callee: 'requestMany', receiverTypes: ['NatsConnection'], subject: 0 },
  { kind: 'subscribe', callee: 'subscribe', receiverTypes: ['NatsConnection'], subject: 0 },
  { kind: 'respond', callee: 'respond', receiverTypes: ['Msg', 'JsMsg'] },

  // ─── JetStream client ──────────────────────────────────────────────────────
  { kind: 'js-publish', callee: 'publish', receiverTypes: ['JetStreamClient'], subject: 0 },
  {
    kind: 'js-subscribe',
    callee: 'subscribe',
    receiverTypes: ['JetStreamClient'],
    subject: 0,
    durable: { arg: 1, path: 'config.durable_name' },
    stream: { arg: 1, path: 'stream' },
    mode: 'push',
    note: 'legacy push subscription',
  },
  {
    kind: 'js-subscribe',
    callee: 'pullSubscribe',
    receiverTypes: ['JetStreamClient'],
    subject: 0,
    durable: { arg: 1, path: 'config.durable_name' },
    stream: { arg: 1, path: 'stream' },
    mode: 'pull',
    note: 'legacy pull subscription',
  },
  { kind: 'js-consumer-get', callee: 'fetch', receiverTypes: ['JetStreamClient'], stream: 0, durable: 1, mode: 'pull' },
  { kind: 'js-consumer-get', callee: 'pull', receiverTypes: ['JetStreamClient'], stream: 0, durable: 1, mode: 'pull' },
  { kind: 'js-consumer-get', callee: 'get', receiverTypes: ['Consumers'], stream: 0, durable: 1, mode: 'pull' },

  // ─── JetStream manager ─────────────────────────────────────────────────────
  {
    kind: 'js-consumer-add',
    callee: 'add',
    receiverTypes: ['ConsumerAPI'],
    stream: 0,
    subject: { arg: 1, path: 'filter_subject' },
    durable: { arg: 1, path: 'durable_name' },
  },
  {
    kind: 'js-consumer-add',
    callee: 'update',
    receiverTypes: ['ConsumerAPI'],
    stream: 0,
    durable: 1,
    subject: { arg: 2, path: 'filter_subject' },
  },
  { kind: 'js-consumer-info', callee: 'info', receiverTypes: ['ConsumerAPI'], stream: 0, durable: 1 },
  { kind: 'js-consumer-delete', callee: 'delete', receiverTypes: ['ConsumerAPI'], stream: 0, durable: 1 },
  { kind: 'js-stream-admin', callee: 'add', receiverTypes: ['StreamAPI'], stream: { arg: 0, path: 'name' }, subject: { arg: 0, path: 'subjects' } },
  { kind: 'js-stream-admin', callee: 'update', receiverTypes: ['StreamAPI'], stream: 0, subject: { arg: 1, path: 'subjects' } },
  { kind: 'js-stream-admin', callee: 'delete', receiverTypes: ['StreamAPI'], stream: 0 },
  { kind: 'js-stream-admin', callee: 'purge', receiverTypes: ['StreamAPI'], stream: 0 },

  // ─── Services API ──────────────────────────────────────────────────────────
  { kind: 'service-endpoint', callee: 'addEndpoint', receiverTypes: ['Service', 'ServiceGroup'], subject: { arg: 1, path: 'subject' } },
];

/** The `@natsacl` JSDoc grammar: `<kind> [subject=<ref>] [stream=<ref>] [durable=<ref>] [mode=pull|push]`. */
export function parseJsDocShape(text: string, callee: string): ShapeSpec | null {
  const parts = text.trim().split(/\s+/).filter(Boolean);
  const kind = parts[0];
  if (!kind || !isFactKind(kind)) return null;
  const spec: { -readonly [K in keyof ShapeSpec]: ShapeSpec[K] } = { kind, callee, receiverTypes: [] };
  for (const part of parts.slice(1)) {
    const eq = part.indexOf('=');
    if (eq < 0) return null;
    const key = part.slice(0, eq);
    const value = part.slice(eq + 1);
    if (key === 'mode') {
      if (value !== 'pull' && value !== 'push') return null;
      spec.mode = value;
      continue;
    }
    if (key !== 'subject' && key !== 'stream' && key !== 'durable') return null;
    const ref = parseArgRef(value);
    if (ref === null) return null;
    spec[key] = ref;
  }
  return spec;
}

/** `0` → 0; `1.config.durable_name` → { arg: 1, path: 'config.durable_name' }. */
export function parseArgRef(value: string): ArgRef | null {
  const m = /^(\d+)(?:\.(.+))?$/.exec(value);
  if (!m) return null;
  const arg = Number(m[1]);
  return m[2] ? { arg, path: m[2] } : arg;
}

const FACT_KINDS = new Set([
  'publish',
  'request',
  'respond',
  'subscribe',
  'js-publish',
  'js-subscribe',
  'js-consumer-add',
  'js-consumer-get',
  'js-consumer-info',
  'js-consumer-delete',
  'js-stream-admin',
  'service-endpoint',
]);

export function isFactKind(value: string): value is ShapeSpec['kind'] {
  return FACT_KINDS.has(value);
}
