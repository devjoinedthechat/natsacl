import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import ts from 'typescript';
import type { ShapeSpec } from './config.js';
import type { Location } from './model.js';
import { parseJsDocShape } from './shapes.js';

/**
 * One parsed TypeScript program plus the indexes the evaluator needs:
 * who calls which declaration, which classes extend or implement which, and
 * which declarations carry a `@natsacl` shape tag.
 *
 * The type checker is used for symbol resolution only; nothing here reports
 * type errors — a project that does not type-check still compiles to an ACL,
 * and the analyser says what it could not resolve rather than guessing.
 */
export interface ProgramContext {
  readonly program: ts.Program;
  readonly checker: ts.TypeChecker;
  readonly options: ts.CompilerOptions;
  readonly host: ts.CompilerHost;
  readonly tsconfig: string;
  /** Product source files: not declaration files, not under node_modules. */
  readonly sourceFiles: readonly ts.SourceFile[];
  /** Function/method/constructor declaration → the call or `new` expressions that resolve to it. */
  readonly callSites: ReadonlyMap<ts.Declaration, readonly ts.CallLikeExpression[]>;
  /** Class or interface declaration → classes that directly extend or implement it. */
  readonly subtypes: ReadonlyMap<ts.Declaration, readonly ts.ClassLikeDeclaration[]>;
  /** Declarations tagged `@natsacl <kind> …`. */
  readonly jsdocShapes: ReadonlyMap<ts.Declaration, ShapeSpec>;
  /** Declarations tagged `@natsacl service-name`: they evaluate to the running service's name. */
  readonly serviceNameDeclarations: ReadonlySet<ts.Declaration>;
}

export class ProgramError extends Error {
  override name = 'ProgramError';
}

export function createProgramContext(tsconfigPath: string, extraRootFiles: readonly string[] = []): ProgramContext {
  const tsconfig = resolve(tsconfigPath);
  if (!existsSync(tsconfig)) throw new ProgramError(`tsconfig not found: ${tsconfig}`);
  const read = ts.readConfigFile(tsconfig, ts.sys.readFile);
  if (read.error) throw new ProgramError(ts.flattenDiagnosticMessageText(read.error.messageText, '\n'));
  const parsed = ts.parseJsonConfigFileContent(read.config, ts.sys, dirname(tsconfig), undefined, tsconfig);
  const fatal = parsed.errors.filter((e) => e.category === ts.DiagnosticCategory.Error && e.code !== 18003);
  if (fatal.length > 0) throw new ProgramError(fatal.map((e) => ts.flattenDiagnosticMessageText(e.messageText, '\n')).join('\n'));

  const options: ts.CompilerOptions = { ...parsed.options, noEmit: true, skipLibCheck: true };
  const rootNames = [...new Set([...parsed.fileNames, ...extraRootFiles.map((f) => resolve(f))])];
  const host = ts.createCompilerHost(options, true);
  const program = ts.createProgram({ rootNames, options, host });
  const checker = program.getTypeChecker();
  const sourceFiles = program.getSourceFiles().filter((sf) => !sf.isDeclarationFile && !sf.fileName.includes('/node_modules/'));

  const callSites = new Map<ts.Declaration, ts.CallLikeExpression[]>();
  const subtypes = new Map<ts.Declaration, ts.ClassLikeDeclaration[]>();
  const jsdocShapes = new Map<ts.Declaration, ShapeSpec>();
  const serviceNameDeclarations = new Set<ts.Declaration>();

  const addCall = (decl: ts.Declaration | undefined, call: ts.CallLikeExpression): void => {
    if (!decl) return;
    const list = callSites.get(decl);
    if (list) {
      if (!list.includes(call)) list.push(call);
    } else callSites.set(decl, [call]);
  };

  for (const sf of sourceFiles) {
    const visit = (node: ts.Node): void => {
      if (ts.isCallExpression(node) || ts.isNewExpression(node)) {
        const sig = checker.getResolvedSignature(node);
        addCall(sig?.getDeclaration(), node);
        const callee = ts.isCallExpression(node) ? node.expression : node.expression;
        const nameNode = ts.isPropertyAccessExpression(callee) ? callee.name : callee;
        let symbol = checker.getSymbolAtLocation(nameNode);
        if (symbol && symbol.flags & ts.SymbolFlags.Alias) symbol = checker.getAliasedSymbol(symbol);
        if (ts.isNewExpression(node) && symbol?.valueDeclaration && ts.isClassLike(symbol.valueDeclaration)) {
          for (const member of symbol.valueDeclaration.members) if (ts.isConstructorDeclaration(member)) addCall(member, node);
        }
        for (const decl of symbol?.declarations ?? []) addCall(decl, node);
      }
      if (ts.isClassLike(node)) {
        for (const clause of node.heritageClauses ?? []) {
          for (const typeNode of clause.types) {
            let symbol = checker.getSymbolAtLocation(typeNode.expression);
            if (symbol && symbol.flags & ts.SymbolFlags.Alias) symbol = checker.getAliasedSymbol(symbol);
            for (const decl of symbol?.declarations ?? []) {
              if (!ts.isClassLike(decl) && !ts.isInterfaceDeclaration(decl)) continue;
              const list = subtypes.get(decl);
              if (list) list.push(node);
              else subtypes.set(decl, [node]);
            }
          }
        }
      }
      if (ts.isFunctionLike(node) || ts.isVariableDeclaration(node) || ts.isPropertyDeclaration(node) || ts.isPropertySignature(node) || ts.isPropertyAssignment(node)) {
        const tag = jsDocTagText(node);
        if (tag !== null) {
          if (tag.trim() === 'service-name') serviceNameDeclarations.add(node);
          else {
            const shape = parseJsDocShape(tag, declarationName(node));
            if (!shape) throw new ProgramError(`${formatNodeLocation(node)}: cannot parse @natsacl tag "${tag}"`);
            jsdocShapes.set(node, shape);
          }
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(sf);
  }

  return { program, checker, options, host, tsconfig, sourceFiles, callSites, subtypes, jsdocShapes, serviceNameDeclarations };
}

function jsDocTagText(node: ts.Node): string | null {
  for (const tag of ts.getJSDocTags(node)) {
    if (tag.tagName.text !== 'natsacl') continue;
    return typeof tag.comment === 'string' ? tag.comment : (tag.comment ?? []).map((c) => c.text).join('');
  }
  return null;
}

export function declarationName(node: ts.Node): string {
  const named = node as { name?: ts.Node };
  if (named.name && (ts.isIdentifier(named.name) || ts.isStringLiteral(named.name) || ts.isPrivateIdentifier(named.name))) return named.name.text;
  if (ts.isConstructorDeclaration(node)) return 'constructor';
  return '<anonymous>';
}

export function locationOf(node: ts.Node): Location {
  const sf = node.getSourceFile();
  const { line, character } = sf.getLineAndCharacterOfPosition(node.getStart(sf));
  return { file: sf.fileName, line: line + 1, col: character + 1 };
}

export function formatNodeLocation(node: ts.Node): string {
  const loc = locationOf(node);
  return `${loc.file}:${loc.line}:${loc.col}`;
}

/**
 * Every product file reachable from `entries` through static imports, re-exports,
 * `import()` and `require()` with literal specifiers. A service owns a broker
 * operation only when the file performing it (and every file its subject value
 * travelled through) is reachable from that service's entry.
 */
export function reachableFiles(ctx: ProgramContext, entries: readonly string[]): Set<string> {
  const product = new Set(ctx.sourceFiles.map((sf) => sf.fileName));
  const seen = new Set<string>();
  const queue: string[] = [];
  for (const entry of entries) {
    const file = resolve(entry);
    if (!product.has(file)) throw new ProgramError(`entry is not part of the program: ${file}`);
    queue.push(file);
  }
  while (queue.length > 0) {
    const file = queue.pop()!;
    if (seen.has(file)) continue;
    seen.add(file);
    const sf = ctx.program.getSourceFile(file);
    if (!sf) continue;
    for (const spec of moduleSpecifiersOf(sf)) {
      const resolved = ts.resolveModuleName(spec, file, ctx.options, ctx.host).resolvedModule;
      if (!resolved || resolved.isExternalLibraryImport) continue;
      const target = resolved.resolvedFileName;
      if (product.has(target) && !seen.has(target)) queue.push(target);
    }
  }
  return seen;
}

function moduleSpecifiersOf(sf: ts.SourceFile): string[] {
  const out: string[] = [];
  const visit = (node: ts.Node): void => {
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
      out.push(node.moduleSpecifier.text);
    } else if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference) && ts.isStringLiteral(node.moduleReference.expression)) {
      out.push(node.moduleReference.expression.text);
    } else if (ts.isCallExpression(node)) {
      const arg = node.arguments[0];
      const isImport = node.expression.kind === ts.SyntaxKind.ImportKeyword;
      const isRequire = ts.isIdentifier(node.expression) && node.expression.text === 'require';
      if ((isImport || isRequire) && arg && ts.isStringLiteralLike(arg)) out.push(arg.text);
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return out;
}

/** The symbol behind an identifier or property name, with import aliases followed. */
export function symbolOf(checker: ts.TypeChecker, node: ts.Node): ts.Symbol | undefined {
  let symbol = checker.getSymbolAtLocation(node);
  if (symbol && symbol.flags & ts.SymbolFlags.Alias) symbol = checker.getAliasedSymbol(symbol);
  return symbol;
}

/** Names of a type and everything it extends or implements, for receiver matching. */
export function typeNames(checker: ts.TypeChecker, type: ts.Type, seen = new Set<ts.Type>()): Set<string> {
  const names = new Set<string>();
  if (seen.has(type)) return names;
  seen.add(type);
  if (type.isUnion() || type.isIntersection()) {
    for (const t of type.types) for (const n of typeNames(checker, t, seen)) names.add(n);
    return names;
  }
  if (type.aliasSymbol) names.add(type.aliasSymbol.name);
  const symbol = type.getSymbol();
  if (symbol) {
    names.add(symbol.name);
    for (const decl of symbol.declarations ?? []) {
      if (!ts.isClassLike(decl) && !ts.isInterfaceDeclaration(decl)) continue;
      for (const clause of decl.heritageClauses ?? []) {
        for (const typeNode of clause.types) {
          for (const n of typeNames(checker, checker.getTypeAtLocation(typeNode), seen)) names.add(n);
        }
      }
    }
  }
  if (type.isClassOrInterface()) {
    for (const base of checker.getBaseTypes(type)) for (const n of typeNames(checker, base, seen)) names.add(n);
  }
  return names;
}

/** Declarations of the same-named member on every base class and implemented interface of `classDecl`. */
export function overriddenMembers(checker: ts.TypeChecker, classDecl: ts.ClassLikeDeclaration, memberName: string): ts.Declaration[] {
  const out: ts.Declaration[] = [];
  const seen = new Set<ts.Type>();
  const walk = (type: ts.Type): void => {
    if (seen.has(type)) return;
    seen.add(type);
    const prop = type.getProperty(memberName);
    for (const decl of prop?.declarations ?? []) if (!out.includes(decl)) out.push(decl);
    if (type.isClassOrInterface()) for (const base of checker.getBaseTypes(type)) walk(base);
    for (const decl of type.getSymbol()?.declarations ?? []) {
      if (!ts.isClassLike(decl) && !ts.isInterfaceDeclaration(decl)) continue;
      for (const clause of decl.heritageClauses ?? []) for (const typeNode of clause.types) walk(checker.getTypeAtLocation(typeNode));
    }
  };
  for (const clause of classDecl.heritageClauses ?? []) for (const typeNode of clause.types) walk(checker.getTypeAtLocation(typeNode));
  return out;
}

/** Every class that transitively extends or implements `decl`. */
export function allSubtypes(ctx: ProgramContext, decl: ts.Declaration): ts.ClassLikeDeclaration[] {
  const out: ts.ClassLikeDeclaration[] = [];
  const queue = [...(ctx.subtypes.get(decl) ?? [])];
  while (queue.length > 0) {
    const next = queue.shift()!;
    if (out.includes(next)) continue;
    out.push(next);
    queue.push(...(ctx.subtypes.get(next) ?? []));
  }
  return out;
}
