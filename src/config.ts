import { existsSync, readFileSync } from 'node:fs';
import { dirname, isAbsolute, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { FactKind, StreamDef } from './model.js';
import { isValidPattern } from './subjects.js';

/** Where inside a call's arguments a value lives: an argument index, or a dotted path into an object-literal argument. */
export type ArgRef = number | { readonly arg: number; readonly path: string };

export type OutputFormat = 'server' | 'nsc' | 'jwt' | 'json' | 'markdown';
export const OUTPUT_FORMATS: readonly OutputFormat[] = ['server', 'nsc', 'jwt', 'json', 'markdown'];

/**
 * A call shape the analyser recognises as a broker operation.
 *
 * `callee` is the property or function name at the call site. `receiverTypes`
 * are the symbol names the receiver's type must be, or extend, or implement
 * (`NatsConnection`, `JetStreamClient`, …); an empty list matches a free
 * function of that name. Wrappers your own code defines are declared the same
 * way, or in place with a `@natsacl` JSDoc tag on the declaration.
 */
export interface ShapeSpec {
  readonly kind: FactKind;
  readonly callee: string;
  readonly receiverTypes?: readonly string[];
  readonly subject?: ArgRef;
  readonly stream?: ArgRef;
  readonly durable?: ArgRef;
  readonly mode?: 'pull' | 'push';
  /**
   * For a `js-subscribe` wrapper that is a core subscription when the call names no durable
   * (no options argument, or no such property): treat those calls as `subscribe`.
   */
  readonly whenNoDurable?: 'subscribe';
  /** Free text for diagnostics. */
  readonly note?: string;
}

export interface ServiceSpec {
  readonly name: string;
  /** Broker user name; defaults to `userTemplate` applied to `name`. */
  readonly user?: string;
  /** Environment variable holding the password; defaults to `passwordEnvTemplate` applied to `name`. */
  readonly passwordEnv?: string;
  /** Public NKey (`U…`) for an nkey user; the server config then carries no password reference. */
  readonly nkey?: string;
  /** Entry file(s); every file reachable through imports from here belongs to the service. */
  readonly entry: string | readonly string[];
  /** A service-specific tsconfig; defaults to the top-level one. */
  readonly tsconfig?: string;
  readonly inboxPrefix?: string;
  readonly extraPublish?: readonly string[];
  readonly extraSubscribe?: readonly string[];
  readonly denyPublish?: readonly string[];
  readonly denySubscribe?: readonly string[];
}

export interface OverrideSpec {
  readonly file: string;
  readonly line: number;
  readonly subject: string | readonly string[];
}

export type StreamsSpec = readonly StreamDef[] | { readonly file: string } | 'from-code';

export interface Config {
  readonly tsconfig?: string;
  readonly services?: readonly ServiceSpec[];
  /** `${service}` and `${SERVICE}` expand to the service name (as-is / upper snake). */
  readonly userTemplate?: string;
  readonly passwordEnvTemplate?: string;
  readonly shapes?: {
    readonly extend?: readonly ShapeSpec[];
    /** Replace the built-in table entirely. */
    readonly replace?: readonly ShapeSpec[];
  };
  readonly jetstream?: {
    /** `modern` targets nats-server ≥ 2.9 (`CONSUMER.CREATE.<stream>.<name>.<filter>`); `legacy` adds the `DURABLE.CREATE` form. */
    readonly api?: 'modern' | 'legacy';
    /** Grant consumer INFO/NEXT/ACK per resolved durable (`auto`), or always per stream with `*`. */
    readonly consumerScoping?: 'auto' | 'wildcard';
    readonly allowConsumerDelete?: boolean | 'auto';
  };
  readonly streams?: StreamsSpec;
  readonly inboxPrefix?: string;
  readonly widenPartialTokens?: boolean;
  readonly overrides?: readonly OverrideSpec[];
  /** Subjects handled by code outside this program, so dead-subject lint does not flag them. */
  readonly external?: { readonly publishers?: readonly string[]; readonly subscribers?: readonly string[] };
  readonly admin?: { readonly user: string; readonly passwordEnv?: string } | false;
  readonly output?: {
    readonly format?: OutputFormat;
    readonly file?: string;
    readonly account?: string;
  };
  readonly lint?: {
    readonly deadSubjects?: 'error' | 'warning' | 'off';
    readonly overBroad?: 'error' | 'warning' | 'off';
  };
  readonly maxExpansions?: number;
  readonly maxDepth?: number;
  /**
   * Build-time policy: a grant the code implies but policy forbids fails `compile` with the call
   * sites, instead of being denied silently at runtime.
   */
  readonly policy?: {
    readonly forbid?: readonly PolicyRule[];
  };
}

export interface PolicyRule {
  /** A subject pattern; any fact overlapping it is a violation. */
  readonly subject: string;
  /** Apply to publishing (publish, request, JetStream publish). Default true. */
  readonly publish?: boolean;
  /** Apply to consuming (subscribe, JetStream consumers, service endpoints). Default true. */
  readonly subscribe?: boolean;
  /** Services allowed to touch the subject anyway. */
  readonly except?: readonly string[];
  /** Shown in the diagnostic. */
  readonly reason?: string;
}

export interface ResolvedPolicyRule {
  readonly subject: string;
  readonly publish: boolean;
  readonly subscribe: boolean;
  readonly except: readonly string[];
  readonly reason: string | null;
}

export interface ResolvedService {
  readonly name: string;
  readonly user: string;
  readonly passwordEnv: string;
  readonly nkey: string | null;
  readonly entries: readonly string[];
  readonly tsconfig: string;
  readonly inboxPrefix: string;
  readonly extraPublish: readonly string[];
  readonly extraSubscribe: readonly string[];
  readonly denyPublish: readonly string[];
  readonly denySubscribe: readonly string[];
}

export interface ResolvedConfig {
  readonly rootDir: string;
  readonly configFile: string | null;
  readonly tsconfig: string;
  readonly services: readonly ResolvedService[];
  readonly singleService: boolean;
  readonly shapes: readonly ShapeSpec[];
  /** True when `shapes.replace` was given: the built-in table is not used. */
  readonly replaceDefaultShapes: boolean;
  readonly jetstream: { readonly api: 'modern' | 'legacy'; readonly consumerScoping: 'auto' | 'wildcard'; readonly allowConsumerDelete: boolean | 'auto' };
  readonly streams: StreamsSpec | null;
  readonly inboxPrefix: string;
  readonly widenPartialTokens: boolean;
  readonly overrides: readonly OverrideSpec[];
  readonly external: { readonly publishers: readonly string[]; readonly subscribers: readonly string[] };
  readonly admin: { readonly user: string; readonly passwordEnv: string } | null;
  readonly output: { readonly format: OutputFormat; readonly file: string | null; readonly account: string | null };
  readonly lint: { readonly deadSubjects: 'error' | 'warning' | 'off'; readonly overBroad: 'error' | 'warning' | 'off' };
  readonly maxExpansions: number;
  readonly maxDepth: number;
  readonly policy: { readonly forbid: readonly ResolvedPolicyRule[] };
}

export class ConfigError extends Error {
  override name = 'ConfigError';
}

/** Identity helper so a JS config file gets editor completion. */
export function defineConfig(config: Config): Config {
  return config;
}

export const CONFIG_FILE_NAMES = ['natsacl.config.json', 'natsacl.config.js', 'natsacl.config.mjs', 'natsacl.config.cjs'];

export function findConfigFile(dir: string): string | null {
  for (const name of CONFIG_FILE_NAMES) {
    const candidate = resolve(dir, name);
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

export async function loadConfigFile(file: string): Promise<Config> {
  if (file.endsWith('.json')) {
    try {
      return JSON.parse(readFileSync(file, 'utf8')) as Config;
    } catch (err) {
      throw new ConfigError(`${file}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  const mod = (await import(pathToFileURL(file).href)) as { default?: Config; config?: Config };
  const config = mod.default ?? mod.config;
  if (!config || typeof config !== 'object') throw new ConfigError(`${file}: expected a default export (use defineConfig)`);
  return config;
}

const upperSnake = (s: string): string => s.replace(/[^A-Za-z0-9]+/g, '_').toUpperCase();

function expand(template: string, service: string): string {
  return template.replaceAll('${service}', service).replaceAll('${SERVICE}', upperSnake(service));
}

function assertStringArray(value: unknown, what: string): readonly string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.some((v) => typeof v !== 'string')) throw new ConfigError(`${what} must be an array of strings`);
  return value as string[];
}

export function resolveConfig(raw: Config, options: { readonly rootDir: string; readonly configFile?: string | null }): ResolvedConfig {
  const rootDir = options.rootDir;
  const abs = (p: string): string => (isAbsolute(p) ? p : resolve(rootDir, p));
  const tsconfig = abs(raw.tsconfig ?? 'tsconfig.json');
  if (!existsSync(tsconfig)) throw new ConfigError(`tsconfig not found: ${tsconfig}`);

  const userTemplate = raw.userTemplate ?? '${service}';
  const passwordEnvTemplate = raw.passwordEnvTemplate ?? '${SERVICE}_NATS_PASSWORD';
  const inboxPrefix = raw.inboxPrefix ?? '_INBOX';

  const seen = new Set<string>();
  const services: ResolvedService[] = (raw.services ?? []).map((s, i) => {
    if (!s || typeof s.name !== 'string' || s.name.length === 0) throw new ConfigError(`services[${i}].name is required`);
    if (seen.has(s.name)) throw new ConfigError(`services: duplicate name "${s.name}"`);
    seen.add(s.name);
    const entries = (typeof s.entry === 'string' ? [s.entry] : [...(s.entry ?? [])]).map(abs);
    if (entries.length === 0) throw new ConfigError(`services[${s.name}].entry is required`);
    if (s.nkey !== undefined && !/^U[A-Z2-7]{55}$/.test(s.nkey)) throw new ConfigError(`services[${s.name}].nkey must be a public user nkey (U…, 56 characters)`);
    return {
      name: s.name,
      user: s.user ?? expand(userTemplate, s.name),
      passwordEnv: s.passwordEnv ?? expand(passwordEnvTemplate, s.name),
      nkey: s.nkey ?? null,
      entries,
      tsconfig: s.tsconfig ? abs(s.tsconfig) : tsconfig,
      inboxPrefix: expand(s.inboxPrefix ?? inboxPrefix, s.name),
      extraPublish: assertStringArray(s.extraPublish, `services[${s.name}].extraPublish`),
      extraSubscribe: assertStringArray(s.extraSubscribe, `services[${s.name}].extraSubscribe`),
      denyPublish: assertStringArray(s.denyPublish, `services[${s.name}].denyPublish`),
      denySubscribe: assertStringArray(s.denySubscribe, `services[${s.name}].denySubscribe`),
    };
  });

  const singleService = services.length === 0;
  if (singleService) {
    const name = packageName(rootDir) ?? 'app';
    services.push({
      name,
      user: expand(userTemplate, name),
      passwordEnv: expand(passwordEnvTemplate, name),
      nkey: null,
      entries: [],
      tsconfig,
      inboxPrefix: expand(inboxPrefix, name),
      extraPublish: [],
      extraSubscribe: [],
      denyPublish: [],
      denySubscribe: [],
    });
  }

  for (const shape of [...(raw.shapes?.extend ?? []), ...(raw.shapes?.replace ?? [])]) {
    if (typeof shape.callee !== 'string' || !shape.kind) throw new ConfigError(`shapes: each entry needs "kind" and "callee" (got ${JSON.stringify(shape)})`);
  }

  let streams: StreamsSpec | null = null;
  if (raw.streams === 'from-code') streams = 'from-code';
  else if (Array.isArray(raw.streams)) streams = raw.streams;
  else if (raw.streams && typeof raw.streams === 'object' && 'file' in raw.streams) streams = { file: abs(raw.streams.file) };
  else if (raw.streams !== undefined) throw new ConfigError('streams must be an array, { file }, or "from-code"');

  const overrides = (raw.overrides ?? []).map((o) => {
    if (typeof o.file !== 'string' || typeof o.line !== 'number' || !o.subject) throw new ConfigError('overrides: each entry needs file, line and subject');
    return { file: abs(o.file), line: o.line, subject: o.subject };
  });

  const knownServices = new Set(services.map((s) => s.name));
  const forbid: ResolvedPolicyRule[] = (raw.policy?.forbid ?? []).map((rule, i) => {
    if (!rule || typeof rule.subject !== 'string' || !isValidPattern(rule.subject)) throw new ConfigError(`policy.forbid[${i}].subject must be a valid NATS subject pattern`);
    for (const name of rule.except ?? []) {
      if (!knownServices.has(name)) throw new ConfigError(`policy.forbid[${i}].except names unknown service "${name}" (services: ${[...knownServices].join(', ')})`);
    }
    return { subject: rule.subject, publish: rule.publish ?? true, subscribe: rule.subscribe ?? true, except: [...(rule.except ?? [])], reason: rule.reason ?? null };
  });

  return {
    rootDir,
    configFile: options.configFile ?? null,
    tsconfig,
    services,
    singleService,
    shapes: raw.shapes?.replace ?? [...(raw.shapes?.extend ?? [])],
    replaceDefaultShapes: raw.shapes?.replace !== undefined,
    jetstream: {
      api: raw.jetstream?.api ?? 'modern',
      consumerScoping: raw.jetstream?.consumerScoping ?? 'auto',
      allowConsumerDelete: raw.jetstream?.allowConsumerDelete ?? 'auto',
    },
    streams,
    inboxPrefix,
    widenPartialTokens: raw.widenPartialTokens ?? false,
    overrides,
    external: {
      publishers: assertStringArray(raw.external?.publishers, 'external.publishers'),
      subscribers: assertStringArray(raw.external?.subscribers, 'external.subscribers'),
    },
    admin: raw.admin ? { user: raw.admin.user, passwordEnv: raw.admin.passwordEnv ?? expand(passwordEnvTemplate, raw.admin.user) } : null,
    output: {
      format: raw.output?.format ?? 'server',
      file: raw.output?.file ? abs(raw.output.file) : null,
      account: raw.output?.account ?? null,
    },
    lint: {
      deadSubjects: raw.lint?.deadSubjects ?? 'warning',
      overBroad: raw.lint?.overBroad ?? 'warning',
    },
    maxExpansions: raw.maxExpansions ?? 256,
    maxDepth: raw.maxDepth ?? 8,
    policy: { forbid },
  };
}

function packageName(dir: string): string | null {
  const file = resolve(dir, 'package.json');
  if (!existsSync(file)) return null;
  try {
    const name = (JSON.parse(readFileSync(file, 'utf8')) as { name?: unknown }).name;
    return typeof name === 'string' ? name.replace(/^@[^/]+\//, '') : null;
  } catch {
    return null;
  }
}

/** Load + resolve: `--config` path, or the nearest config file, or defaults. */
export async function loadConfig(options: { readonly cwd: string; readonly configPath?: string | undefined }): Promise<ResolvedConfig> {
  const file = options.configPath ? resolve(options.cwd, options.configPath) : findConfigFile(options.cwd);
  if (options.configPath && !existsSync(file!)) throw new ConfigError(`config file not found: ${file}`);
  const raw = file ? await loadConfigFile(file) : {};
  return resolveConfig(raw, { rootDir: file ? dirname(file) : options.cwd, configFile: file });
}
