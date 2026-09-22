/**
 * NATS subject algebra.
 *
 * A subject is a dot-separated list of tokens. In a permission pattern (and a
 * subscription) two wildcards exist: `*` matches exactly one token, `>` matches
 * one or more tokens and may only appear as the last token. Wildcards are
 * whole tokens — `DEVICE-*` is a literal, not a wildcard — which is why a
 * dynamic fragment inside a token cannot be expressed as a permission at all.
 */

const FORBIDDEN = /[\s\u0000]/;

export function tokensOf(subject: string): string[] {
  return subject.split('.');
}

/** A syntactically valid subject or pattern: non-empty tokens, `>` only last, no whitespace. */
export function isValidPattern(pattern: string): boolean {
  if (pattern.length === 0 || FORBIDDEN.test(pattern)) return false;
  const tokens = tokensOf(pattern);
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i]!;
    if (token.length === 0) return false;
    if (token === '>' && i !== tokens.length - 1) return false;
  }
  return true;
}

/** A valid pattern without wildcards. */
export function isLiteralSubject(subject: string): boolean {
  return isValidPattern(subject) && !hasWildcards(subject);
}

export function hasWildcards(pattern: string): boolean {
  return tokensOf(pattern).some((t) => t === '*' || t === '>');
}

/** Does `pattern` match the literal `subject` under NATS rules? */
export function matches(pattern: string, subject: string): boolean {
  const p = tokensOf(pattern);
  const s = tokensOf(subject);
  let i = 0;
  for (; i < p.length; i++) {
    const pt = p[i]!;
    if (pt === '>') return s.length > i;
    if (i >= s.length) return false;
    if (pt !== '*' && pt !== s[i]) return false;
  }
  return i === s.length;
}

/**
 * Does `broad` match every subject that `narrow` matches?
 *
 * This is the relation behind two decisions: a consumer filter is only usable
 * when some stream subject covers it, and an allow list can drop any entry
 * another entry covers.
 */
export function covers(broad: string, narrow: string): boolean {
  const b = tokensOf(broad);
  const n = tokensOf(narrow);
  let i = 0;
  for (; i < b.length; i++) {
    const bt = b[i]!;
    if (bt === '>') return n.length > i;
    if (i >= n.length) return false;
    const nt = n[i]!;
    if (nt === '>') return false;
    if (bt === '*') continue;
    if (bt !== nt) return false;
  }
  return i === n.length;
}

/** Is there at least one literal subject that both patterns match? */
export function overlaps(a: string, b: string): boolean {
  const x = tokensOf(a);
  const y = tokensOf(b);
  const len = Math.max(x.length, y.length);
  for (let i = 0; i < len; i++) {
    const xt = x[i];
    const yt = y[i];
    if (xt === '>') return y.length > i;
    if (yt === '>') return x.length > i;
    if (xt === undefined || yt === undefined) return false;
    if (xt === '*' || yt === '*') continue;
    if (xt !== yt) return false;
  }
  return true;
}

export function firstToken(pattern: string): string {
  return tokensOf(pattern)[0]!;
}

/** Deterministic order: `$JS` and `$SYS` system subjects first, then `_INBOX`, then the rest. */
export function compareSubjects(a: string, b: string): number {
  const rank = (s: string): number => (s.startsWith('$') ? 0 : s.startsWith('_') ? 1 : 2);
  const ra = rank(a);
  const rb = rank(b);
  if (ra !== rb) return ra - rb;
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Dedupe, drop every pattern another pattern covers, sort. */
export function minimize(patterns: Iterable<string>): string[] {
  const unique = [...new Set(patterns)];
  const kept = unique.filter((p) => !unique.some((q) => q !== p && covers(q, p)));
  return kept.sort(compareSubjects);
}

/**
 * Split a subject into the literal head (tokens before the first wildcard)
 * — useful for reporting which prefix a grant belongs to.
 */
export function literalPrefix(pattern: string): string {
  const out: string[] = [];
  for (const t of tokensOf(pattern)) {
    if (t === '*' || t === '>') break;
    out.push(t);
  }
  return out.join('.');
}
