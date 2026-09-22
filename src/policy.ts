import { NO_SUBJECT } from './analyze.js';
import type { ResolvedConfig } from './config.js';
import { SERVICE_PLACEHOLDER } from './evaluate.js';
import type { Diagnostic, ServiceAnalysis, SubjectFact } from './model.js';
import { overlaps } from './subjects.js';

/**
 * Policy is checked against what the code does — the facts — not against the rendered
 * grants, so a JetStream consumer on a forbidden subject is caught even though it shows
 * up in the permissions as a `$JS.API.CONSUMER.CREATE…` publish grant. A violation is an
 * error: `compile` writes nothing, and the diagnostic carries the call site.
 */
const PUBLISHING: ReadonlySet<SubjectFact['kind']> = new Set(['publish', 'request', 'js-publish', 'kv']);
const CONSUMING: ReadonlySet<SubjectFact['kind']> = new Set(['subscribe', 'js-subscribe', 'js-consumer-add', 'service-endpoint', 'kv']);

export function checkPolicy(config: ResolvedConfig, analyses: readonly ServiceAnalysis[]): Diagnostic[] {
  const out: Diagnostic[] = [];
  const seen = new Set<string>();
  for (const rule of config.policy.forbid) {
    const because = rule.reason ? ` (${rule.reason})` : '';
    const allowed = rule.except.length > 0 ? `; only ${rule.except.join(', ')} may` : '';
    for (const analysis of analyses) {
      if (rule.except.includes(analysis.name)) continue;
      const service = config.services.find((s) => s.name === analysis.name);
      const user = service?.user ?? analysis.name;
      const report = (verb: string, subject: string, location: Diagnostic['location']): void => {
        const key = `${rule.subject}|${analysis.name}|${verb}|${subject}|${location ? `${location.file}:${location.line}` : ''}`;
        if (seen.has(key)) return;
        seen.add(key);
        out.push({
          severity: 'error',
          code: 'policy-violation',
          message: `${user} ${verb} "${subject}", which overlaps the forbidden "${rule.subject}"${because}${allowed}`,
          ...(location ? { location } : {}),
          service: analysis.name,
        });
      };
      for (const fact of analysis.facts) {
        if (fact.subject === NO_SUBJECT) continue;
        const subject = fact.subject.replaceAll(SERVICE_PLACEHOLDER, analysis.name);
        if (!overlaps(rule.subject, subject)) continue;
        if (rule.publish && PUBLISHING.has(fact.kind)) report('publishes', subject, fact.location);
        if (rule.subscribe && CONSUMING.has(fact.kind)) report('consumes', subject, fact.location);
      }
      if (!service) continue;
      const configLocation = { file: config.configFile ?? '<config>', line: 0, col: 0 };
      const expand = (s: string): string => s.replaceAll(SERVICE_PLACEHOLDER, service.name);
      if (rule.publish) for (const s of service.extraPublish.map(expand)) if (overlaps(rule.subject, s)) report('publishes (extraPublish)', s, configLocation);
      if (rule.subscribe) for (const s of service.extraSubscribe.map(expand)) if (overlaps(rule.subject, s)) report('subscribes (extraSubscribe)', s, configLocation);
    }
  }
  return out;
}
