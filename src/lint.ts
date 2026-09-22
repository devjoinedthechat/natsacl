import type { Analysis } from './analyze.js';
import type { ResolvedConfig } from './config.js';
import type { Diagnostic, ServiceAnalysis, ServicePermissions, StreamDef, SubjectFact } from './model.js';
import { DiagnosticSet } from './derive.js';
import { SERVICE_PLACEHOLDER } from './evaluate.js';
import { overlaps, tokensOf } from './subjects.js';

/**
 * Checks on the whole model that no single grant can tell you:
 * publishers with no subscriber, JetStream publishes no stream captures,
 * grants that are wildcards from the first token, stream administration inside
 * a service, and the bookkeeping the analyser reports (widened tokens,
 * overrides, shapes that matched nothing).
 */
const SYSTEM_PREFIX = /^(\$JS|\$SYS|\$KV|\$O|\$SRV|_INBOX)/;
const PUBLISHING: ReadonlySet<SubjectFact['kind']> = new Set(['publish', 'request', 'js-publish']);
const CONSUMING: ReadonlySet<SubjectFact['kind']> = new Set(['subscribe', 'js-subscribe', 'js-consumer-add', 'service-endpoint']);

export function lint(
  config: ResolvedConfig,
  analysis: Analysis,
  streams: readonly StreamDef[],
  services: readonly ServicePermissions[],
  analyses: readonly ServiceAnalysis[],
): Diagnostic[] {
  const out = new DiagnosticSet();

  for (const w of analysis.facts.filter((f) => f.widened)) {
    out.add({ severity: 'warning', code: 'widened', message: `"${w.subject}": a dynamic fragment inside a token was widened to "*" (widenPartialTokens)`, location: w.location });
  }
  for (const o of analysis.overridesUsed) {
    out.add({ severity: 'info', code: 'override-used', message: `subject taken from an override: ${o.patterns.join(', ')}`, location: o.location });
  }
  for (const shape of analysis.unusedShapes) {
    out.add({ severity: 'warning', code: 'shape-unused', message: `shape ${shape.kind} "${shape.callee}"${shape.receiverTypes?.length ? ` on ${shape.receiverTypes.join('|')}` : ''} matched no call — check the callee name and receiver type` });
  }

  for (const a of analyses) {
    const files = new Set(a.files);
    for (const call of analysis.streamAdminCalls) {
      if (files.has(call.file)) {
        out.add({ severity: 'warning', code: 'stream-admin-in-service', message: `stream administration inside "${a.name}"; services receive no stream grants — provision streams from the admin user`, location: call, service: a.name });
      }
    }
  }

  if (streams.length > 0) {
    for (const fact of analysis.facts) {
      if (fact.kind !== 'js-publish') continue;
      if (!streams.some((s) => s.subjects.some((subject) => overlaps(subject, fact.subject)))) {
        out.add({ severity: 'warning', code: 'publish-not-in-stream', message: `JetStream publish to "${fact.subject}" is captured by no provisioned stream; the publish would time out with no responders`, location: fact.location });
      }
    }
  }

  if (config.lint.deadSubjects !== 'off') {
    const severity = config.lint.deadSubjects;
    const published = new Map<string, SubjectFact>();
    const consumed = new Map<string, SubjectFact>();
    for (const fact of analysis.facts) {
      if (SYSTEM_PREFIX.test(fact.subject) || fact.subject === '') continue;
      const subject = fact.subject.replaceAll(SERVICE_PLACEHOLDER, '*');
      if (PUBLISHING.has(fact.kind)) published.set(subject, published.get(subject) ?? fact);
      if (CONSUMING.has(fact.kind)) consumed.set(subject, consumed.get(subject) ?? fact);
    }
    const consumers = [...consumed.keys(), ...config.external.subscribers];
    const publishers = [...published.keys(), ...config.external.publishers];
    for (const [subject, fact] of published) {
      if (!consumers.some((c) => overlaps(c, subject))) {
        out.add({ severity, code: 'no-subscriber', message: `"${subject}" is published but nothing in the program subscribes to it (declare external.subscribers if another system consumes it)`, location: fact.location });
      }
    }
    for (const [subject, fact] of consumed) {
      if (subject === '>' ) continue;
      if (!publishers.some((p) => overlaps(p, subject))) {
        out.add({ severity, code: 'no-publisher', message: `"${subject}" is consumed but nothing in the program publishes it (declare external.publishers if another system produces it)`, location: fact.location });
      }
    }
  }

  if (config.lint.overBroad !== 'off') {
    for (const s of services) {
      for (const [list, grants] of [
        ['publish', s.permissions.publishAllow],
        ['subscribe', s.permissions.subscribeAllow],
      ] as const) {
        for (const grant of grants) {
          if (SYSTEM_PREFIX.test(grant)) continue;
          const first = tokensOf(grant)[0]!;
          if (first === '>' || first === '*') {
            const prov = s.provenance[`${list} ${grant}`]?.[0];
            out.add({ severity: config.lint.overBroad, code: 'over-broad', message: `${s.user} may ${list} "${grant}": a wildcard in the first token spans every subject namespace`, service: s.service, ...(prov ? { location: prov.location } : {}) });
          }
        }
      }
    }
  }

  return out.list();
}
