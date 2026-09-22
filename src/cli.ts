import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import { ConfigError, OUTPUT_FORMATS, type OutputFormat } from './config.js';
import { buildModel, compile, explain, GENERATOR, loadConfig, render, VERSION } from './index.js';
import { hasErrors, type Diagnostic, type Model } from './model.js';
import { ProgramError } from './program.js';
import { formatDiagnostic } from './render/markdown.js';

const USAGE = `${GENERATOR} — least-privilege NATS permissions compiled from TypeScript

Usage:
  natsacl compile [--config <file>] [--format <fmt>] [--out <file>] [--stdout] [--quiet]
  natsacl check   [--config <file>] [--format <fmt>] [--out <file>]
  natsacl lint    [--config <file>] [--strict]
  (--annotations / --no-annotations: GitHub Actions workflow commands; on by default under Actions)
  natsacl explain <service> <subject> [--config <file>]
  natsacl init    [--dir <path>]

Formats: ${OUTPUT_FORMATS.join(', ')} (default: config output.format, else server)

Exit codes: 0 ok · 1 errors, drift or (with --strict) warnings · 2 usage or config error
`;

interface Args {
  readonly command: string | undefined;
  readonly positional: readonly string[];
  readonly flags: ReadonlyMap<string, string | true>;
}

export function parseArgs(argv: readonly string[]): Args {
  const flags = new Map<string, string | true>();
  const positional: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg.startsWith('--')) {
      const eq = arg.indexOf('=');
      if (eq > 0) {
        flags.set(arg.slice(2, eq), arg.slice(eq + 1));
        continue;
      }
      const key = arg.slice(2);
      const next = argv[i + 1];
      if (BOOLEAN_FLAGS.has(key) || next === undefined || next.startsWith('--')) flags.set(key, true);
      else {
        flags.set(key, next);
        i++;
      }
      continue;
    }
    positional.push(arg);
  }
  return { command: positional[0], positional: positional.slice(1), flags };
}

const BOOLEAN_FLAGS = new Set(['stdout', 'strict', 'quiet', 'help', 'version', 'annotations', 'no-annotations']);

/** Annotations are on under GitHub Actions unless `--no-annotations`; `--annotations` forces them elsewhere. */
function wantAnnotations(args: Args): boolean {
  if (args.flags.has('no-annotations')) return false;
  return args.flags.has('annotations') || process.env.GITHUB_ACTIONS === 'true';
}

export async function main(argv: readonly string[], io: { out: (s: string) => void; err: (s: string) => void } = { out: (s) => process.stdout.write(s), err: (s) => process.stderr.write(s) }): Promise<number> {
  const args = parseArgs(argv);
  if (args.flags.has('version')) {
    io.out(`${VERSION}\n`);
    return 0;
  }
  if (args.flags.has('help') || args.command === 'help') {
    io.out(USAGE);
    return 0;
  }
  if (!args.command) {
    io.out(USAGE);
    return 2;
  }
  const configPath = str(args.flags.get('config'));
  const cwd = process.cwd();
  try {
    switch (args.command) {
      case 'compile':
        return await runCompile(args, cwd, configPath, io, false);
      case 'check':
        return await runCompile(args, cwd, configPath, io, true);
      case 'lint':
        return await runLint(args, cwd, configPath, io);
      case 'explain':
        return await runExplain(args, cwd, configPath, io);
      case 'init':
        return runInit(args, cwd, io);
      default:
        io.err(`unknown command "${args.command}"\n\n${USAGE}`);
        return 2;
    }
  } catch (err) {
    if (err instanceof ConfigError || err instanceof ProgramError) {
      io.err(`${err.name}: ${err.message}\n`);
      return 2;
    }
    throw err;
  }
}

async function runCompile(args: Args, cwd: string, configPath: string | undefined, io: { out: (s: string) => void; err: (s: string) => void }, check: boolean): Promise<number> {
  const format = parseFormat(args.flags.get('format'));
  const result = await compile({ cwd, configPath, format });
  const { model, config } = result;
  printDiagnostics(model, config.rootDir, io, args.flags.has('quiet'), wantAnnotations(args));
  if (hasErrors(model.diagnostics)) {
    io.err(`\n${countErrors(model)} error(s): nothing written. Fix the unresolved subjects above or declare them (README → Overrides).\n`);
    return 1;
  }
  const outFile = str(args.flags.get('out')) ? resolve(cwd, str(args.flags.get('out'))!) : config.output.file;
  if (check) {
    if (!outFile) {
      io.err('check needs an output file: pass --out or set output.file in the config\n');
      return 2;
    }
    if (!existsSync(outFile)) {
      io.err(`drift: ${relative(cwd, outFile)} does not exist — run \`natsacl compile\`\n`);
      return 1;
    }
    const current = readFileSync(outFile, 'utf8');
    if (current === result.output) {
      io.out(`${relative(cwd, outFile)} is up to date (${model.services.length} user(s)).\n`);
      return 0;
    }
    io.err(`drift: ${relative(cwd, outFile)} differs from what the code implies — run \`natsacl compile\`\n`);
    io.err(diffSummary(current, result.output));
    return 1;
  }
  if (args.flags.has('stdout') || !outFile) {
    io.out(result.output);
    return 0;
  }
  mkdirSync(dirname(outFile), { recursive: true });
  writeFileSync(outFile, result.output);
  io.out(`wrote ${relative(cwd, outFile)} (${result.format}, ${model.services.length} user(s))\n`);
  return 0;
}

async function runLint(args: Args, cwd: string, configPath: string | undefined, io: { out: (s: string) => void; err: (s: string) => void }): Promise<number> {
  const config = await loadConfig({ cwd, configPath });
  const model = buildModel(config);
  printDiagnostics(model, config.rootDir, io, false, wantAnnotations(args));
  const errors = countErrors(model);
  const warnings = model.diagnostics.filter((d) => d.severity === 'warning').length;
  io.out(`${errors} error(s), ${warnings} warning(s), ${model.diagnostics.length - errors - warnings} note(s)\n`);
  if (errors > 0) return 1;
  if (args.flags.has('strict') && warnings > 0) return 1;
  return 0;
}

async function runExplain(args: Args, cwd: string, configPath: string | undefined, io: { out: (s: string) => void; err: (s: string) => void }): Promise<number> {
  const [service, subject] = args.positional;
  if (!service || !subject) {
    io.err('usage: natsacl explain <service> <subject>\n');
    return 2;
  }
  const config = await loadConfig({ cwd, configPath });
  const model = buildModel(config);
  const explanation = explain(model, service, subject);
  if (!explanation) {
    io.err(`no service or user named "${service}" (services: ${model.services.map((s) => s.service).join(', ')})\n`);
    return 2;
  }
  const rel = (file: string): string => relative(config.rootDir, file) || file;
  for (const [list, grants] of [
    ['publish', explanation.publish],
    ['subscribe', explanation.subscribe],
  ] as const) {
    if (grants.length === 0) {
      io.out(`${explanation.service.user} may NOT ${list} ${subject}\n`);
      continue;
    }
    for (const g of grants) {
      io.out(`${explanation.service.user} may ${list} ${subject} via "${g.grant}"\n`);
      if (g.provenance.length === 0) io.out(`  (implied by JetStream use)\n`);
      for (const p of g.provenance) {
        io.out(`  ${p.kind} "${p.subject}" at ${rel(p.location.file)}:${p.location.line}:${p.location.col} [${p.origin}]\n`);
        for (const v of p.via) io.out(`    via ${rel(v.file)}:${v.line}:${v.col}\n`);
      }
    }
  }
  return 0;
}

function runInit(args: Args, cwd: string, io: { out: (s: string) => void; err: (s: string) => void }): number {
  const dir = resolve(cwd, str(args.flags.get('dir')) ?? '.');
  const file = resolve(dir, 'natsacl.config.json');
  if (existsSync(file)) {
    io.err(`${relative(cwd, file)} already exists\n`);
    return 1;
  }
  const template = {
    $schema: 'https://raw.githubusercontent.com/devjoinedthechat/natsacl/main/schema/natsacl.config.schema.json',
    tsconfig: 'tsconfig.json',
    services: [{ name: 'app', entry: 'src/main.ts' }],
    streams: [{ name: 'TELEMETRY', subjects: ['TELEMETRY.>'] }],
    output: { format: 'server', file: 'nats/auth.conf' },
  };
  mkdirSync(dir, { recursive: true });
  writeFileSync(file, JSON.stringify(template, null, 2) + '\n');
  io.out(`wrote ${relative(cwd, file)} — edit services/streams, then run \`natsacl compile\`\n`);
  return 0;
}

function printDiagnostics(model: Model, rootDir: string, io: { out: (s: string) => void; err: (s: string) => void }, quiet: boolean, annotations: boolean): void {
  for (const d of model.diagnostics) {
    if (quiet && d.severity !== 'error') continue;
    io.err(formatDiagnostic(d, rootDir) + '\n');
    if (annotations) io.out(githubAnnotation(d, process.cwd()) + '\n');
  }
}

/** A GitHub Actions workflow command, so the diagnostic lands on the pull request diff. */
export function githubAnnotation(d: Diagnostic, cwd: string): string {
  const level = d.severity === 'error' ? 'error' : d.severity === 'warning' ? 'warning' : 'notice';
  const where = d.location ? `file=${relative(cwd, d.location.file).split('\\').join('/')},line=${d.location.line},col=${d.location.col},` : '';
  const escape = (s: string): string => s.replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A');
  const title = escape(`natsacl ${d.code}${d.service ? ` [${d.service}]` : ''}`).replace(/,/g, '%2C').replace(/:/g, '%3A');
  return `::${level} ${where}title=${title}::${escape(d.message)}`;
}

function countErrors(model: Model): number {
  return model.diagnostics.filter((d: Diagnostic) => d.severity === 'error').length;
}

function parseFormat(value: string | true | undefined): OutputFormat | undefined {
  if (value === undefined || value === true) return undefined;
  if ((OUTPUT_FORMATS as readonly string[]).includes(value)) return value as OutputFormat;
  throw new ConfigError(`unknown format "${value}" (expected ${OUTPUT_FORMATS.join(', ')})`);
}

function str(value: string | true | undefined): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

/** First divergence with a little context on each side — enough to see what moved without a diff library. */
export function diffSummary(current: string, expected: string): string {
  const a = current.split('\n');
  const b = expected.split('\n');
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length - 1;
  let endB = b.length - 1;
  while (endA >= start && endB >= start && a[endA] === b[endB]) {
    endA--;
    endB--;
  }
  const lines: string[] = [];
  lines.push(`--- on disk (${a.length} lines)`);
  lines.push(`+++ from code (${b.length} lines)`);
  lines.push(`@@ line ${start + 1} @@`);
  for (const line of a.slice(start, Math.min(endA + 1, start + 20))) lines.push(`-${line}`);
  if (endA + 1 - start > 20) lines.push(`… ${endA + 1 - start - 20} more removed line(s)`);
  for (const line of b.slice(start, Math.min(endB + 1, start + 20))) lines.push(`+${line}`);
  if (endB + 1 - start > 20) lines.push(`… ${endB + 1 - start - 20} more added line(s)`);
  return lines.join('\n') + '\n';
}
