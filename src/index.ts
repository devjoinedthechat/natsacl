import { createRequire } from 'node:module';
import { analyze, type Analysis } from './analyze.js';
import { loadConfig, type OutputFormat, type ResolvedConfig } from './config.js';
import { derive } from './derive.js';
import { lint } from './lint.js';
import type { Diagnostic, Model, Provenance, ServicePermissions } from './model.js';
import { createProgramContext, ProgramError, reachableFiles, type ProgramContext } from './program.js';
import { renderJson } from './render/json.js';
import { renderMarkdown } from './render/markdown.js';
import { renderJwtPermissions, renderNsc } from './render/nsc.js';
import { renderServerConf } from './render/server-conf.js';
import { loadStreams } from './streams.js';
import { covers, matches } from './subjects.js';

export { defineConfig, resolveConfig, loadConfig, ConfigError, type Config, type ResolvedConfig, type ShapeSpec, type ServiceSpec, type OutputFormat } from './config.js';
export type { Model, ServicePermissions, Permissions, Provenance, Diagnostic, SubjectFact, StreamDef, Location } from './model.js';
export { hasErrors, formatLocation } from './model.js';
export { DEFAULT_SHAPES } from './shapes.js';
export { covers, matches, overlaps, minimize, isValidPattern } from './subjects.js';
export { formatDiagnostic } from './render/markdown.js';

const require = createRequire(import.meta.url);
const { version } = require('../package.json') as { version: string };
export const VERSION: string = version;
export const GENERATOR = `natsacl ${VERSION}`;

/** Build the permission model for a resolved config: parse, analyse, derive, lint. */
export function buildModel(config: ResolvedConfig): Model {
  const contexts = new Map<string, ProgramContext>();
  const analyses = new Map<string, Analysis>();
  const diagnostics: Diagnostic[] = [];

  for (const service of config.services) {
    if (contexts.has(service.tsconfig)) continue;
    const entries = config.services.filter((s) => s.tsconfig === service.tsconfig).flatMap((s) => s.entries);
    const ctx = createProgramContext(service.tsconfig, entries);
    contexts.set(service.tsconfig, ctx);
    analyses.set(service.tsconfig, analyze(ctx, config));
  }

  const merged: Analysis = mergeAnalyses([...analyses.values()]);
  const allFiles = [...new Set([...contexts.values()].flatMap((c) => c.sourceFiles.map((sf) => sf.fileName)))];

  let reachability: Map<string, ReadonlySet<string>> | null = null;
  if (!config.singleService) {
    reachability = new Map();
    for (const service of config.services) {
      const ctx = contexts.get(service.tsconfig)!;
      try {
        reachability.set(service.name, reachableFiles(ctx, service.entries));
      } catch (err) {
        if (!(err instanceof ProgramError)) throw err;
        diagnostics.push({ severity: 'error', code: 'entry-missing', message: err.message, service: service.name });
        reachability.set(service.name, new Set());
      }
    }
  }

  const streams = loadStreams(config, merged);
  const derived = derive({ config, analysis: merged, streams: streams.streams, reachability, allFiles });
  const lints = lint(config, merged, streams.streams, derived.services, derived.analyses);

  const all = [...diagnostics, ...streams.diagnostics, ...derived.diagnostics, ...lints].sort(compareDiagnostics);
  return {
    version: 1,
    generator: GENERATOR,
    streams: streams.streams,
    services: derived.services,
    analyses: derived.analyses,
    diagnostics: all,
  };
}

function mergeAnalyses(list: readonly Analysis[]): Analysis {
  return {
    facts: list.flatMap((a) => a.facts),
    unresolved: list.flatMap((a) => a.unresolved),
    streamsFromCode: list.flatMap((a) => a.streamsFromCode),
    overridesUsed: list.flatMap((a) => a.overridesUsed),
    unusedShapes: list.length === 0 ? [] : list[0]!.unusedShapes.filter((s) => list.every((a) => a.unusedShapes.includes(s))),
    streamAdminCalls: list.flatMap((a) => a.streamAdminCalls),
  };
}

const SEVERITY_RANK = { error: 0, warning: 1, info: 2 } as const;
function compareDiagnostics(a: Diagnostic, b: Diagnostic): number {
  const r = SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity];
  if (r !== 0) return r;
  const fa = a.location?.file ?? '';
  const fb = b.location?.file ?? '';
  if (fa !== fb) return fa < fb ? -1 : 1;
  return (a.location?.line ?? 0) - (b.location?.line ?? 0) || a.message.localeCompare(b.message);
}

export function render(model: Model, config: ResolvedConfig, format: OutputFormat): string {
  switch (format) {
    case 'server':
      return renderServerConf(model, {
        account: config.output.account,
        admin: config.admin,
        passwordEnvOf: (service) => config.services.find((s) => s.name === service)?.passwordEnv ?? `${service.toUpperCase()}_NATS_PASSWORD`,
        nkeyOf: (service) => config.services.find((s) => s.name === service)?.nkey ?? null,
      });
    case 'nsc':
      return renderNsc(model, { account: config.output.account });
    case 'jwt':
      return renderJwtPermissions(model);
    case 'json':
      return renderJson(model, config.rootDir);
    case 'markdown':
      return renderMarkdown(model, config.rootDir);
  }
}

export interface CompileOptions {
  readonly cwd?: string;
  readonly configPath?: string | undefined;
  readonly format?: OutputFormat | undefined;
}

export interface CompileResult {
  readonly config: ResolvedConfig;
  readonly model: Model;
  readonly format: OutputFormat;
  readonly output: string;
}

/** Load config, build the model and render it. Errors in the model are in `model.diagnostics`; rendering still happens. */
export async function compile(options: CompileOptions = {}): Promise<CompileResult> {
  const config = await loadConfig({ cwd: options.cwd ?? process.cwd(), configPath: options.configPath });
  const model = buildModel(config);
  const format = options.format ?? config.output.format;
  return { config, model, format, output: render(model, config, format) };
}

export interface Explanation {
  readonly service: ServicePermissions;
  readonly publish: readonly { readonly grant: string; readonly provenance: readonly Provenance[] }[];
  readonly subscribe: readonly { readonly grant: string; readonly provenance: readonly Provenance[] }[];
}

/** Which grants of `service` admit `subject` (a literal or a pattern), and the code behind each. */
export function explain(model: Model, serviceName: string, subject: string): Explanation | null {
  const service = model.services.find((s) => s.service === serviceName || s.user === serviceName);
  if (!service) return null;
  const admits = (grant: string): boolean => matches(grant, subject) || covers(grant, subject) || covers(subject, grant);
  const collect = (list: 'publish' | 'subscribe', grants: readonly string[]) =>
    grants.filter(admits).map((grant) => ({ grant, provenance: service.provenance[`${list} ${grant}`] ?? [] }));
  return {
    service,
    publish: collect('publish', service.permissions.publishAllow),
    subscribe: collect('subscribe', service.permissions.subscribeAllow),
  };
}
