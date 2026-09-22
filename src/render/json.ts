import { relative, sep } from 'node:path';
import type { Location, Model, Provenance } from '../model.js';

/**
 * The full model as stable JSON: grants with provenance, per-service facts,
 * streams and diagnostics. Paths are made relative to the project root so the
 * file is identical on every machine, which is what lets `natsacl check` diff it.
 */
export function renderJson(model: Model, rootDir: string): string {
  return JSON.stringify(relativize(model, rootDir), null, 2) + '\n';
}

export function relativize(model: Model, rootDir: string): Model {
  const rel = (loc: Location): Location => ({ ...loc, file: toPosix(relative(rootDir, loc.file)) || loc.file });
  const prov = (p: Provenance): Provenance => ({ ...p, location: rel(p.location), via: p.via.map(rel) });
  const relSource = (source: string): string => (source.startsWith(rootDir) ? toPosix(relative(rootDir, source.split(':')[0]!)) + source.slice(source.split(':')[0]!.length) : source);
  return {
    ...model,
    streams: model.streams.map((s) => ({ ...s, source: relSource(s.source) })),
    services: model.services.map((s) => ({
      ...s,
      provenance: Object.fromEntries(Object.entries(s.provenance).map(([k, v]) => [k, v.map(prov)])),
    })),
    analyses: model.analyses.map((a) => ({
      ...a,
      files: a.files.map((f) => toPosix(relative(rootDir, f))),
      facts: a.facts.map((f) => ({ ...f, location: rel(f.location), via: f.via.map(rel), requires: f.requires.map((r) => toPosix(relative(rootDir, r))) })),
      unresolved: a.unresolved.map((u) => ({ ...u, location: rel(u.location) })),
    })),
    diagnostics: model.diagnostics.map((d) => (d.location ? { ...d, location: rel(d.location) } : d)),
  };
}

function toPosix(p: string): string {
  return sep === '/' ? p : p.split(sep).join('/');
}
