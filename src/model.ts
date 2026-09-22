/**
 * The data model: what the analyser finds (facts), what it could not resolve,
 * and what the deriver turns facts into (grants) — every grant keeps the call
 * sites that justify it so `natsacl explain` can answer "why does this user
 * hold this permission?".
 */

export interface Location {
  readonly file: string;
  readonly line: number; // 1-based
  readonly col: number; // 1-based
}

export type FactKind =
  | 'publish'
  | 'request'
  | 'respond'
  | 'subscribe'
  | 'js-publish'
  | 'js-subscribe'
  | 'js-consumer-add'
  | 'js-consumer-get'
  | 'js-consumer-info'
  | 'js-consumer-delete'
  | 'js-stream-admin'
  | 'service-endpoint';

/** How a subject value was arrived at; the deriver reports `widened` and `override` in the output. */
export type Origin = 'literal' | 'constant' | 'enum' | 'template' | 'type' | 'parameter' | 'subclass' | 'override' | 'return';

export interface SubjectFact {
  readonly kind: FactKind;
  /** A NATS pattern: literal, or with `*`/`>` where the code is dynamic. */
  readonly subject: string;
  /** The call site that performs the broker operation. */
  readonly location: Location;
  /** The chain of declarations the value travelled through (wrapper params, subclasses, constants). */
  readonly via: readonly Location[];
  /** Files that must all be reachable from a service entry for this fact to belong to that service. */
  readonly requires: readonly string[];
  readonly origin: Origin;
  /** True when a dynamic fragment inside a token was widened to `*` under `widenPartialTokens`. */
  readonly widened: boolean;
  /** JetStream: the stream the call names, when resolvable. */
  readonly stream?: string;
  /** JetStream: the durable / consumer name the call names, when resolvable. */
  readonly durable?: string;
  /** JetStream: whether the call names a consumer at all (an unnamed one is ephemeral and server-named). */
  readonly namesConsumer: boolean;
  /** JetStream subscription mode. */
  readonly mode?: 'pull' | 'push';
}

export interface Unresolved {
  readonly kind: FactKind;
  readonly location: Location;
  readonly expression: string;
  readonly reason: UnresolvedReason;
  readonly detail: string;
  readonly hint: string;
}

export type UnresolvedReason =
  | 'dynamic'
  | 'partial-token'
  | 'multi-token-middle'
  | 'too-many-expansions'
  | 'depth-exceeded'
  | 'no-callers'
  | 'no-subclasses'
  | 'unsupported-syntax';

export interface StreamDef {
  readonly name: string;
  readonly subjects: readonly string[];
  /** Where the definition came from: a file path, `nats stream ls` output, or a code location. */
  readonly source: string;
}

export interface ServiceAnalysis {
  readonly name: string;
  /** Files reachable from the service entry (or every program file in single-service mode). */
  readonly files: readonly string[];
  readonly facts: readonly SubjectFact[];
  readonly unresolved: readonly Unresolved[];
}

export interface Provenance {
  readonly kind: FactKind;
  readonly subject: string;
  readonly location: Location;
  readonly via: readonly Location[];
  readonly origin: Origin;
}

export interface Permissions {
  readonly publishAllow: readonly string[];
  readonly publishDeny: readonly string[];
  readonly subscribeAllow: readonly string[];
  readonly subscribeDeny: readonly string[];
  /** `allow_responses`: may publish to the reply subject of any request it receives. */
  readonly allowResponses: boolean;
}

export interface ServicePermissions {
  readonly service: string;
  readonly user: string;
  readonly permissions: Permissions;
  /** grant → the facts that produced it. */
  readonly provenance: Readonly<Record<string, readonly Provenance[]>>;
}

export type Severity = 'error' | 'warning' | 'info';

export interface Diagnostic {
  readonly severity: Severity;
  readonly code: DiagnosticCode;
  readonly message: string;
  readonly location?: Location;
  readonly service?: string;
}

export type DiagnosticCode =
  | 'unresolved-subject'
  | 'invalid-subject'
  | 'filter-not-in-stream'
  | 'publish-not-in-stream'
  | 'stream-unknown'
  | 'stream-ambiguous'
  | 'no-subscriber'
  | 'no-publisher'
  | 'widened'
  | 'override-used'
  | 'consumer-wide-grant'
  | 'stream-admin-in-service'
  | 'over-broad'
  | 'shape-unused'
  | 'entry-missing';

export interface Model {
  readonly version: 1;
  readonly generator: string;
  readonly streams: readonly StreamDef[];
  readonly services: readonly ServicePermissions[];
  readonly analyses: readonly ServiceAnalysis[];
  readonly diagnostics: readonly Diagnostic[];
}

export function formatLocation(loc: Location): string {
  return `${loc.file}:${loc.line}:${loc.col}`;
}

export function hasErrors(diagnostics: readonly Diagnostic[]): boolean {
  return diagnostics.some((d) => d.severity === 'error');
}
