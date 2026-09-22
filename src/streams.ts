import { readFileSync } from 'node:fs';
import type { Analysis } from './analyze.js';
import type { ResolvedConfig } from './config.js';
import type { Diagnostic, StreamDef } from './model.js';
import { isValidPattern } from './subjects.js';

/**
 * Provisioned JetStream streams — the second source of truth the ACL is
 * checked against. A consumer whose filter subject no stream carries is
 * rejected by the server at creation time, typically inside a caught
 * handler, so a healthy-looking service ends up with a dead subscriber.
 */
export function loadStreams(config: ResolvedConfig, analysis: Analysis): { readonly streams: readonly StreamDef[]; readonly diagnostics: readonly Diagnostic[] } {
  const spec = config.streams;
  if (spec === null) return { streams: [], diagnostics: [] };
  if (spec === 'from-code') return normalize(analysis.streamsFromCode, 'code');
  if (Array.isArray(spec)) return normalize(spec.map((s) => ({ ...s, source: s.source || 'config' })), 'config');
  const file = (spec as { file: string }).file;
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(file, 'utf8'));
  } catch (err) {
    return { streams: [], diagnostics: [{ severity: 'error', code: 'invalid-subject', message: `streams file ${file}: ${err instanceof Error ? err.message : String(err)}` }] };
  }
  return normalize(parseStreamsDocument(parsed, file), file);
}

/**
 * Accepts the shapes people already have on disk:
 *   [{ name, subjects }]                       — hand-written
 *   { streams: [{ name, subjects }] }
 *   [{ config: { name, subjects } }]           — `nats stream info -j`, one per element
 *   { streams: [{ config: { … } }] }           — `$JS.API.STREAM.LIST` response
 */
export function parseStreamsDocument(doc: unknown, source: string): StreamDef[] {
  const list: unknown[] = Array.isArray(doc) ? doc : doc && typeof doc === 'object' && Array.isArray((doc as { streams?: unknown }).streams) ? ((doc as { streams: unknown[] }).streams) : [];
  const out: StreamDef[] = [];
  for (const item of list) {
    if (!item || typeof item !== 'object') continue;
    const record = item as { name?: unknown; subjects?: unknown; config?: { name?: unknown; subjects?: unknown } };
    const name = typeof record.name === 'string' ? record.name : typeof record.config?.name === 'string' ? record.config.name : null;
    const subjects = Array.isArray(record.subjects) ? record.subjects : Array.isArray(record.config?.subjects) ? record.config.subjects : null;
    if (!name || !subjects) continue;
    out.push({ name, subjects: subjects.filter((s): s is string => typeof s === 'string'), source });
  }
  return out;
}

function normalize(streams: readonly StreamDef[], where: string): { readonly streams: readonly StreamDef[]; readonly diagnostics: readonly Diagnostic[] } {
  const diagnostics: Diagnostic[] = [];
  const byName = new Map<string, { subjects: Set<string>; source: string }>();
  for (const s of streams) {
    if (!s.name || /[\s.*>]/.test(s.name)) {
      diagnostics.push({ severity: 'error', code: 'invalid-subject', message: `${where}: invalid stream name "${s.name}"` });
      continue;
    }
    const entry = byName.get(s.name) ?? { subjects: new Set<string>(), source: s.source };
    for (const subject of s.subjects) {
      if (!isValidPattern(subject)) {
        diagnostics.push({ severity: 'error', code: 'invalid-subject', message: `${where}: stream ${s.name} has an invalid subject "${subject}"` });
        continue;
      }
      entry.subjects.add(subject);
    }
    byName.set(s.name, entry);
  }
  const normalized: StreamDef[] = [...byName.entries()]
    .map(([name, e]) => ({ name, subjects: [...e.subjects].sort(), source: e.source }))
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return { streams: normalized, diagnostics };
}
