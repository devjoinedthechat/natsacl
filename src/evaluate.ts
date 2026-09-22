import ts from 'typescript';
import type { Location, Origin, UnresolvedReason } from './model.js';
import { allSubtypes, locationOf, overriddenMembers, symbolOf, type ProgramContext } from './program.js';
import { isValidPattern } from './subjects.js';

/**
 * Abstract evaluation of a subject expression to a finite set of NATS
 * patterns.
 *
 * A value is a set of template strings; each template string is a sequence of
 * literal chunks and dynamic chunks. Literals, constants, enum members, `as
 * const` objects, string-literal union types and template-literal types
 * contribute literal chunks; anything the analyser cannot pin down becomes a
 * dynamic chunk. Wrapper parameters are evaluated at every call site of the
 * wrapper (and of every base-class or interface member it implements), and
 * abstract or uninitialised properties at every subclass that initialises
 * them, so a base class calling `this.nats.publish(this.subject)` yields one
 * fact per concrete subclass.
 *
 * When a template string is turned into a pattern, a dynamic chunk that fills
 * a whole token becomes `*` (or `>` at the tail when configured), and a
 * dynamic chunk sharing a token with literal text is an error — NATS
 * wildcards are whole tokens, so `DEVICE-${id}` has no permission that admits
 * exactly what the code publishes. `widenPartialTokens` turns that token into
 * `*` and reports the widening.
 *
 * The evaluator never returns a partial answer: if any branch of an
 * expression is unresolved, the whole expression is, and the diagnostic names
 * the sub-expression that failed.
 */

export type Chunk = { readonly lit: string } | { readonly dyn: true } | { readonly svc: true };

/** The token a `@natsacl service-name` declaration renders as; the deriver substitutes each service's name. */
export const SERVICE_PLACEHOLDER = '${service}';
export interface TemplateString {
  readonly chunks: readonly Chunk[];
  readonly via: readonly Location[];
  readonly origin: Origin;
}
export type Value = { readonly ok: true; readonly strings: readonly TemplateString[] } | Unresolved;
export interface Unresolved {
  readonly ok: false;
  readonly reason: UnresolvedReason;
  readonly detail: string;
  readonly hint: string;
  readonly node: ts.Node;
}

export interface ResolvedPattern {
  readonly pattern: string;
  readonly via: readonly Location[];
  readonly origin: Origin;
  readonly widened: boolean;
}
export type PatternResult = { readonly ok: true; readonly patterns: readonly ResolvedPattern[] } | Unresolved;

export interface EvaluateOptions {
  readonly maxExpansions: number;
  readonly maxDepth: number;
  readonly widenPartialTokens: boolean;
  readonly dynamicTail: 'single' | 'rest';
}

interface Env {
  /** Parameter → the argument expressions bound at the call being inlined. */
  readonly params: ReadonlyMap<ts.ParameterDeclaration, readonly ts.Expression[]>;
  readonly depth: number;
  /** Declarations on the current path, to cut cycles. */
  readonly active: ReadonlySet<ts.Node>;
  readonly via: readonly Location[];
  /**
   * True while evaluating one piece of a larger string (a template span, a `+`
   * operand, a `join` element): a value that cannot be pinned down is then a
   * dynamic token, not a failure. At the top level a fully dynamic subject is
   * refused — the only permission admitting it would be `>`.
   */
  readonly dynamicOk: boolean;
}

const NO_ENV: Env = { params: new Map(), depth: 0, active: new Set(), via: [], dynamicOk: false };
/** For names that only refine a grant (durable, stream): an alternative that cannot be resolved is dropped, not fatal. */
const TOLERANT_ENV: Env = { ...NO_ENV, dynamicOk: true };

/** Failures that mean "some string we cannot enumerate" rather than "malformed". */
const DYNAMIC_FALLBACK: ReadonlySet<UnresolvedReason> = new Set(['dynamic', 'no-callers', 'no-subclasses', 'unsupported-syntax', 'depth-exceeded']);

const STRING_TRANSFORMS = new Set(['toUpperCase', 'toLowerCase', 'trim', 'replace', 'replaceAll', 'slice', 'substring']);

const HINT_DECLARE = 'declare the subject with a `// natsacl-subject: <pattern>` comment on the call, an `overrides` entry, or a `@natsacl` tag on the wrapper';

export class Evaluator {
  constructor(
    private readonly ctx: ProgramContext,
    private readonly options: EvaluateOptions,
  ) {}

  /** Evaluate to NATS patterns. */
  patterns(expr: ts.Expression): PatternResult {
    const value = this.value(expr, NO_ENV);
    if (!value.ok) return value;
    const patterns: ResolvedPattern[] = [];
    for (const s of value.strings) {
      const converted = templateToPattern(s.chunks, this.options);
      if (!converted.ok) return { ok: false, reason: converted.reason, detail: converted.detail, hint: converted.hint, node: expr };
      patterns.push({ pattern: converted.pattern, via: s.via, origin: s.origin, widened: converted.widened });
    }
    return { ok: true, patterns: dedupe(patterns) };
  }

  /** Evaluate to a single literal string (a stream or durable name); null when not a single literal. */
  literal(expr: ts.Expression): { readonly value: string; readonly via: readonly Location[] } | null {
    const value = this.value(expr, TOLERANT_ENV);
    if (!value.ok || value.strings.length !== 1) return null;
    const only = value.strings[0]!;
    if (only.chunks.some((c) => 'dyn' in c)) return null;
    return { value: only.chunks.map(chunkText).join(''), via: only.via };
  }

  /** Every literal string the expression can be, with the chain each came through; null when any alternative is dynamic. */
  literalSet(expr: ts.Expression): readonly { readonly value: string; readonly via: readonly Location[] }[] | null {
    const value = this.value(expr, TOLERANT_ENV);
    if (!value.ok) return null;
    const out: { value: string; via: readonly Location[] }[] = [];
    for (const s of value.strings) {
      // A dynamic alternative (one subclass computing its durable) must not cost the literal ones their scoping.
      if (s.chunks.some((c) => !('lit' in c))) continue;
      out.push({ value: s.chunks.map(chunkText).join(''), via: s.via });
    }
    return out;
  }

  /** Evaluate an array-literal-ish expression to a list of literal strings (stream subjects). */
  literals(expr: ts.Expression): readonly string[] | null {
    const inner = unwrap(expr);
    if (!ts.isArrayLiteralExpression(inner)) {
      const value = this.value(inner, NO_ENV);
      if (!value.ok) return null;
      const out: string[] = [];
      for (const s of value.strings) {
        if (s.chunks.some((c) => 'dyn' in c)) return null;
        out.push(s.chunks.map(chunkText).join(''));
      }
      return out;
    }
    const out: string[] = [];
    for (const element of inner.elements) {
      const lit = this.literal(element);
      if (!lit) return null;
      out.push(lit.value);
    }
    return out;
  }

  value(node: ts.Expression, env: Env): Value {
    if (env.depth > this.options.maxDepth) {
      return this.fail(env, 'depth-exceeded', node, `resolution deeper than ${this.options.maxDepth} declarations`, 'raise maxDepth, or ' + HINT_DECLARE);
    }
    const expr = unwrap(node);

    if (ts.isStringLiteralLike(expr)) return ok([{ chunks: [{ lit: expr.text }], via: env.via, origin: 'literal' }]);

    if (ts.isTemplateExpression(expr)) {
      let acc: readonly TemplateString[] = [{ chunks: [{ lit: expr.head.text }], via: env.via, origin: 'template' }];
      for (const span of expr.templateSpans) {
        const part = this.value(span.expression, { ...env, dynamicOk: true });
        if (!part.ok) return part;
        acc = this.product(acc, part.strings, 'template', expr);
        if (acc.length > this.options.maxExpansions) return this.tooMany(expr);
        acc = acc.map((s) => ({ ...s, chunks: [...s.chunks, { lit: span.literal.text }] }));
      }
      return ok(acc);
    }

    if (ts.isBinaryExpression(expr)) {
      const op = expr.operatorToken.kind;
      if (op === ts.SyntaxKind.PlusToken) {
        const piece: Env = { ...env, dynamicOk: true };
        const left = this.value(expr.left, piece);
        if (!left.ok) return left;
        const right = this.value(expr.right, piece);
        if (!right.ok) return right;
        const strings = this.product(left.strings, right.strings, 'template', expr);
        return strings.length > this.options.maxExpansions ? this.tooMany(expr) : ok(strings);
      }
      if (op === ts.SyntaxKind.QuestionQuestionToken || op === ts.SyntaxKind.BarBarToken) {
        const left = this.value(expr.left, env);
        if (!left.ok) return left;
        const right = this.value(expr.right, env);
        if (!right.ok) return right;
        return ok([...left.strings, ...right.strings]);
      }
      if (op === ts.SyntaxKind.AmpersandAmpersandToken) return this.value(expr.right, env);
      return this.fail(env, 'unsupported-syntax', expr, `operator ${ts.tokenToString(op) ?? String(op)} in a subject expression`, HINT_DECLARE);
    }

    if (ts.isConditionalExpression(expr)) {
      const a = this.value(expr.whenTrue, env);
      if (!a.ok) return a;
      const b = this.value(expr.whenFalse, env);
      if (!b.ok) return b;
      return ok([...a.strings, ...b.strings]);
    }

    if (ts.isIdentifier(expr)) return this.identifier(expr, env);

    if (ts.isPropertyAccessExpression(expr)) return this.propertyAccess(expr, env);

    if (ts.isElementAccessExpression(expr)) return this.elementAccess(expr, env);

    if (ts.isCallExpression(expr)) {
      const decl = this.ctx.checker.getResolvedSignature(expr)?.getDeclaration();
      if (decl && this.ctx.serviceNameDeclarations.has(decl)) return ok([{ chunks: [{ svc: true }], via: [...env.via, locationOf(decl)], origin: 'constant' }]);
      return this.call(expr, env);
    }

    if (ts.isArrayLiteralExpression(expr)) {
      return this.fail(env, 'unsupported-syntax', expr, 'an array is not a subject', HINT_DECLARE);
    }

    return this.fromType(expr, env) ?? this.fail(env, 'unsupported-syntax', expr, `${ts.SyntaxKind[expr.kind]} in a subject expression`, HINT_DECLARE);
  }

  private identifier(expr: ts.Identifier, env: Env): Value {
    if (expr.text === 'undefined') return this.fail(env, 'dynamic', expr, 'undefined', HINT_DECLARE);
    const symbol = symbolOf(this.ctx.checker, expr);
    const decl = symbol?.valueDeclaration ?? symbol?.declarations?.[0];
    if (!decl) return this.fromType(expr, env) ?? this.fail(env, 'dynamic', expr, `cannot resolve "${expr.text}"`, HINT_DECLARE);
    return this.declaration(decl, expr, env);
  }

  private declaration(decl: ts.Declaration, at: ts.Expression, env: Env): Value {
    if (this.ctx.serviceNameDeclarations.has(decl)) return ok([{ chunks: [{ svc: true }], via: [...env.via, locationOf(decl)], origin: 'constant' }]);
    if (env.active.has(decl)) return this.fail(env, 'dynamic', at, `"${at.getText()}" is defined in terms of itself`, HINT_DECLARE);
    const next: Env = { ...env, depth: env.depth + 1, active: new Set([...env.active, decl]), via: [...env.via, locationOf(decl)] };

    if (ts.isParameter(decl)) return this.parameter(decl, at, env);

    if (ts.isVariableDeclaration(decl)) {
      if (decl.initializer) return this.value(decl.initializer, next);
      if (ts.isVariableDeclarationList(decl.parent) && !(decl.parent.flags & ts.NodeFlags.Const)) {
        return this.fromType(at, env) ?? this.fail(env, 'dynamic', at, `"${at.getText()}" is a mutable binding without an initializer`, HINT_DECLARE);
      }
      return this.fromType(at, env) ?? this.fail(env, 'dynamic', at, `"${at.getText()}" has no initializer`, HINT_DECLARE);
    }

    if (ts.isEnumMember(decl)) {
      const constant = this.ctx.checker.getConstantValue(decl);
      if (typeof constant === 'string') return ok([{ chunks: [{ lit: constant }], via: next.via, origin: 'enum' }]);
      return this.fail(env, 'dynamic', at, `enum member "${at.getText()}" is not a string`, HINT_DECLARE);
    }

    if (ts.isPropertyAssignment(decl)) return this.value(decl.initializer, { ...next, via: next.via.slice(0, -1) });
    if (ts.isShorthandPropertyAssignment(decl)) {
      const target = this.ctx.checker.getShorthandAssignmentValueSymbol(decl)?.valueDeclaration;
      return target ? this.declaration(target, at, env) : this.fail(env, 'dynamic', at, `cannot resolve shorthand "${at.getText()}"`, HINT_DECLARE);
    }

    if (ts.isBindingElement(decl)) return this.bindingElement(decl, at, next);

    if (ts.isPropertyDeclaration(decl) || ts.isPropertySignature(decl)) return this.property(decl, at, next);

    if (ts.isGetAccessorDeclaration(decl)) return this.returns(decl, next, at);

    return this.fromType(at, env) ?? this.fail(env, 'unsupported-syntax', at, `${ts.SyntaxKind[decl.kind]} "${at.getText()}"`, HINT_DECLARE);
  }

  private bindingElement(decl: ts.BindingElement, at: ts.Expression, env: Env): Value {
    const pattern = decl.parent;
    const parentDecl = pattern.parent;
    if (!ts.isObjectBindingPattern(pattern) || !ts.isVariableDeclaration(parentDecl) || !parentDecl.initializer) {
      return this.fromType(at, env) ?? this.fail(env, 'unsupported-syntax', at, `destructuring of "${at.getText()}"`, HINT_DECLARE);
    }
    const key = decl.propertyName ?? decl.name;
    if (!ts.isIdentifier(key)) return this.fail(env, 'unsupported-syntax', at, 'computed destructuring key', HINT_DECLARE);
    return this.memberOf(parentDecl.initializer, key.text, at, env);
  }

  /** `obj.key` where `obj` is any expression: resolve the member through its symbol, then through the object literal. */
  private memberOf(objectExpr: ts.Expression, key: string, at: ts.Expression, env: Env): Value {
    const type = this.ctx.checker.getTypeAtLocation(objectExpr);
    const prop = type.getProperty(key);
    const decl = prop?.valueDeclaration ?? prop?.declarations?.[0];
    if (decl) return this.declaration(decl, at, env);
    return this.fromType(at, env) ?? this.fail(env, 'dynamic', at, `cannot resolve member "${key}"`, HINT_DECLARE);
  }

  private propertyAccess(expr: ts.PropertyAccessExpression, env: Env): Value {
    const symbol = symbolOf(this.ctx.checker, expr.name);
    const decl = symbol?.valueDeclaration ?? symbol?.declarations?.[0];
    if (decl) {
      if (ts.isPropertyDeclaration(decl) || ts.isPropertySignature(decl)) {
        // A member declared on an interface or type literal has no value of its own: the value is in
        // whatever object the receiver evaluates to — a literal, or the return of a factory call.
        if (!ts.isPropertyDeclaration(decl) || !decl.initializer) {
          const fromObject = this.memberThroughValue(expr.expression, expr.name.text, expr, env);
          if (fromObject) return fromObject;
        }
        const receiverType = this.ctx.checker.getTypeAtLocation(expr.expression);
        return this.property(decl, expr, { ...env, depth: env.depth + 1, via: [...env.via, locationOf(decl)] }, receiverType);
      }
      return this.declaration(decl, expr, env);
    }
    const fromObject = this.memberThroughValue(expr.expression, expr.name.text, expr, env);
    if (fromObject) return fromObject;
    return this.fromType(expr, env) ?? this.fail(env, 'dynamic', expr, `cannot resolve "${expr.getText()}"`, HINT_DECLARE);
  }

  /**
   * `receiver.name` resolved through the object literals the receiver can be: written in place,
   * bound to a const, passed as an argument, or returned by a factory whose body the program holds.
   */
  private memberThroughValue(receiver: ts.Expression, name: string, at: ts.Expression, env: Env): Value | null {
    const sources = this.objectSources(receiver, env, 0, new Set());
    if (sources.length === 0) return null;
    const strings: TemplateString[] = [];
    let found = false;
    for (const source of sources) {
      const initializer = objectMember(source.literal, name);
      if (!initializer) continue;
      found = true;
      const v = this.value(initializer, { ...source.env, depth: source.env.depth + 1, via: [...source.env.via, locationOf(initializer)] });
      if (!v.ok) return v;
      strings.push(...v.strings.map((s) => ({ ...s, origin: s.origin === 'literal' ? ('constant' as const) : s.origin })));
    }
    void at;
    return found ? ok(strings) : null;
  }

  /** The object literals an expression may evaluate to, each with the environment its members must be read in. */
  private objectSources(expr: ts.Expression, env: Env, depth: number, active: Set<ts.Node>): { literal: ts.ObjectLiteralExpression; env: Env }[] {
    if (depth > this.options.maxDepth) return [];
    const inner = unwrap(expr);
    if (ts.isObjectLiteralExpression(inner)) return [{ literal: inner, env }];
    if (ts.isConditionalExpression(inner)) {
      return [...this.objectSources(inner.whenTrue, env, depth + 1, active), ...this.objectSources(inner.whenFalse, env, depth + 1, active)];
    }
    if (ts.isBinaryExpression(inner) && (inner.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken || inner.operatorToken.kind === ts.SyntaxKind.BarBarToken)) {
      return [...this.objectSources(inner.left, env, depth + 1, active), ...this.objectSources(inner.right, env, depth + 1, active)];
    }
    if (ts.isIdentifier(inner)) {
      const symbol = symbolOf(this.ctx.checker, inner);
      const decl = symbol?.valueDeclaration ?? symbol?.declarations?.[0];
      if (!decl || active.has(decl)) return [];
      active.add(decl);
      if (ts.isVariableDeclaration(decl) && decl.initializer) return this.objectSources(decl.initializer, env, depth + 1, active);
      if (ts.isParameter(decl)) {
        const bound = env.params.get(decl);
        if (bound) return bound.flatMap((arg) => this.objectSources(arg, env, depth + 1, active));
        const fn = decl.parent;
        if (!ts.isFunctionLike(fn)) return [];
        const index = fn.parameters.indexOf(decl);
        return this.callersOf(fn).flatMap((call) => {
          const arg = (ts.isCallExpression(call) || ts.isNewExpression(call) ? call.arguments ?? [] : [])[index];
          return arg && !ts.isSpreadElement(arg) ? this.objectSources(arg, { ...env, via: [...env.via, locationOf(call)] }, depth + 1, active) : [];
        });
      }
      if (ts.isPropertyAssignment(decl)) return this.objectSources(decl.initializer, env, depth + 1, active);
      if (ts.isPropertyDeclaration(decl) && decl.initializer) return this.objectSources(decl.initializer, env, depth + 1, active);
      return [];
    }
    if (ts.isPropertyAccessExpression(inner)) {
      const symbol = symbolOf(this.ctx.checker, inner.name);
      const decl = symbol?.valueDeclaration;
      if (decl && ts.isPropertyDeclaration(decl) && decl.initializer && !active.has(decl)) {
        active.add(decl);
        return this.objectSources(decl.initializer, env, depth + 1, active);
      }
      return this.objectSources(inner.expression, env, depth + 1, active).flatMap((source) => {
        const member = objectMember(source.literal, inner.name.text);
        return member ? this.objectSources(member, source.env, depth + 1, active) : [];
      });
    }
    if (ts.isCallExpression(inner)) {
      const decl = this.ctx.checker.getResolvedSignature(inner)?.getDeclaration();
      if (!decl || !ts.isFunctionLike(decl) || active.has(decl)) return [];
      const body = (decl as ts.FunctionLikeDeclaration).body;
      if (!body) return [];
      active.add(decl);
      const params = new Map(env.params);
      decl.parameters.forEach((p, i) => {
        const arg = inner.arguments[i];
        params.set(p, arg ? [arg] : p.initializer ? [p.initializer] : []);
      });
      const bound: Env = { ...env, params, depth: env.depth + 1, via: [...env.via, locationOf(decl)] };
      if (!ts.isBlock(body)) return this.objectSources(body as ts.Expression, bound, depth + 1, active);
      const returns: ts.Expression[] = [];
      const visit = (node: ts.Node): void => {
        if (ts.isFunctionLike(node) && node !== decl) return;
        if (ts.isReturnStatement(node) && node.expression) returns.push(node.expression);
        ts.forEachChild(node, visit);
      };
      visit(body);
      return returns.flatMap((r) => this.objectSources(r, bound, depth + 1, active));
    }
    return [];
  }

  private elementAccess(expr: ts.ElementAccessExpression, env: Env): Value {
    const arg = unwrap(expr.argumentExpression);
    if (ts.isStringLiteralLike(arg)) return this.memberOf(expr.expression, arg.text, expr, env);
    if (ts.isNumericLiteral(arg)) {
      const target = unwrap(expr.expression);
      if (ts.isArrayLiteralExpression(target)) {
        const element = target.elements[Number(arg.text)];
        return element ? this.value(element, env) : this.fail(env, 'dynamic', expr, 'index out of range', HINT_DECLARE);
      }
    }
    const keyValue = this.value(expr.argumentExpression, env);
    if (keyValue.ok && keyValue.strings.every((s) => s.chunks.every((c) => 'lit' in c))) {
      const parts: TemplateString[] = [];
      for (const s of keyValue.strings) {
        const member = this.memberOf(expr.expression, s.chunks.map(chunkText).join(''), expr, env);
        if (!member.ok) return member;
        parts.push(...member.strings);
      }
      return ok(parts);
    }
    // Dynamic key on a finite object: the union of every literal member — read from the object
    // literal itself when the program has it, since a `Record<string, string>` annotation erases the keys.
    const literalSources = this.objectSources(expr.expression, env, 0, new Set());
    if (literalSources.length > 0) {
      const strings: TemplateString[] = [];
      let members = 0;
      for (const source of literalSources) {
        for (const prop of source.literal.properties) {
          const initializer = ts.isPropertyAssignment(prop) ? prop.initializer : ts.isShorthandPropertyAssignment(prop) ? prop.name : null;
          if (!initializer) return this.fail(env, 'unsupported-syntax', expr, 'a spread or method inside the object being indexed', HINT_DECLARE);
          members++;
          if (members > this.options.maxExpansions) return this.tooMany(expr);
          const v = this.value(initializer, { ...source.env, depth: source.env.depth + 1 });
          if (!v.ok) return v;
          strings.push(...v.strings.map((t) => ({ ...t, origin: t.origin === 'literal' ? ('constant' as const) : t.origin })));
        }
      }
      if (strings.length > 0) return ok(strings);
    }
    const objectType = this.ctx.checker.getTypeAtLocation(expr.expression);
    const props = objectType.getProperties();
    if (props.length > 0 && props.length <= this.options.maxExpansions) {
      const strings: TemplateString[] = [];
      for (const prop of props) {
        const decl = prop.valueDeclaration ?? prop.declarations?.[0];
        if (!decl) return this.fail(env, 'dynamic', expr, `member "${prop.name}" has no declaration`, HINT_DECLARE);
        const v = this.declaration(decl, expr, env);
        if (!v.ok) return v;
        strings.push(...v.strings);
      }
      return ok(strings);
    }
    return this.fromType(expr, env) ?? this.fail(env, 'dynamic', expr, `dynamic element access "${expr.getText()}"`, HINT_DECLARE);
  }

  private property(decl: ts.PropertyDeclaration | ts.PropertySignature, at: ts.Expression, env: Env, receiverType?: ts.Type): Value {
    if (this.ctx.serviceNameDeclarations.has(decl)) return ok([{ chunks: [{ svc: true }], via: env.via, origin: 'constant' }]);
    if (env.active.has(decl)) return this.fail(env, 'dynamic', at, `"${at.getText()}" is defined in terms of itself`, HINT_DECLARE);
    const next: Env = { ...env, active: new Set([...env.active, decl]) };

    if (ts.isPropertyDeclaration(decl) && decl.initializer) {
      const own = this.value(decl.initializer, next);
      // A concrete initializer on a class the receiver is not statically narrowed to
      // may be overridden by subclasses; include their initializers too.
      const subclassValues = this.subclassInitializers(decl, at, next, receiverType);
      if (!own.ok) return own;
      if (!subclassValues.ok) return subclassValues;
      return ok([...own.strings, ...subclassValues.strings]);
    }

    // No initializer: a literal type says everything; otherwise constructor assignments, then subclasses.
    const typed = this.fromDeclaredType(decl, at, next);
    if (typed) return typed;

    if (ts.isPropertyDeclaration(decl) && ts.isClassLike(decl.parent)) {
      const assigned = this.constructorAssignments(decl, at, next);
      if (assigned) return assigned;
    }

    const sub = this.subclassInitializers(decl, at, next, receiverType);
    if (!sub.ok) return sub;
    if (sub.strings.length > 0) return sub;
    return this.fail(env, 
      'no-subclasses',
      at,
      `"${at.getText()}" is declared without an initializer and no class in the program initialises it`,
      'initialise the property in a subclass, give it a string-literal type, or ' + HINT_DECLARE,
    );
  }

  private subclassInitializers(decl: ts.PropertyDeclaration | ts.PropertySignature, at: ts.Expression, env: Env, receiverType?: ts.Type): Value {
    const owner = decl.parent;
    if (!ts.isClassLike(owner) && !ts.isInterfaceDeclaration(owner)) return ok([]);
    const name = decl.name.getText();
    const strings: TemplateString[] = [];
    const narrowed = receiverType?.getSymbol()?.valueDeclaration;
    for (const sub of allSubtypes(this.ctx, owner)) {
      // Receiver statically typed as a specific subclass: only that branch of the hierarchy applies.
      if (narrowed && ts.isClassLike(narrowed) && narrowed !== owner && sub !== narrowed && !allSubtypes(this.ctx, narrowed).includes(sub)) continue;
      for (const member of sub.members) {
        if (!ts.isPropertyDeclaration(member) || member.name.getText() !== name) continue;
        if (member.initializer) {
          const v = this.value(member.initializer, { ...env, depth: env.depth + 1, via: [...env.via, locationOf(sub), locationOf(member)] });
          if (!v.ok) return v;
          strings.push(...v.strings.map((s) => ({ ...s, origin: 'subclass' as const })));
        } else {
          const assigned = this.constructorAssignments(member, at, { ...env, via: [...env.via, locationOf(sub), locationOf(member)] });
          if (assigned) {
            if (!assigned.ok) return assigned;
            strings.push(...assigned.strings.map((s) => ({ ...s, origin: 'subclass' as const })));
          }
        }
      }
    }
    return ok(strings);
  }

  /** `this.x = <expr>` inside the owning class (typically the constructor). */
  private constructorAssignments(decl: ts.PropertyDeclaration, at: ts.Expression, env: Env): Value | null {
    const owner = decl.parent;
    if (!ts.isClassLike(owner)) return null;
    const name = decl.name.getText();
    const rhs: ts.Expression[] = [];
    const visit = (node: ts.Node): void => {
      if (
        ts.isBinaryExpression(node) &&
        node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
        ts.isPropertyAccessExpression(node.left) &&
        node.left.expression.kind === ts.SyntaxKind.ThisKeyword &&
        node.left.name.text === name
      ) {
        rhs.push(node.right);
      }
      ts.forEachChild(node, visit);
    };
    for (const member of owner.members) visit(member);
    if (rhs.length === 0) return null;
    const strings: TemplateString[] = [];
    for (const expr of rhs) {
      const v = this.value(expr, { ...env, depth: env.depth + 1, via: [...env.via, locationOf(expr)] });
      if (!v.ok) return v;
      strings.push(...v.strings);
    }
    return ok(strings);
  }

  private parameter(param: ts.ParameterDeclaration, at: ts.Expression, env: Env): Value {
    const bound = env.params.get(param);
    if (bound) {
      const strings: TemplateString[] = [];
      for (const arg of bound) {
        const v = this.value(arg, { ...env, depth: env.depth + 1 });
        if (!v.ok) return v;
        strings.push(...v.strings);
      }
      return ok(strings);
    }
    // A finite declared type is authoritative and needs no callers.
    const typed = this.fromDeclaredType(param, at, env);
    if (typed) return typed;
    if (param.dotDotDotToken) return this.fail(env, 'unsupported-syntax', at, 'rest parameter as a subject', HINT_DECLARE);

    const fn = param.parent;
    if (!ts.isFunctionLike(fn)) return this.fail(env, 'unsupported-syntax', at, 'parameter outside a function', HINT_DECLARE);
    const index = fn.parameters.indexOf(param);
    if (env.active.has(fn)) return this.fail(env, 'dynamic', at, `"${at.getText()}" flows through a recursive call`, HINT_DECLARE);

    const callers = this.callersOf(fn);
    if (callers.length === 0) {
      return this.fail(env, 
        'no-callers',
        at,
        `"${at.getText()}" is a parameter of ${describeFunction(fn)} and nothing in the program calls it with a resolvable argument`,
        'call sites outside the program (DI, tests, other packages) are invisible; ' + HINT_DECLARE,
      );
    }
    const strings: TemplateString[] = [];
    for (const call of callers) {
      const args = ts.isCallExpression(call) || ts.isNewExpression(call) ? (call.arguments ?? []) : [];
      const arg = args[index];
      const callEnv: Env = { ...env, depth: env.depth + 1, active: new Set([...env.active, fn]), via: [...env.via, locationOf(call)] };
      if (arg) {
        if (ts.isSpreadElement(arg)) return this.fail(env, 'unsupported-syntax', at, 'spread argument for a subject parameter', HINT_DECLARE);
        const v = this.value(arg, callEnv);
        if (!v.ok) return v;
        strings.push(...v.strings.map((s) => ({ ...s, origin: 'parameter' as const })));
      } else if (param.initializer) {
        const v = this.value(param.initializer, callEnv);
        if (!v.ok) return v;
        strings.push(...v.strings.map((s) => ({ ...s, origin: 'parameter' as const })));
      } else {
        return this.fail(env, 'dynamic', at, `a caller at ${fmt(locationOf(call))} omits the subject argument`, HINT_DECLARE);
      }
    }
    return ok(strings);
  }

  /** Direct callers plus callers of every base-class or interface member this function implements. */
  private callersOf(fn: ts.SignatureDeclaration): ts.CallLikeExpression[] {
    const decls: ts.Declaration[] = [fn];
    if ((ts.isMethodDeclaration(fn) || ts.isConstructorDeclaration(fn)) && ts.isClassLike(fn.parent)) {
      const name = ts.isConstructorDeclaration(fn) ? null : fn.name.getText();
      if (name) decls.push(...overriddenMembers(this.ctx.checker, fn.parent, name));
      // Overloads share a name: the implementation is called through any of them.
      for (const member of fn.parent.members) {
        if (member !== fn && ts.isMethodDeclaration(member) && member.name.getText() === name) decls.push(member);
      }
    }
    if (ts.isFunctionDeclaration(fn) && fn.name) {
      const symbol = this.ctx.checker.getSymbolAtLocation(fn.name);
      for (const d of symbol?.declarations ?? []) if (!decls.includes(d)) decls.push(d);
    }
    if (ts.isArrowFunction(fn) || ts.isFunctionExpression(fn)) {
      const holder = fn.parent;
      if (ts.isVariableDeclaration(holder) || ts.isPropertyDeclaration(holder) || ts.isPropertyAssignment(holder)) decls.push(holder);
    }
    const out: ts.CallLikeExpression[] = [];
    for (const d of decls) for (const call of this.ctx.callSites.get(d) ?? []) if (!out.includes(call)) out.push(call);
    return out;
  }

  private call(expr: ts.CallExpression, env: Env): Value {
    // `[a, b].join('.')` is a common subject builder.
    if (ts.isPropertyAccessExpression(expr.expression) && expr.expression.name.text === 'join') {
      const target = unwrap(expr.expression.expression);
      const sep = expr.arguments[0];
      if (ts.isArrayLiteralExpression(target) && (!sep || ts.isStringLiteralLike(sep))) {
        const separator = sep && ts.isStringLiteralLike(sep) ? sep.text : ',';
        let acc: readonly TemplateString[] = [{ chunks: [], via: env.via, origin: 'template' }];
        for (let i = 0; i < target.elements.length; i++) {
          const v = this.value(target.elements[i]!, { ...env, dynamicOk: true });
          if (!v.ok) return v;
          if (i > 0) acc = acc.map((s) => ({ ...s, chunks: [...s.chunks, { lit: separator }] }));
          acc = this.product(acc, v.strings, 'template', expr);
          if (acc.length > this.options.maxExpansions) return this.tooMany(expr);
        }
        return ok(acc);
      }
    }
    // Pure string transforms keep a finite set finite: `route.target.toLowerCase()`, `name.replace('-svc', '')`.
    if (ts.isPropertyAccessExpression(expr.expression) && STRING_TRANSFORMS.has(expr.expression.name.text)) {
      const transformed = this.stringTransform(expr, expr.expression.name.text, env);
      if (transformed) return transformed;
    }
    const sig = this.ctx.checker.getResolvedSignature(expr);
    const decl = sig?.getDeclaration();
    if (!decl || !ts.isFunctionLike(decl)) return this.fromType(expr, env) ?? this.fail(env, 'dynamic', expr, `call "${expr.expression.getText()}(…)" cannot be inlined`, HINT_DECLARE);
    if (env.active.has(decl)) return this.fail(env, 'dynamic', expr, `recursive call "${expr.expression.getText()}(…)"`, HINT_DECLARE);
    const params = new Map(env.params);
    decl.parameters.forEach((p, i) => {
      const arg = expr.arguments[i];
      params.set(p, arg ? [arg] : p.initializer ? [p.initializer] : []);
    });
    const next: Env = { params, depth: env.depth + 1, active: new Set([...env.active, decl]), via: [...env.via, locationOf(decl)], dynamicOk: env.dynamicOk };
    return this.returns(decl, next, expr);
  }

  /**
   * `receiver.<transform>(…args)` applied to every literal the receiver can be, when every
   * argument is a literal (a string, a number, or a regex literal for `replace`). Returns null
   * when the receiver is not finite, so the caller falls through to inlining or a dynamic token.
   */
  private stringTransform(expr: ts.CallExpression, name: string, env: Env): Value | null {
    const receiverExpr = (expr.expression as ts.PropertyAccessExpression).expression;
    const receiver = this.value(receiverExpr, { ...env, dynamicOk: false });
    if (!receiver.ok || receiver.strings.some((s) => s.chunks.some((c) => !('lit' in c)))) return null;
    const args: (string | number | RegExp)[] = [];
    for (const arg of expr.arguments) {
      const inner = unwrap(arg);
      if (ts.isStringLiteralLike(inner)) args.push(inner.text);
      else if (ts.isNumericLiteral(inner)) args.push(Number(inner.text));
      else if (ts.isRegularExpressionLiteral(inner)) {
        const m = /^\/(.*)\/([a-z]*)$/s.exec(inner.text);
        if (!m) return null;
        try {
          args.push(new RegExp(m[1]!, m[2]));
        } catch {
          return null;
        }
      } else return null;
    }
    const apply = (value: string): string | null => {
      switch (name) {
        case 'toUpperCase':
          return value.toUpperCase();
        case 'toLowerCase':
          return value.toLowerCase();
        case 'trim':
          return value.trim();
        case 'replace':
        case 'replaceAll': {
          const [pattern, replacement] = args;
          if (!(typeof pattern === 'string' || pattern instanceof RegExp) || typeof replacement !== 'string') return null;
          if (name === 'replaceAll' && pattern instanceof RegExp && !pattern.global) return null;
          return name === 'replace' ? value.replace(pattern, replacement) : value.replaceAll(pattern, replacement);
        }
        case 'slice':
        case 'substring': {
          if (args.some((a) => typeof a !== 'number')) return null;
          const [a, b] = args as number[];
          return name === 'slice' ? value.slice(a, b) : value.substring(a ?? 0, b);
        }
        default:
          return null;
      }
    };
    const strings: TemplateString[] = [];
    for (const s of receiver.strings) {
      const out = apply(s.chunks.map(chunkText).join(''));
      if (out === null) return null;
      strings.push({ chunks: [{ lit: out }], via: s.via, origin: s.origin });
    }
    return ok(strings);
  }

  /** The union of every `return` in a function body (or the expression body of an arrow). */
  private returns(fn: ts.SignatureDeclaration, env: Env, at: ts.Expression): Value {
    const body = (fn as ts.FunctionLikeDeclaration).body;
    if (!body) return this.fromType(at, env) ?? this.fail(env, 'dynamic', at, `${describeFunction(fn)} has no body in the program`, HINT_DECLARE);
    if (!ts.isBlock(body)) return this.value(body as ts.Expression, env);
    const results: ts.Expression[] = [];
    const visit = (node: ts.Node): void => {
      if (ts.isFunctionLike(node) && node !== fn) return;
      if (ts.isReturnStatement(node) && node.expression) results.push(node.expression);
      ts.forEachChild(node, visit);
    };
    visit(body);
    if (results.length === 0) return this.fail(env, 'dynamic', at, `${describeFunction(fn)} returns nothing`, HINT_DECLARE);
    const strings: TemplateString[] = [];
    for (const r of results) {
      const v = this.value(r, env);
      if (!v.ok) return v;
      strings.push(...v.strings.map((s) => ({ ...s, origin: 'return' as const })));
    }
    return ok(strings);
  }

  /** A declaration whose annotated type is a finite set of strings, or a template-literal type. */
  private fromDeclaredType(decl: ts.Declaration, at: ts.Expression, env: Env): Value | null {
    const typeNode = (decl as { type?: ts.TypeNode }).type;
    if (!typeNode) return null;
    return this.fromTypeObject(this.ctx.checker.getTypeFromTypeNode(typeNode), env, 'type');
  }

  /** The expression's own type, when it is a literal, a union of literals or a template-literal type. */
  private fromType(expr: ts.Expression, env: Env): Value | null {
    return this.fromTypeObject(this.ctx.checker.getTypeAtLocation(expr), env, 'type');
  }

  private fromTypeObject(type: ts.Type, env: Env, origin: Origin): Value | null {
    if (type.isStringLiteral()) return ok([{ chunks: [{ lit: type.value }], via: env.via, origin }]);
    if (type.flags & ts.TypeFlags.TemplateLiteral) {
      const tl = type as ts.TemplateLiteralType;
      let acc: readonly TemplateString[] = [{ chunks: [{ lit: tl.texts[0] ?? '' }], via: env.via, origin }];
      for (let i = 0; i < tl.types.length; i++) {
        const part = this.fromTypeObject(tl.types[i]!, env, origin) ?? ok([{ chunks: [{ dyn: true }], via: env.via, origin }]);
        if (!part.ok) return part;
        acc = this.product(acc, part.strings, origin, null);
        acc = acc.map((s) => ({ ...s, chunks: [...s.chunks, { lit: tl.texts[i + 1] ?? '' }] }));
      }
      return ok(acc);
    }
    if (type.isUnion()) {
      const strings: TemplateString[] = [];
      for (const member of type.types) {
        if (member.flags & (ts.TypeFlags.Undefined | ts.TypeFlags.Null)) continue;
        const v = this.fromTypeObject(member, env, origin);
        if (!v) return null;
        if (!v.ok) return v;
        strings.push(...v.strings);
      }
      return strings.length > 0 ? ok(strings) : null;
    }
    return null;
  }

  private product(left: readonly TemplateString[], right: readonly TemplateString[], origin: Origin, _at: ts.Node | null): TemplateString[] {
    const out: TemplateString[] = [];
    for (const l of left) {
      for (const r of right) {
        out.push({ chunks: [...l.chunks, ...r.chunks], via: mergeVia(l.via, r.via), origin: l.origin === 'literal' ? r.origin : l.origin === origin ? origin : l.origin });
      }
    }
    return out;
  }

  private tooMany(node: ts.Node): Unresolved {
    return { ok: false, reason: 'too-many-expansions', node, detail: `more than ${this.options.maxExpansions} combinations`, hint: 'use a wildcard-producing dynamic segment, raise maxExpansions, or ' + HINT_DECLARE };
  }

  private fail(env: Env, reason: UnresolvedReason, node: ts.Node, detail: string, hint: string): Value {
    if (env.dynamicOk && DYNAMIC_FALLBACK.has(reason)) return ok([{ chunks: [{ dyn: true }], via: env.via, origin: 'template' }]);
    return { ok: false, reason, detail, hint, node };
  }
}

function ok(strings: readonly TemplateString[]): Value {
  return { ok: true, strings };
}

function chunkText(c: Chunk): string {
  return 'lit' in c ? c.lit : 'svc' in c ? SERVICE_PLACEHOLDER : '';
}

function mergeVia(a: readonly Location[], b: readonly Location[]): Location[] {
  const out = [...a];
  for (const loc of b) if (!out.some((o) => o.file === loc.file && o.line === loc.line && o.col === loc.col)) out.push(loc);
  return out;
}

/**
 * Collapse identical results — the same pattern through the same chain of declarations.
 * The chain is part of the key: the same subject reached through two different subclasses
 * is two facts, each attributed to its own service, never one fact that belongs to neither.
 */
function dedupe(patterns: readonly ResolvedPattern[]): ResolvedPattern[] {
  const byKey = new Map<string, ResolvedPattern>();
  for (const p of patterns) {
    const key = `${p.pattern}|${p.via.map((v) => `${v.file}:${v.line}:${v.col}`).join(',')}`;
    const existing = byKey.get(key);
    if (!existing) byKey.set(key, p);
    else byKey.set(key, { ...existing, widened: existing.widened || p.widened });
  }
  return [...byKey.values()];
}

/** Strip parentheses, `as`, `satisfies`, `!` and `<T>` assertions. */
export function unwrap(expr: ts.Expression): ts.Expression {
  let current = expr;
  for (;;) {
    if (ts.isParenthesizedExpression(current) || ts.isAsExpression(current) || ts.isSatisfiesExpression(current) || ts.isNonNullExpression(current) || ts.isTypeAssertionExpression(current)) {
      current = current.expression;
      continue;
    }
    return current;
  }
}

function describeFunction(fn: ts.SignatureDeclaration): string {
  const name = (fn as { name?: ts.Node }).name?.getText();
  if (ts.isConstructorDeclaration(fn)) return `the constructor of ${ts.isClassLike(fn.parent) ? (fn.parent.name?.text ?? 'an anonymous class') : 'a class'}`;
  if (ts.isMethodDeclaration(fn) && ts.isClassLike(fn.parent)) return `${fn.parent.name?.text ?? '<anonymous>'}.${name ?? '<anonymous>'}()`;
  return `${name ?? '<anonymous function>'}()`;
}

/** The initializer of `name` in an object literal (shorthand `{ subject }` reads the binding). */
function objectMember(literal: ts.ObjectLiteralExpression, name: string): ts.Expression | null {
  for (const prop of literal.properties) {
    if (ts.isPropertyAssignment(prop) && prop.name.getText().replace(/^['"]|['"]$/g, '') === name) return prop.initializer;
    if (ts.isShorthandPropertyAssignment(prop) && prop.name.text === name) return prop.name;
  }
  return null;
}

function fmt(loc: Location): string {
  return `${loc.file}:${loc.line}:${loc.col}`;
}

/**
 * Turn chunks into a NATS pattern.
 *
 * Tokens are cut at every `.` in literal text. A token made only of dynamic
 * chunks becomes `*` — or `>` when it is the last token and `dynamicTail` is
 * `rest`. A token mixing literal text and a dynamic chunk cannot be expressed
 * as a permission (`DEVICE-*` is a literal) and is an error unless
 * `widenPartialTokens` turns the whole token into `*`.
 */
export function templateToPattern(
  chunks: readonly Chunk[],
  options: Pick<EvaluateOptions, 'widenPartialTokens' | 'dynamicTail'>,
): { readonly ok: true; readonly pattern: string; readonly widened: boolean } | { readonly ok: false; readonly reason: UnresolvedReason; readonly detail: string; readonly hint: string } {
  interface Token {
    text: string;
    dyn: boolean;
    lit: boolean;
  }
  const tokens: Token[] = [{ text: '', dyn: false, lit: false }];
  for (const chunk of chunks) {
    if ('dyn' in chunk) {
      tokens[tokens.length - 1]!.dyn = true;
      continue;
    }
    const text = 'svc' in chunk ? SERVICE_PLACEHOLDER : chunk.lit;
    const pieces = text.split('.');
    pieces.forEach((piece, i) => {
      if (i > 0) tokens.push({ text: '', dyn: false, lit: false });
      const token = tokens[tokens.length - 1]!;
      token.text += piece;
      if (piece.length > 0) token.lit = true;
    });
  }
  let widened = false;
  const rendered: string[] = [];
  const rendering = chunks.map((c) => ('lit' in c ? c.lit : 'svc' in c ? SERVICE_PLACEHOLDER : '${…}')).join('');
  tokens.forEach((token, i) => {
    const last = i === tokens.length - 1;
    if (token.dyn && token.lit) {
      if (!options.widenPartialTokens) {
        rendered.push('\u0000');
        return;
      }
      widened = true;
      rendered.push(last && options.dynamicTail === 'rest' ? '>' : '*');
      return;
    }
    if (token.dyn) {
      rendered.push(last && options.dynamicTail === 'rest' ? '>' : '*');
      return;
    }
    rendered.push(token.text);
  });
  if (rendered.includes('\u0000')) {
    return {
      ok: false,
      reason: 'partial-token',
      detail: `"${rendering}" mixes literal text and a dynamic value inside one token; NATS wildcards match whole tokens only`,
      hint: 'put the dynamic value in its own token (`PREFIX.${id}`), set widenPartialTokens to grant `*` for that token, or declare the pattern explicitly',
    };
  }
  if (tokens.every((t) => t.dyn && !t.lit)) {
    return {
      ok: false,
      reason: 'dynamic',
      detail: `"${rendering}" has no literal token; the only permission admitting it would be ">"`,
      hint: 'give the subject a literal prefix, or declare the pattern explicitly',
    };
  }
  const pattern = rendered.join('.');
  if (!isValidPattern(pattern.replaceAll(SERVICE_PLACEHOLDER, 'svc'))) {
    return { ok: false, reason: 'unsupported-syntax', detail: `"${rendering}" is not a valid NATS subject`, hint: 'subjects are non-empty dot-separated tokens without whitespace' };
  }
  return { ok: true, pattern, widened };
}
