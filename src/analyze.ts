import ts from 'typescript';
import type { ArgRef, ResolvedConfig, ShapeSpec } from './config.js';
import { Evaluator, unwrap, type EvaluateOptions } from './evaluate.js';
import type { Location, StreamDef, SubjectFact, Unresolved } from './model.js';
import { locationOf, symbolOf, typeNames, type ProgramContext } from './program.js';
import { SERVICE_PLACEHOLDER } from './evaluate.js';
import { DEFAULT_SHAPES } from './shapes.js';
import { isValidPattern } from './subjects.js';

/** Facts with no subject of their own (`msg.respond()`, `consumers.get(stream, name)`). */
export const NO_SUBJECT = '';

export interface Analysis {
  readonly facts: readonly SubjectFact[];
  readonly unresolved: readonly Unresolved[];
  /** Stream definitions found in `jsm.streams.add/update` calls. */
  readonly streamsFromCode: readonly StreamDef[];
  /** Call sites whose subject came from an override rather than the code. */
  readonly overridesUsed: readonly { readonly location: Location; readonly patterns: readonly string[] }[];
  /** User-declared shapes that matched nothing. */
  readonly unusedShapes: readonly ShapeSpec[];
  /** Calls to stream-admin APIs, per file, for the lint. */
  readonly streamAdminCalls: readonly Location[];
  /** KV opens that may create the bucket (no `bindOnly`, or `Kvm.create`). */
  readonly kvCreateCalls: readonly { readonly location: Location; readonly bucket: string }[];
}

const INLINE_OVERRIDE = /natsacl-subject:\s*([^\n*]+)/;

export function analyze(ctx: ProgramContext, config: ResolvedConfig): Analysis {
  const shapes = config.replaceDefaultShapes ? config.shapes : [...DEFAULT_SHAPES, ...config.shapes];
  const evalOptions: EvaluateOptions = {
    maxExpansions: config.maxExpansions,
    maxDepth: config.maxDepth,
    widenPartialTokens: config.widenPartialTokens,
    dynamicTail: 'single',
  };
  const evaluator = new Evaluator(ctx, evalOptions);
  const overrides = new Map<string, readonly string[]>();
  for (const o of config.overrides) overrides.set(`${o.file}:${o.line}`, typeof o.subject === 'string' ? [o.subject] : o.subject);

  const product = new Set(ctx.sourceFiles.map((sf) => sf.fileName));
  const facts: SubjectFact[] = [];
  const unresolved: Unresolved[] = [];
  const streamsFromCode: StreamDef[] = [];
  const overridesUsed: { location: Location; patterns: readonly string[] }[] = [];
  const streamAdminCalls: Location[] = [];
  const kvCreateCalls: { location: Location; bucket: string }[] = [];
  const hits = new Set<ShapeSpec>();

  for (const sf of ctx.sourceFiles) {
    const visit = (node: ts.Node): void => {
      if (ts.isCallExpression(node) && !insideDeclaredWrapper(node)) {
        const matched = matchShape(ctx, node, shapes);
        if (matched) {
          hits.add(matched);
          handleCall(node, matched);
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(sf);
  }

  function handleCall(call: ts.CallExpression, declared: ShapeSpec): void {
    const location = locationOf(call);
    let shape = declared;
    if (shape.kind === 'kv') {
      handleKv(call, shape, location);
      return;
    }
    // A wrapper that is a core subscription unless a durable is named.
    if (shape.kind === 'js-subscribe' && shape.whenNoDurable === 'subscribe' && shape.durable !== undefined && argExpression(ctx, call, shape.durable) === null) {
      shape = { kind: 'subscribe', callee: shape.callee, ...(shape.subject !== undefined ? { subject: shape.subject } : {}) };
    }
    const streamSet = shape.stream !== undefined ? literalSetAt(call, shape.stream) : [];
    const durableExpr = shape.durable !== undefined ? argExpression(ctx, call, shape.durable) : null;
    const durableSet = durableExpr ? (evaluator.literalSet(durableExpr) ?? []) : [];
    const namesConsumer = durableExpr !== null;
    const stream = pick(streamSet, []);
    const durable = pick(durableSet, []);

    if (shape.kind === 'js-stream-admin') {
      streamAdminCalls.push(location);
      if ((shape.callee === 'add' || shape.callee === 'update') && shape.subject !== undefined && stream) {
        const expr = argExpression(ctx, call, shape.subject);
        const subjects = expr ? evaluator.literals(expr) : null;
        if (subjects && subjects.every((s) => isValidPattern(s) && !s.includes(SERVICE_PLACEHOLDER))) {
          streamsFromCode.push({ name: stream.value, subjects, source: `${location.file}:${location.line}:${location.col}` });
        }
      }
      return;
    }

    if (shape.kind === 'js-stream-info') {
      facts.push(fact(shape, NO_SUBJECT, location, [], 'literal', false, stream, undefined, false));
      return;
    }

    if (shape.subject === undefined) {
      facts.push(fact(shape, NO_SUBJECT, location, [], 'literal', false, stream, durable, namesConsumer));
      return;
    }

    const override = overrideFor(call);
    if (override) {
      overridesUsed.push({ location, patterns: override });
      for (const pattern of override) facts.push(fact(shape, pattern, location, [], 'override', false, stream, durable, namesConsumer));
      return;
    }

    const expr = argExpression(ctx, call, shape.subject);
    if (!expr) {
      if (shape.kind === 'js-consumer-add' || shape.kind === 'js-subscribe') {
        // A consumer without a filter subject consumes the whole stream.
        facts.push(fact(shape, '>', location, [], 'literal', false, stream, durable, namesConsumer));
        return;
      }
      unresolved.push({
        kind: shape.kind,
        location,
        expression: call.getText().slice(0, 120),
        reason: 'dynamic',
        detail: `no subject argument at ${describeArg(shape.subject)}`,
        hint: 'check the shape declaration for this call, or declare the subject with an override',
      });
      return;
    }

    const result = evaluator.patterns(expr);
    if (!result.ok) {
      const failedAt = locationOf(result.node);
      const elsewhere = failedAt.file !== location.file || failedAt.line !== location.line;
      unresolved.push({
        kind: shape.kind,
        location,
        expression: result.node.getText().slice(0, 120),
        reason: result.reason,
        detail: elsewhere ? `${result.detail} (at ${failedAt.file}:${failedAt.line}:${failedAt.col})` : result.detail,
        hint: result.hint,
      });
      return;
    }
    for (const p of result.patterns) {
      // A base class resolving `this.subject` and `this.durable` through its subclasses yields one
      // value per subclass for each; pair them through the subclass file they share.
      facts.push(fact(shape, p.pattern, location, p.via, p.origin, p.widened, pick(streamSet, p.via) ?? stream, pick(durableSet, p.via) ?? durable, namesConsumer));
    }
  }

  /**
   * A wrapper you declared is opaque: the client calls inside its body are what the declaration
   * stands for, and analysing them again would only add noise (and consumer-wide fallbacks
   * where the wrapper's parameters cannot be paired back to every caller).
   */
  function insideDeclaredWrapper(call: ts.CallExpression): boolean {
    for (let node: ts.Node | undefined = call.parent; node; node = node.parent) {
      if (!ts.isFunctionLike(node)) continue;
      if (ctx.jsdocShapes.has(node) || (node.parent && ctx.jsdocShapes.has(node.parent as ts.Declaration))) return true;
      if (!ts.isMethodDeclaration(node) || !ts.isClassLike(node.parent)) continue;
      const name = node.name.getText();
      const candidates = config.shapes.filter((s) => s.callee === name && s.receiverTypes && s.receiverTypes.length > 0);
      if (candidates.length === 0) continue;
      const names = typeNames(ctx.checker, ctx.checker.getTypeAtLocation(node.parent));
      if (candidates.some((s) => s.receiverTypes!.some((t) => names.has(t)))) return true;
    }
    return false;
  }

  /** `views.kv(name)`: the bucket name must be a literal; the grant set is per bucket. */
  function handleKv(call: ts.CallExpression, shape: ShapeSpec, location: Location): void {
    const expr = shape.subject === undefined ? null : argExpression(ctx, call, shape.subject);
    if (!expr) {
      unresolved.push({ kind: 'kv', location, expression: call.getText().slice(0, 120), reason: 'dynamic', detail: 'no bucket name argument', hint: 'pass the bucket name as a literal' });
      return;
    }
    const names = evaluator.literalSet(expr);
    if (!names || names.length === 0) {
      unresolved.push({
        kind: 'kv',
        location,
        expression: expr.getText().slice(0, 120),
        reason: 'dynamic',
        detail: 'the KV bucket name is not a literal; a bucket grant covers the whole bucket, so it cannot be widened',
        hint: 'use a literal bucket name, or declare the calls with an override per bucket',
      });
      return;
    }
    const bindOnly = shape.durable !== undefined ? argExpression(ctx, call, shape.durable) : null;
    const binds = shape.note === 'binds' || (bindOnly !== null && bindOnly.kind === ts.SyntaxKind.TrueKeyword);
    for (const name of names) {
      if (!/^[A-Za-z0-9_-]+$/.test(name.value)) {
        unresolved.push({ kind: 'kv', location, expression: name.value, reason: 'unsupported-syntax', detail: `"${name.value}" is not a valid bucket name`, hint: 'bucket names are letters, digits, - and _' });
        continue;
      }
      facts.push(fact(shape, `$KV.${name.value}.>`, location, name.via, 'literal', false, { value: `KV_${name.value}`, via: name.via }, undefined, false));
      if (!binds) kvCreateCalls.push({ location, bucket: name.value });
    }
  }

  function fact(
    shape: ShapeSpec,
    subject: string,
    location: Location,
    via: readonly Location[],
    origin: SubjectFact['origin'],
    widened: boolean,
    stream: { readonly value: string; readonly via: readonly Location[] } | undefined,
    durable: { readonly value: string; readonly via: readonly Location[] } | undefined,
    namesConsumer: boolean,
  ): SubjectFact {
    // Only product files can gate attribution: a chain that passes through a declaration file (a
    // `.toUpperCase()` on the way to a dynamic token) must not make the fact unreachable for everyone.
    const requires = [...new Set([location.file, ...via.map((v) => v.file), ...(stream?.via ?? []).map((v) => v.file), ...(durable?.via ?? []).map((v) => v.file)])].filter((f) => product.has(f));
    const base = { kind: shape.kind, subject, location, via, requires, origin, widened, namesConsumer };
    return {
      ...base,
      ...(stream ? { stream: stream.value } : {}),
      ...(durable ? { durable: durable.value } : {}),
      ...(shape.mode ? { mode: shape.mode } : {}),
    };
  }

  function literalSetAt(call: ts.CallExpression, ref: ArgRef): readonly { readonly value: string; readonly via: readonly Location[] }[] {
    const expr = argExpression(ctx, call, ref);
    if (!expr) return [];
    return evaluator.literalSet(expr) ?? [];
  }

  function overrideFor(call: ts.CallExpression): readonly string[] | null {
    const loc = locationOf(call);
    const configured = overrides.get(`${loc.file}:${loc.line}`);
    if (configured) return configured;
    const sf = call.getSourceFile();
    const lines = sf.text.split('\n');
    for (const line of [lines[loc.line - 1], lines[loc.line - 2]]) {
      const m = line ? INLINE_OVERRIDE.exec(line) : null;
      if (m) {
        return m[1]!
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean);
      }
    }
    return null;
  }

  const unusedShapes = config.shapes.filter((s) => !hits.has(s));
  return { facts, unresolved, streamsFromCode, overridesUsed, unusedShapes, streamAdminCalls, kvCreateCalls };
}

type Literal = { readonly value: string; readonly via: readonly Location[] };

/**
 * One literal out of a set: the only one, or the one whose resolution chain shares
 * a file with `via` (the subject's chain) beyond the files every candidate shares.
 */
function pick(set: readonly Literal[], via: readonly Location[]): Literal | undefined {
  if (set.length === 0) return undefined;
  if (set.length === 1) return set[0];
  const key = (l: Location): string => `${l.file}:${l.line}:${l.col}`;
  const common = set.map((e) => new Set(e.via.map(key))).reduce((acc, keys) => new Set([...acc].filter((k) => keys.has(k))));
  const wanted = new Set(via.map(key).filter((k) => !common.has(k)));
  if (wanted.size === 0) return undefined;
  const scored = set.map((e) => ({ e, score: e.via.filter((v) => wanted.has(key(v))).length })).filter((x) => x.score > 0);
  if (scored.length === 0) return undefined;
  scored.sort((a, b) => b.score - a.score);
  return scored.length === 1 || scored[0]!.score > scored[1]!.score ? scored[0]!.e : undefined;
}

/** The shape a call matches: a `@natsacl`-tagged declaration first, then the table by callee name and receiver type. */
export function matchShape(ctx: ProgramContext, call: ts.CallExpression, shapes: readonly ShapeSpec[]): ShapeSpec | null {
  const callee = call.expression;
  const nameNode = ts.isPropertyAccessExpression(callee) ? callee.name : ts.isIdentifier(callee) ? callee : null;
  if (!nameNode) return null;
  const name = nameNode.text;

  const decl = ctx.checker.getResolvedSignature(call)?.getDeclaration();
  for (const candidate of [decl, decl?.parent]) {
    if (candidate && ctx.jsdocShapes.has(candidate as ts.Declaration)) return ctx.jsdocShapes.get(candidate as ts.Declaration)!;
  }
  if (!decl) {
    // Overloads or aliases: any declaration of the callee symbol may carry the tag.
    const symbol = symbolOf(ctx.checker, nameNode);
    for (const d of symbol?.declarations ?? []) if (ctx.jsdocShapes.has(d)) return ctx.jsdocShapes.get(d)!;
  } else {
    const symbol = symbolOf(ctx.checker, nameNode);
    for (const d of symbol?.declarations ?? []) if (ctx.jsdocShapes.has(d)) return ctx.jsdocShapes.get(d)!;
  }

  const candidates = shapes.filter((s) => s.callee === name);
  if (candidates.length === 0) return null;
  const receiver = ts.isPropertyAccessExpression(callee) ? callee.expression : null;
  let names: Set<string> | null = null;
  for (const shape of candidates) {
    if (shape.receiverTypes === undefined) return shape;
    if (shape.receiverTypes.length === 0) {
      if (!receiver) return shape;
      continue;
    }
    if (!receiver) continue;
    names ??= receiverNames(ctx, receiver, name);
    if (shape.receiverTypes.some((t) => names!.has(t))) return shape;
  }
  return null;
}

/**
 * Every name a receiver answers to: its declared type with everything it extends or implements,
 * plus the class or interface that declares the member being called — which is how a
 * `Pick<NatsConnection, 'publish'>`, a local alias of one, or any structural copy still matches.
 */
function receiverNames(ctx: ProgramContext, receiver: ts.Expression, member: string): Set<string> {
  const type = ctx.checker.getTypeAtLocation(receiver);
  const names = typeNames(ctx.checker, type);
  for (const decl of type.getProperty(member)?.declarations ?? []) {
    const owner = decl.parent;
    if (ts.isClassLike(owner) || ts.isInterfaceDeclaration(owner)) {
      for (const n of typeNames(ctx.checker, ctx.checker.getTypeAtLocation(owner))) names.add(n);
    }
  }
  return names;
}

/** The expression an `ArgRef` points at: an argument, or a property inside an object-literal argument. */
export function argExpression(ctx: ProgramContext, call: ts.CallExpression, ref: ArgRef): ts.Expression | null {
  const index = typeof ref === 'number' ? ref : ref.arg;
  const arg = call.arguments[index];
  if (!arg) return null;
  if (typeof ref === 'number') return arg;
  let current: ts.Expression = arg;
  for (const segment of ref.path.split('.')) {
    const literal = objectLiteralOf(ctx, current);
    if (!literal) return null;
    const member = literal.properties.find((p) => (ts.isPropertyAssignment(p) || ts.isShorthandPropertyAssignment(p)) && p.name.getText() === segment);
    if (!member) return null;
    if (ts.isPropertyAssignment(member)) current = member.initializer;
    else if (ts.isShorthandPropertyAssignment(member)) current = member.name;
    else return null;
  }
  return current;
}

/** An object literal, directly or through a const binding. */
function objectLiteralOf(ctx: ProgramContext, expr: ts.Expression): ts.ObjectLiteralExpression | null {
  const inner = unwrap(expr);
  if (ts.isObjectLiteralExpression(inner)) return inner;
  if (ts.isIdentifier(inner)) {
    const decl = symbolOf(ctx.checker, inner)?.valueDeclaration;
    if (decl && ts.isVariableDeclaration(decl) && decl.initializer) return objectLiteralOf(ctx, decl.initializer);
  }
  return null;
}

function describeArg(ref: ArgRef): string {
  return typeof ref === 'number' ? `argument ${ref}` : `argument ${ref.arg} path "${ref.path}"`;
}
