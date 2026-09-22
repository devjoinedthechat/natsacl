import type { Analysis } from './analyze.js';
import { NO_SUBJECT } from './analyze.js';
import type { ResolvedConfig, ResolvedService } from './config.js';
import type { Diagnostic, Location, Permissions, Provenance, ServiceAnalysis, ServicePermissions, StreamDef, SubjectFact } from './model.js';
import { SERVICE_PLACEHOLDER } from './evaluate.js';
import { covers, minimize } from './subjects.js';

/**
 * Facts → permissions, one user per service.
 *
 * Every JetStream grant follows the same table (see README "What a consumer
 * needs"): consumer creation is scoped to the exact filter subject the code
 * subscribes with, because the server does not enforce subscribe permissions
 * on consumer filters — the API subject is the only place that boundary can
 * be drawn. Consumer INFO/NEXT/ACK/DELETE are scoped to the durable name when
 * the code names one literally, and to `*` (any consumer of that stream)
 * otherwise, which the lint reports.
 */
export interface DeriveInput {
  readonly config: ResolvedConfig;
  readonly analysis: Analysis;
  readonly streams: readonly StreamDef[];
  /** Service name → reachable files; null in single-service mode (every file belongs to the one service). */
  readonly reachability: ReadonlyMap<string, ReadonlySet<string>> | null;
  readonly allFiles: readonly string[];
}

export interface DeriveOutput {
  readonly services: readonly ServicePermissions[];
  readonly analyses: readonly ServiceAnalysis[];
  readonly diagnostics: readonly Diagnostic[];
}

const CONSUMING_KINDS = new Set<SubjectFact['kind']>(['js-subscribe', 'js-consumer-add', 'js-consumer-get', 'js-consumer-info', 'js-consumer-delete']);

export function derive(input: DeriveInput): DeriveOutput {
  const { config, analysis, streams } = input;
  const services: ServicePermissions[] = [];
  const analyses: ServiceAnalysis[] = [];
  const diagnostics = new DiagnosticSet();

  for (const service of config.services) {
    const files = input.reachability ? input.reachability.get(service.name) ?? new Set<string>() : new Set(input.allFiles);
    const facts = analysis.facts.filter((f) => f.requires.every((r) => files.has(r)));
    const unresolved = analysis.unresolved.filter((u) => files.has(u.location.file));
    analyses.push({ name: service.name, files: [...files].sort(), facts, unresolved });

    for (const u of unresolved) {
      diagnostics.add({
        severity: 'error',
        code: 'unresolved-subject',
        message: `${u.kind}: ${u.detail} — ${u.hint}`,
        location: u.location,
        service: service.name,
      });
    }

    services.push(buildPermissions(service, facts, streams, config, diagnostics));
  }

  return { services, analyses, diagnostics: diagnostics.list() };
}

function buildPermissions(
  service: ResolvedService,
  facts: readonly SubjectFact[],
  streams: readonly StreamDef[],
  config: ResolvedConfig,
  diagnostics: DiagnosticSet,
): ServicePermissions {
  const publish = new GrantSet();
  const subscribe = new GrantSet();
  let allowResponses = false;
  let jetstreamUsed = false;
  const inbox = `${service.inboxPrefix}.>`;

  for (const raw of facts) {
    const fact: SubjectFact = raw.subject.includes(SERVICE_PLACEHOLDER) ? { ...raw, subject: raw.subject.replaceAll(SERVICE_PLACEHOLDER, service.name) } : raw;
    const prov: Provenance = { kind: fact.kind, subject: fact.subject, location: fact.location, via: fact.via, origin: fact.origin };
    switch (fact.kind) {
      case 'publish':
        publish.add(fact.subject, prov);
        break;
      case 'request':
        publish.add(fact.subject, prov);
        subscribe.add(inbox, prov);
        break;
      case 'respond':
        allowResponses = true;
        break;
      case 'subscribe':
        subscribe.add(fact.subject, prov);
        break;
      case 'service-endpoint':
        subscribe.add(fact.subject, prov);
        allowResponses = true;
        break;
      case 'js-publish':
        jetstreamUsed = true;
        publish.add(fact.subject, prov);
        subscribe.add(inbox, prov);
        break;
      case 'js-stream-admin':
        break;
      default: {
        if (!CONSUMING_KINDS.has(fact.kind)) break;
        jetstreamUsed = true;
        subscribe.add(inbox, prov);
        const streamTokens = resolveStreams(fact, streams, service.name, diagnostics);
        if (streamTokens.length === 0) break;
        const durableToken = consumerToken(fact, config, service.name, diagnostics);
        for (const stream of streamTokens) {
          const base = `${stream}.${durableToken}`;
          if (fact.kind === 'js-subscribe' || fact.kind === 'js-consumer-add') {
            const filter = fact.subject === '>' || fact.subject === NO_SUBJECT ? null : fact.subject;
            publish.add(filter ? `$JS.API.CONSUMER.CREATE.${base}.${filter}` : `$JS.API.CONSUMER.CREATE.${base}`, prov);
            if (config.jetstream.api === 'legacy') publish.add(`$JS.API.CONSUMER.DURABLE.CREATE.${base}`, prov);
          }
          if (fact.kind !== 'js-consumer-delete') {
            publish.add(`$JS.API.CONSUMER.INFO.${base}`, prov);
          }
          if (fact.kind === 'js-subscribe' || fact.kind === 'js-consumer-get' || fact.kind === 'js-consumer-add') {
            if (fact.mode !== 'push') publish.add(`$JS.API.CONSUMER.MSG.NEXT.${base}`, prov);
            publish.add(`$JS.ACK.${base}.>`, prov);
          }
          const ephemeral = fact.kind === 'js-subscribe' && !fact.namesConsumer;
          const wantsDelete =
            config.jetstream.allowConsumerDelete === true ||
            (config.jetstream.allowConsumerDelete === 'auto' && (fact.kind === 'js-consumer-delete' || ephemeral));
          if (wantsDelete) publish.add(`$JS.API.CONSUMER.DELETE.${base}`, prov);
          publish.add(`$JS.API.STREAM.INFO.${stream}`, prov);
          if (!fact.stream) publish.add('$JS.API.STREAM.NAMES', prov);
        }
      }
    }
  }

  if (jetstreamUsed) publish.add('$JS.API.INFO', null);

  const configProv = (kind: 'publish' | 'subscribe', subject: string): Provenance => ({
    kind,
    subject,
    location: { file: config.configFile ?? '<config>', line: 0, col: 0 },
    via: [],
    origin: 'override',
  });
  const expand = (s: string): string => s.replaceAll(SERVICE_PLACEHOLDER, service.name);
  for (const s of service.extraPublish.map(expand)) publish.add(s, configProv('publish', s));
  for (const s of service.extraSubscribe.map(expand)) subscribe.add(s, configProv('subscribe', s));

  const permissions: Permissions = {
    publishAllow: publish.minimized(),
    publishDeny: minimize(service.denyPublish.map(expand)),
    subscribeAllow: subscribe.minimized(),
    subscribeDeny: minimize(service.denySubscribe.map(expand)),
    allowResponses,
  };
  const provenance: Record<string, readonly Provenance[]> = {};
  for (const grant of permissions.publishAllow) provenance[`publish ${grant}`] = publish.provenanceFor(grant);
  for (const grant of permissions.subscribeAllow) provenance[`subscribe ${grant}`] = subscribe.provenanceFor(grant);

  return { service: service.name, user: service.user, permissions, provenance };
}

/** The stream token(s) for a consuming fact: named in code, inferred from the provisioned streams, or `*`. */
function resolveStreams(fact: SubjectFact, streams: readonly StreamDef[], service: string, diagnostics: DiagnosticSet): string[] {
  if (fact.stream) {
    if (streams.length === 0) return [fact.stream];
    const named = streams.find((s) => s.name === fact.stream);
    if (!named) {
      diagnostics.add({
        severity: 'error',
        code: 'filter-not-in-stream',
        message: `${fact.kind}: the code names stream "${fact.stream}" but no such stream is provisioned (${streams.map((s) => s.name).join(', ')}); no grant is emitted`,
        location: fact.location,
        service,
      });
      return [];
    }
    const wholeStream = fact.subject === NO_SUBJECT || fact.subject === '>';
    if (!wholeStream && !named.subjects.some((subject) => covers(subject, fact.subject))) {
      diagnostics.add({
        severity: 'error',
        code: 'filter-not-in-stream',
        message: `${fact.kind} on "${fact.subject}": stream ${named.name} carries ${named.subjects.map((s) => `"${s}"`).join(', ')}, which does not cover it; JetStream would reject the consumer, so no grant is emitted`,
        location: fact.location,
        service,
      });
      return [];
    }
    return [fact.stream];
  }
  // One provisioned stream: a call that names none can only mean it.
  if (streams.length === 1) return [streams[0]!.name];
  if (fact.subject === NO_SUBJECT) {
    diagnostics.add({
      severity: 'warning',
      code: 'stream-unknown',
      message: `${fact.kind}: the stream is not a literal at this call, so consumer grants use "*" for the stream token`,
      location: fact.location,
      service,
    });
    return ['*'];
  }
  if (streams.length === 0) {
    diagnostics.add({
      severity: 'warning',
      code: 'stream-unknown',
      message: `${fact.kind} on "${fact.subject}": no stream named at the call and no streams configured, so consumer grants use "*" for the stream token`,
      location: fact.location,
      service,
    });
    return ['*'];
  }
  const matching = streams.filter((s) => s.subjects.some((subject) => covers(subject, fact.subject)));
  if (matching.length === 1) return [matching[0]!.name];
  if (matching.length > 1) {
    diagnostics.add({
      severity: 'info',
      code: 'stream-ambiguous',
      message: `"${fact.subject}" is carried by ${matching.map((s) => s.name).join(', ')}; consumer grants are emitted for each`,
      location: fact.location,
      service,
    });
    return matching.map((s) => s.name);
  }
  diagnostics.add({
    severity: 'error',
    code: 'filter-not-in-stream',
    message: `${fact.kind} on "${fact.subject}": no provisioned stream carries this subject (${streams.map((s) => s.name).join(', ')}); JetStream would reject the consumer, so no grant is emitted`,
    location: fact.location,
    service,
  });
  return [];
}

function consumerToken(fact: SubjectFact, config: ResolvedConfig, service: string, diagnostics: DiagnosticSet): string {
  if (config.jetstream.consumerScoping === 'wildcard') return '*';
  if (fact.durable) return fact.durable;
  // An unnamed consumer is server-named: `*` is the only token that can admit it.
  if (!fact.namesConsumer) return '*';
  diagnostics.add({
    severity: 'warning',
    code: 'consumer-wide-grant',
    message: `${fact.kind}${fact.subject ? ` on "${fact.subject}"` : ''}: the consumer name is not a literal here, so INFO/NEXT/ACK grants cover every consumer of the stream ("*")`,
    location: fact.location,
    service,
  });
  return '*';
}

class GrantSet {
  private readonly entries = new Map<string, Provenance[]>();

  add(pattern: string, prov: Provenance | null): void {
    const list = this.entries.get(pattern);
    if (list) {
      if (prov) list.push(prov);
    } else this.entries.set(pattern, prov ? [prov] : []);
  }

  minimized(): string[] {
    return minimize(this.entries.keys());
  }

  /** Every fact whose pattern the (possibly broader) grant covers. */
  provenanceFor(grant: string): Provenance[] {
    const out: Provenance[] = [];
    for (const [pattern, provs] of this.entries) if (covers(grant, pattern)) out.push(...provs);
    return out;
  }
}

export class DiagnosticSet {
  private readonly seen = new Set<string>();
  private readonly items: Diagnostic[] = [];

  add(d: Diagnostic): void {
    const key = `${d.severity}|${d.code}|${d.message}|${d.location ? locKey(d.location) : ''}|${d.service ?? ''}`;
    if (this.seen.has(key)) return;
    this.seen.add(key);
    this.items.push(d);
  }

  list(): Diagnostic[] {
    return [...this.items];
  }
}

function locKey(loc: Location): string {
  return `${loc.file}:${loc.line}:${loc.col}`;
}
