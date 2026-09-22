import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync, cpSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { diffSummary, main, parseArgs } from '../src/cli.js';
import { fixture } from './helpers.js';

function run(argv: string[], cwd: string): Promise<{ code: number; out: string; err: string }> {
  const previous = process.cwd();
  process.chdir(cwd);
  let out = '';
  let err = '';
  return main(argv, { out: (s) => (out += s), err: (s) => (err += s) })
    .then((code) => ({ code, out, err }))
    .finally(() => process.chdir(previous));
}

describe('cli', () => {
  let work: string;
  beforeAll(() => {
    work = mkdtempSync(resolve(tmpdir(), 'natsacl-'));
    cpSync(fixture('basic'), work, { recursive: true });
  });
  afterAll(() => rmSync(work, { recursive: true, force: true }));

  it('parses flags in both forms', () => {
    const a = parseArgs(['compile', '--config', 'x.json', '--format=nsc', '--stdout', 'extra']);
    expect(a.command).toBe('compile');
    expect(a.flags.get('config')).toBe('x.json');
    expect(a.flags.get('format')).toBe('nsc');
    expect(a.flags.get('stdout')).toBe(true);
    expect(a.positional).toEqual(['extra']);
  });

  it('prints usage without a command and for --help', async () => {
    expect((await run([], work)).code).toBe(2);
    const help = await run(['--help'], work);
    expect(help.code).toBe(0);
    expect(help.out).toContain('natsacl compile');
    expect((await run(['--version'], work)).out.trim()).toMatch(/^\d+\.\d+\.\d+/);
  });

  it('compile writes the configured file and check then passes', async () => {
    const compiled = await run(['compile'], work);
    expect(compiled.code).toBe(0);
    expect(compiled.out).toContain('wrote nats/auth.conf');
    expect(existsSync(resolve(work, 'nats/auth.conf'))).toBe(true);
    const check = await run(['check'], work);
    expect(check.code).toBe(0);
    expect(check.out).toContain('is up to date');
  });

  it('check fails with a diff when the file drifts', async () => {
    const file = resolve(work, 'nats/auth.conf');
    writeFileSync(file, readFileSync(file, 'utf8').replace('"SENSORS.reading"', '"SENSORS.reading"\n            "SENSORS.hacked"'));
    const check = await run(['check'], work);
    expect(check.code).toBe(1);
    expect(check.err).toContain('drift');
    expect(check.err).toContain('-            "SENSORS.hacked"');
    await run(['compile'], work);
  });

  it('check fails when the file is missing', async () => {
    rmSync(resolve(work, 'nats/auth.conf'));
    const check = await run(['check'], work);
    expect(check.code).toBe(1);
    expect(check.err).toContain('does not exist');
  });

  it('compile --stdout with a format prints instead of writing', async () => {
    const r = await run(['compile', '--stdout', '--format', 'jwt'], work);
    expect(r.code).toBe(0);
    expect(JSON.parse(r.out).users).toHaveLength(2);
  });

  it('compile refuses to write when subjects are unresolved', async () => {
    const r = await run(['compile', '--stdout'], fixture('errors'));
    expect(r.code).toBe(1);
    expect(r.err).toContain('3 error(s): nothing written');
    expect(r.out).toBe('');
  });

  it('lint reports counts and honours --strict', async () => {
    const r = await run(['lint'], work);
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/0 error\(s\), \d+ warning\(s\)/);
    expect((await run(['lint', '--strict'], work)).code).toBe(1);
  });

  it('explain traces a grant to its call site', async () => {
    const r = await run(['explain', 'alerts-svc', 'INCIDENTS.opened'], work);
    expect(r.code).toBe(0);
    expect(r.out).toContain('alerts-svc may publish INCIDENTS.opened via "INCIDENTS.opened"');
    expect(r.out).toContain('src/alerts/incidents.ts:');
    expect(r.out).toContain('may NOT subscribe INCIDENTS.opened');
    expect((await run(['explain', 'ghost', 'X'], work)).code).toBe(2);
  });

  it('init writes a starter config once', async () => {
    const dir = resolve(work, 'fresh');
    expect((await run(['init', '--dir', dir], work)).code).toBe(0);
    expect(JSON.parse(readFileSync(resolve(dir, 'natsacl.config.json'), 'utf8')).services).toHaveLength(1);
    expect((await run(['init', '--dir', dir], work)).code).toBe(1);
  });

  it('unknown commands, bad formats and bad configs exit 2', async () => {
    expect((await run(['frobnicate'], work)).code).toBe(2);
    expect((await run(['compile', '--format', 'yaml'], work)).code).toBe(2);
    expect((await run(['compile', '--config', 'missing.json'], work)).code).toBe(2);
  });

  it('diffSummary shows the first divergence', () => {
    expect(diffSummary('a\nb\nc\n', 'a\nB\nc\n')).toBe('--- on disk (4 lines)\n+++ from code (4 lines)\n@@ line 2 @@\n-b\n+B\n');
  });
});
