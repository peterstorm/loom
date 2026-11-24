/**
 * The one Java syntax seam (issue #254): the only module that reads Java text,
 * beside the two TypeScript compiler seams (ADR-0042, ADR-0053). Pure and
 * parse-only: it reads text it is handed and returns data; it never touches
 * the filesystem, a program, a classpath or the clock.
 *
 * The parser is `java-parser` 3.0.1 (Chevrotain, a pure-JavaScript grammar for
 * Java 21: generics, lambdas, switch expressions and patterns, records,
 * sealed types, text blocks). It is required on first use, not imported: every
 * edit's lint hook and every helper process loads the engine, and a Java
 * grammar is only paid for by the obligation that reads Java (ADR-0102; the
 * linter's compiler seam takes the same measure, ADR-0095). The two runtime
 * paths this repository pins, Node 22.23 and Bun 1.4, both load it.
 *
 * `parseJava` returns the whole projection owner verification needs, in one
 * read:
 * - `packageName` and `imports`, for Java's reach rule: Java has no
 *   re-exports, so a due file is reached by an explicit class import, a
 *   static import of one of its members, a wildcard import whose package it
 *   belongs to and whose simple name the test uses, or the same package with
 *   its simple name used (no import needed);
 * - `identifiers` and `qualifiedNames`, the names used outside `package` and
 *   `import` declarations, which is what "its simple name is used" and a
 *   fully-qualified use without an import both read;
 * - `sites`, every mutation site the operators offer, as UTF-16 spans of the
 *   original text (Chevrotain offsets are string indices, so non-ASCII text
 *   needs no byte mapping). The operator set is a parameter of the plan, not
 *   of this seam: `guard-removal` is reported here too, and the Task mutation
 *   check's set alone selects it.
 *
 * An input the grammar refuses is one `java-syntax-error` diagnostic, never a
 * recovered tree: the caller reports `owner-unparseable` and mutates nothing.
 * A Java source that spells an identifier or keyword with `\uXXXX` escapes is
 * refused the same way (javac decodes the escapes before lexing, and the
 * grammar reads raw text), so failing closed never turns a real file into a
 * plan built from text the compiler would read differently.
 */

import { createRequire } from "node:module";
import type { CstNode, IToken } from "java-parser";
import { failure, nonEmptyOf, success, type DomainResult, type NonEmpty } from "../orchestration-contract/identity";
import type { TaskMutationOperator } from "./types";

// ---------------------------------------------------------------------------
// The seam's surface
// ---------------------------------------------------------------------------

/** Why Java text yields no projection: the grammar refused it, with the parser's own diagnostics. */
export type JavaSyntaxError = Readonly<{ kind: "java-syntax-error"; diagnostics: NonEmpty<string> }>;

/**
 * One Java import, as the reach rule reads it:
 * - `class`: `import p.C;` (a nested class stays in the same file);
 * - `static-member`: `import static p.C.m;`, whose owner is `p.C`;
 * - `class-wildcard`: `import p.*;`, which reaches a class only when its
 *   simple name is used;
 * - `static-wildcard`: `import static p.C.*;`, which names `p.C` itself.
 */
export type JavaImport =
  | Readonly<{ kind: "class"; name: string }>
  | Readonly<{ kind: "static-member"; owner: string }>
  | Readonly<{ kind: "class-wildcard"; packageName: string }>
  | Readonly<{ kind: "static-wildcard"; owner: string }>;

/**
 * One mutation site: the operator, the replaced span of the original text
 * (`[start, end)`, UTF-16), and the replacement text. The plan decides which
 * sites are candidates (the operator set, the changed lines, the cap).
 */
export type JavaMutationSite = Readonly<{
  operator: TaskMutationOperator;
  start: number;
  end: number;
  replacement: string;
}>;

/** One Java file's projection: its package, imports, used names and mutation sites. */
export type JavaFile = Readonly<{
  packageName: string | null;
  imports: readonly JavaImport[];
  identifiers: ReadonlySet<string>;
  /** Every dotted chain the file writes outside its package and import declarations, e.g. `p.C` in `new p.C()`. */
  qualifiedNames: ReadonlySet<string>;
  sites: readonly JavaMutationSite[];
}>;

// ---------------------------------------------------------------------------
// The parser, required on first use
// ---------------------------------------------------------------------------

const require = createRequire(import.meta.url);

type ParserModule = Readonly<{ parse: (text: string) => CstNode }>;

/**
 * `java-parser` as the parser module. The cast is the one place the pinned
 * package's untrusted CommonJS export enters: `createRequire` hands back
 * `any`, so the value is read as `unknown` and only `parse`'s presence is
 * proved before the module's own `.d.ts` type is applied.
 */
function parserModule(): ParserModule {
  const loaded: unknown = require("java-parser");
  if (typeof loaded !== "object" || loaded === null || !("parse" in loaded) || typeof loaded.parse !== "function") {
    throw new Error("java-parser exports no parse function");
  }
  return loaded as ParserModule;
}

// ---------------------------------------------------------------------------
// The CST, read by location
// ---------------------------------------------------------------------------

/** One element of the CST: a rule node or a token. */
type SyntaxElement = CstNode | IToken;

const isToken = (element: SyntaxElement): element is IToken => "image" in element;

const isRule = (element: SyntaxElement): element is CstNode => !isToken(element);

const childrenOf = (node: CstNode, key: string): readonly SyntaxElement[] => node.children[key] ?? [];

const rulesUnder = (node: CstNode, key: string): readonly CstNode[] => childrenOf(node, key).filter(isRule);

const tokensUnder = (node: CstNode, key: string): readonly IToken[] => childrenOf(node, key).filter(isToken);


const ruleChildren = (node: CstNode): readonly CstNode[] =>
  Object.values(node.children).flat().flatMap((element) => (isRule(element) ? [element] : []));

/** Every token in a subtree, in grammar order. */
function tokensOf(node: CstNode): readonly IToken[] {
  const tokens: IToken[] = [];
  const visit = (current: CstNode): void => {
    for (const element of Object.values(current.children).flat()) {
      if (isToken(element)) tokens.push(element);
      else visit(element);
    }
  };
  visit(node);
  return tokens;
}

const byStart = (left: IToken, right: IToken): number => left.startOffset - right.startOffset;

/** A node's or token's span in the text, its location's inclusive end made exclusive. */
const spanOf = (element: CstNode | IToken): Readonly<{ start: number; end: number }> =>
  isToken(element)
    ? Object.freeze({ start: element.startOffset, end: element.endOffset + 1 })
    : Object.freeze({ start: element.location.startOffset, end: element.location.endOffset + 1 });

/** The text one node (or token) spans. */
const textOf = (node: CstNode | IToken, text: string): string => {
  const span = spanOf(node);
  return text.slice(span.start, span.end);
};

// ---------------------------------------------------------------------------
// Package, imports and identifiers
// ---------------------------------------------------------------------------

const ordinaryUnitOf = (root: CstNode): CstNode | undefined =>
  rulesUnder(root, "ordinaryCompilationUnit")[0] ?? (root.name === "ordinaryCompilationUnit" ? root : undefined);

/** The qualified name `packageOrTypeName` (or `packageDeclaration`) spells: its identifier tokens in source order. */
const qualifiedNameOf = (node: CstNode): string =>
  [...tokensOf(node)]
    .sort(byStart)
    .filter((token) => token.tokenType.name === "Identifier")
    .map((token) => token.image)
    .join(".");

/** One `import` declaration as the reach rule reads it; the grammar guarantees the qualified name. */
function importOf(declaration: CstNode): JavaImport | undefined {
  const qualified = rulesUnder(declaration, "packageOrTypeName")[0];
  if (qualified === undefined) return undefined;
  const name = qualifiedNameOf(qualified);
  const isStatic = tokensUnder(declaration, "Static").length > 0;
  const isWildcard = tokensUnder(declaration, "Star").length > 0;
  if (isStatic) {
    return isWildcard
      ? { kind: "static-wildcard", owner: name }
      : { kind: "static-member", owner: name.split(".").slice(0, -1).join(".") };
  }
  return isWildcard ? { kind: "class-wildcard", packageName: name } : { kind: "class", name };
}

const importsOf = (unit: CstNode): readonly JavaImport[] =>
  childrenOf(unit, "importDeclaration").flatMap((element) => {
    const parsed = isRule(element) ? importOf(element) : undefined;
    return parsed === undefined ? [] : [parsed];
  });

/**
 * The names a file uses outside its package and import declarations: every
 * identifier, and every dotted chain of identifiers (a package-qualified type,
 * a receiver and its method). A chain is what a fully-qualified use without an
 * import looks like.
 */
type Uses = Readonly<{ identifiers: ReadonlySet<string>; qualifiedNames: ReadonlySet<string> }>;

const isIdentifier = (token: IToken): boolean => token.tokenType.name === "Identifier";

function usesOf(unit: CstNode): Uses {
  const tokens: IToken[] = [];
  const visit = (node: CstNode): void => {
    if (node.name === "importDeclaration" || node.name === "packageDeclaration") return;
    for (const element of Object.values(node.children).flat()) {
      if (isToken(element)) tokens.push(element);
      else visit(element);
    }
  };
  visit(unit);
  const ordered = [...tokens].sort(byStart);
  const qualifiedNames = new Set<string>();
  let chain: string[] = [];
  let afterDot = false;
  const flush = (): void => {
    if (chain.length > 1) qualifiedNames.add(chain.join("."));
    chain = [];
    afterDot = false;
  };
  for (const token of ordered) {
    if (isIdentifier(token)) {
      chain.push(token.image);
      afterDot = false;
    } else if (token.image === "." && chain.length > 0 && !afterDot) {
      afterDot = true;
    } else {
      flush();
    }
  }
  flush();
  return Object.freeze({ identifiers: new Set(ordered.filter(isIdentifier).map((token) => token.image)), qualifiedNames });
}

// ---------------------------------------------------------------------------
// Mutation sites
// ---------------------------------------------------------------------------

const NUMERIC_PRIMITIVES: ReadonlySet<string> = new Set(["byte", "short", "int", "long", "char", "float", "double"]);

const COMPARISON_FLIPS: ReadonlyMap<string, string> = new Map([
  ["<", ">="],
  [">=", "<"],
  [">", "<="],
  ["<=", ">"],
  ["==", "!="],
  ["!=", "=="],
]);

const LOGICAL_SWAPS: ReadonlyMap<string, string> = new Map([
  ["&&", "||"],
  ["||", "&&"],
]);

const EXIT_KEYWORDS: ReadonlySet<string> = new Set(["return", "throw", "break", "continue"]);

/** How a method's declared return type decides what a replaced return value may be. */
type ReturnKind = "void" | "boolean" | "numeric" | "reference";

/** Where the walk is: inside a method body (its result known), a lambda, or neither. */
type Context =
  | Readonly<{ kind: "method"; result: ReturnKind }>
  | Readonly<{ kind: "lambda" }>
  | Readonly<{ kind: "other" }>;

const OTHER: Context = Object.freeze({ kind: "other" });
const LAMBDA: Context = Object.freeze({ kind: "lambda" });

/**
 * A method's declared return type, from its header's `result` node. The last
 * token names the type (an annotation's name can precede it); an array is a
 * reference type whatever its element is. Anything not provably a primitive is
 * a reference type, whose replacement is `null`.
 */
function returnKindOf(method: CstNode): ReturnKind {
  const header = rulesUnder(method, "methodHeader")[0];
  const result = header === undefined ? undefined : rulesUnder(header, "result")[0];
  if (result === undefined) return "reference";
  const tokens = [...tokensOf(result)].sort(byStart);
  if (tokens.some((token) => token.image === "[" || token.image === "]")) return "reference";
  const last = tokens.at(-1)?.image;
  if (last === "void") return "void";
  if (last === "boolean") return "boolean";
  return last !== undefined && NUMERIC_PRIMITIVES.has(last) ? "numeric" : "reference";
}

/** The return-value replacement the declared type allows; null for a void method. */
const returnReplacement = (kind: ReturnKind, original: string): string | null =>
  kind === "void" ? null
  : kind === "boolean" ? `!(${original})`
  : kind === "numeric" ? "0"
  : "null";

/** The first token's kind, in source order: a block starts with `{`, a statement with its keyword. */
const startsWithExit = (blockStatement: CstNode): boolean => {
  const [first] = [...tokensOf(blockStatement)].sort(byStart);
  return first !== undefined && EXIT_KEYWORDS.has(first.image);
};

/** The grammar's wrapper rules between a guard and its body: the block or the statement is their only child. */
const STATEMENT_WRAPPERS: ReadonlySet<string> = new Set(["statement", "statementNoShortIf", "statementWithoutTrailingSubstatement"]);

/** The body itself, with the wrappers taken off: a block, a return, an if, or whatever the statement holds. */
const statementCore = (body: CstNode): CstNode => {
  let current = body;
  while (STATEMENT_WRAPPERS.has(current.name)) {
    const [only] = ruleChildren(current);
    if (only === undefined) break;
    current = only;
  }
  return current;
};

/** Whether a guard's body only exits: one exit statement, or a block whose every statement is one. */
function isExitOnly(body: CstNode): boolean {
  const core = statementCore(body);
  if (core.name === "block") {
    const statements = rulesUnder(core, "blockStatements")[0];
    const entries = statements === undefined ? [] : rulesUnder(statements, "blockStatement");
    return entries.length > 0 && entries.every(startsWithExit);
  }
  return startsWithExit(body);
}

/** The one direct child rule with this name, when there is exactly one. */
const oneRule = (node: CstNode, key: string): CstNode | undefined => {
  const [first, second] = rulesUnder(node, key);
  return second === undefined ? first : undefined;
};

type Site = JavaMutationSite;

/** The rules that declare a pattern variable, which a negated condition would put out of scope. */
const PATTERN_RULES: ReadonlySet<string> = new Set(["typePattern", "recordPattern"]);

/** Whether a subtree declares a pattern variable (`o instanceof String s`, `p instanceof Point(int x, int y)`). */
const declaresPattern = (node: CstNode): boolean =>
  PATTERN_RULES.has(node.name) || ruleChildren(node).some(declaresPattern);

/** The condition a node guards on, when negating it is one of the sites this reader offers. */
function conditionOf(node: CstNode): CstNode | undefined {
  if (["ifStatement", "whileStatement", "doStatement", "basicForStatement"].includes(node.name)) {
    return oneRule(node, "expression");
  }
  if (node.name !== "conditionalExpression" || tokensUnder(node, "QuestionMark").length === 0) return undefined;
  return oneRule(node, "binaryExpression");
}

function conditionSites(node: CstNode, text: string): readonly Site[] {
  const condition = conditionOf(node);
  // A pattern variable is in scope in the statement the condition guards; negating
  // the condition would leave that statement referring to it out of scope, so the
  // negated text would not compile. Such a condition offers no negation site.
  if (condition === undefined || declaresPattern(condition)) return [];
  const span = spanOf(condition);
  return [{ operator: "condition-negation", ...span, replacement: `!(${textOf(condition, text)})` }];
}

function guardSites(node: CstNode): readonly Site[] {
  if (node.name !== "ifStatement" || tokensUnder(node, "Else").length > 0) return [];
  const [body, extra] = rulesUnder(node, "statement");
  if (body === undefined || extra !== undefined) return [];
  if (!isExitOnly(body)) return [];
  return [{ operator: "guard-removal", ...spanOf(node), replacement: ";" }];
}

function operatorSites(node: CstNode): readonly Site[] {
  const operatorTokens = tokensUnder(node, "BinaryOperator").flatMap((token): readonly Site[] => {
    const flipped = COMPARISON_FLIPS.get(token.image);
    const swapped = LOGICAL_SWAPS.get(token.image);
    return [
      ...(flipped === undefined ? [] : [{ operator: "comparison-flip" as const, ...spanOf(token), replacement: flipped }]),
      ...(swapped === undefined ? [] : [{ operator: "logical-swap" as const, ...spanOf(token), replacement: swapped }]),
    ];
  });
  const literalTokens = [...tokensUnder(node, "True"), ...tokensUnder(node, "False")].map((token): Site => ({
    operator: "boolean-literal-flip",
    ...spanOf(token),
    replacement: token.image === "true" ? "false" : "true",
  }));
  return [...operatorTokens, ...literalTokens];
}

function statementSites(node: CstNode, context: Context, text: string): readonly Site[] {
  if (node.name === "expressionStatement") return [{ operator: "statement-removal", ...spanOf(node), replacement: ";" }];
  if (node.name !== "returnStatement" || context.kind !== "method") return [];
  const expression = oneRule(node, "expression");
  if (expression === undefined) return [];
  const replacement = returnReplacement(context.result, textOf(expression, text));
  return replacement === null ? [] : [{ operator: "return-value-replacement", ...spanOf(expression), replacement }];
}

const contextOf = (node: CstNode, parent: Context): Context =>
  node.name === "methodDeclaration" ? Object.freeze({ kind: "method", result: returnKindOf(node) })
  : node.name === "lambdaExpression" ? LAMBDA
  : parent;

/** Every mutation site of one file, in source order. */
function sitesOf(root: CstNode, text: string): readonly Site[] {
  const sites: Site[] = [];
  const visit = (node: CstNode, context: Context): void => {
    const inner = contextOf(node, context);
    sites.push(...conditionSites(node, text), ...operatorSites(node), ...statementSites(node, inner, text), ...guardSites(node));
    for (const child of ruleChildren(node)) visit(child, inner);
  };
  visit(root, OTHER);
  return sites.sort((left, right) => left.start - right.start);
}

// ---------------------------------------------------------------------------
// The entry point
// ---------------------------------------------------------------------------

const diagnosticOf = (cause: unknown): string => {
  const message = cause instanceof Error ? cause.message : String(cause);
  return message.replace(/\s*\n\s*/gu, " ").trim();
};

/**
 * The one Java read: the file's package, imports, used identifiers and
 * mutation sites, or the grammar's refusal. Total: a refused input is data,
 * never a throw.
 */
export const parseJava = (text: string): DomainResult<JavaFile, JavaSyntaxError> => {
  let root: CstNode;
  try {
    root = parserModule().parse(text);
  } catch (cause) {
    return failure(Object.freeze({ kind: "java-syntax-error", diagnostics: nonEmptyOf(diagnosticOf(cause)) }));
  }
  const unit = ordinaryUnitOf(root) ?? root;
  const packageDeclaration = rulesUnder(unit, "packageDeclaration")[0];
  const uses = usesOf(unit);
  return success(Object.freeze({
    packageName: packageDeclaration === undefined ? null : qualifiedNameOf(packageDeclaration),
    imports: Object.freeze(importsOf(unit)),
    identifiers: uses.identifiers,
    qualifiedNames: uses.qualifiedNames,
    sites: Object.freeze(sitesOf(root, text)),
  }));
};
