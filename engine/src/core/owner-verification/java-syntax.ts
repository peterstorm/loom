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
 * A name is every token the grammar files under its `Identifier` category, not
 * only the plain `Identifier` token: a contextual keyword (`record`, `module`,
 * `open`, `to`, `with`, `var`, `sealed`, …) is its own token type in that
 * category, and javac reads it as a name wherever it is not in keyword
 * position. A package `p.record` is `p.record`, never `p`.
 *
 * A mutant that javac rejects observes the compiler instead of the owner's
 * behaviour. This seam re-parses no mutant and resolves no symbol, so it cannot
 * prove a mutant compiles; it withholds every site it knows javac rejects:
 * - a condition-negation or any boolean site on the condition of a `while` or
 *   `for` that is the constant `true` (the flipped body is unreachable);
 * - every site that starts inside the `try` block of a `try` whose handlers
 *   catch (a removed statement can leave a handler unreachable);
 * - a condition-negation, a guard-removal or a logical-swap over an expression
 *   that declares a pattern variable (`o instanceof String s`): each would put
 *   the variable out of scope, or not definitely matched, where it is used;
 * - a statement-removal of a plain `=` assignment in a constructor or an
 *   initializer block (it may be a final field's one assignment), or of one
 *   whose target is a local declared with no initializer (it may be that
 *   local's definite assignment);
 * - a guard-removal of a `break` guard inside a loop whose condition is absent
 *   or the constant `true` (the code after the loop becomes unreachable);
 * - a return whose replacement the text already spells (`return null;` in a
 *   reference method), which would mutate the owner into itself and report a
 *   survivor nothing can kill.
 * A mutant javac still rejects for a reason no rule here reads is an invalid
 * run, never a kill (`outcome.ts`).
 *
 * An input the grammar refuses is one `java-syntax-error` diagnostic, never a
 * recovered tree: the caller reports `owner-unparseable` and mutates nothing.
 * Only the grammar's own verdict becomes that refusal: a grammar that cannot
 * load, and any other internal error, escapes as a throw the shell names
 * `unexpected-error`, so a broken install is never reported as the owner's
 * syntax.
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
 * - `class-wildcard`: `import p.*;` (a package, which reaches a class only when
 *   its simple name is used) or `import p.C.*;` (a type's member types, which
 *   names `p.C` itself);
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

const LEXING_REFUSAL = /lexing errors detected/u;
const PARSING_REFUSAL = /parsing errors detected/u;

/**
 * Whether a message thrown out of `parse` is the grammar's own refusal, as
 * `java-parser` composes it. Anything else is not a verdict on the text:
 * loading a module cannot fail because a file has a syntax error, and a parser
 * bug is not one either.
 */
export const isGrammarRefusal = (message: string): boolean => LEXING_REFUSAL.test(message) || PARSING_REFUSAL.test(message);

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

/**
 * Every token in a subtree, in source order, leaving out the subtrees `skip`
 * names. Chevrotain groups a node's children by rule key, so the walk alone
 * is not source order: the tokens are sorted by offset.
 */
function tokensOf(node: CstNode, skip: (rule: CstNode) => boolean = () => false): readonly IToken[] {
  const tokens: IToken[] = [];
  const visit = (current: CstNode): void => {
    if (skip(current)) return;
    for (const element of Object.values(current.children).flat()) {
      if (isToken(element)) tokens.push(element);
      else visit(element);
    }
  };
  visit(node);
  return tokens.sort((left, right) => left.startOffset - right.startOffset);
}

/** Every rule in a subtree with this name, the subtree's root included. */
function rulesNamed(root: CstNode, name: string): readonly CstNode[] {
  const found: CstNode[] = [];
  const visit = (node: CstNode): void => {
    if (node.name === name) found.push(node);
    for (const child of ruleChildren(node)) visit(child);
  };
  visit(root);
  return found;
}

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

const IDENTIFIER = "Identifier";

/**
 * Whether a token is a name: the plain `Identifier` token, or a contextual
 * keyword (`record`, `module`, `var`, …), which the grammar lexes as its own
 * token type filed under the `Identifier` category.
 */
const isIdentifier = (token: IToken): boolean =>
  token.tokenType.name === IDENTIFIER || (token.tokenType.CATEGORIES ?? []).some((category) => category.name === IDENTIFIER);

const ordinaryUnitOf = (root: CstNode): CstNode | undefined =>
  rulesUnder(root, "ordinaryCompilationUnit")[0] ?? (root.name === "ordinaryCompilationUnit" ? root : undefined);

/** The qualified name `packageOrTypeName` (or `packageDeclaration`) spells: its name tokens in source order. */
const qualifiedNameOf = (node: CstNode): string =>
  tokensOf(node)
    .filter(isIdentifier)
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
  rulesUnder(unit, "importDeclaration").flatMap((declaration) => {
    const parsed = importOf(declaration);
    return parsed === undefined ? [] : [parsed];
  });

/**
 * The names a file uses outside its package and import declarations: every
 * identifier, and every dotted chain of identifiers (a package-qualified type,
 * a receiver and its method). A chain is what a fully-qualified use without an
 * import looks like.
 */
type Uses = Readonly<{ identifiers: ReadonlySet<string>; qualifiedNames: ReadonlySet<string> }>;

const isDeclarationHeader = (node: CstNode): boolean => node.name === "importDeclaration" || node.name === "packageDeclaration";

function usesOf(unit: CstNode): Uses {
  const ordered = tokensOf(unit, isDeclarationHeader);
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
      // Two identifiers side by side are separate names (`String d()` is a type and
      // a method), never one dotted chain: only a `.` joins two.
      if (chain.length > 0 && !afterDot) flush();
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

/** What the walk knows at a node, for the site rules that depend on where the node sits. */
type Context = Readonly<{
  /** The enclosing method's declared return kind; null where a `return` is not a method's (a lambda, a constructor, an initializer, a field). */
  returns: ReturnKind | null;
  /** Inside a constructor or an initializer block, where a plain assignment may be a final field's one assignment. */
  initializing: boolean;
  /** The enclosing body's locals declared with no initializer: an assignment to one may be its definite assignment. */
  blankLocals: ReadonlySet<string>;
  /** Inside a loop whose condition is absent or the constant `true`, where a `break` may be the loop's only way out. */
  endlessLoop: boolean;
}>;

const OUTSIDE_BODIES: Context = Object.freeze({ returns: null, initializing: false, blankLocals: new Set<string>(), endlessLoop: false });

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
  const tokens = tokensOf(result);
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

/** Whether a block statement's first token is an exit keyword: `return`, `throw`, `break` or `continue`. */
const startsWithExit = (blockStatement: CstNode): boolean => {
  const [first] = tokensOf(blockStatement);
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

function guardSites(node: CstNode, context: Context): readonly Site[] {
  if (node.name !== "ifStatement" || tokensUnder(node, "Else").length > 0) return [];
  const [body, extra] = rulesUnder(node, "statement");
  if (body === undefined || extra !== undefined || !isExitOnly(body)) return [];
  // `if (!(o instanceof String s)) return;` puts `s` in scope after the guard;
  // removing the guard leaves every later use of `s` undeclared.
  const condition = oneRule(node, "expression");
  if (condition === undefined || declaresPattern(condition)) return [];
  // In an endless loop a `break` guard may be the loop's only way out; without it
  // the code after the loop is unreachable, which javac rejects.
  if (context.endlessLoop && tokensOf(body).some((token) => token.image === "break")) return [];
  return [{ operator: "guard-removal", ...spanOf(node), replacement: ";" }];
}

function operatorSites(node: CstNode): readonly Site[] {
  // `o instanceof String s && s.isEmpty()` uses `s` where `&&` has matched it;
  // `||` would leave it not definitely matched there.
  const swaps = !declaresPattern(node);
  const operatorTokens = tokensUnder(node, "BinaryOperator").flatMap((token): readonly Site[] => {
    const flipped = COMPARISON_FLIPS.get(token.image);
    const swapped = swaps ? LOGICAL_SWAPS.get(token.image) : undefined;
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

/** A plain name, as an assignment's target spells a local or a field without a receiver. */
const PLAIN_NAME = /^[\p{L}_$][\p{L}\p{N}_$]*$/u;

/** The target an expression statement assigns with a plain `=`, as written; null for any other statement. */
function assignedTargetOf(statement: CstNode, text: string): string | null {
  const [expression] = rulesNamed(statement, "binaryExpression");
  if (expression === undefined || !tokensUnder(expression, "AssignmentOperator").some((token) => token.image === "=")) return null;
  const target = rulesUnder(expression, "unaryExpression")[0];
  return target === undefined ? null : textOf(target, text).trim();
}

/**
 * Whether removing an expression statement leaves the file compiling, as far
 * as this reader can tell: not a plain assignment that may be a final field's
 * one assignment (in a constructor or an initializer) or a blank local's
 * definite assignment.
 */
function isRemovable(statement: CstNode, context: Context, text: string): boolean {
  const target = assignedTargetOf(statement, text);
  if (target === null) return true;
  if (context.initializing) return false;
  return !(PLAIN_NAME.test(target) && context.blankLocals.has(target));
}

function statementSites(node: CstNode, context: Context, text: string): readonly Site[] {
  if (node.name === "expressionStatement") {
    return isRemovable(node, context, text) ? [{ operator: "statement-removal", ...spanOf(node), replacement: ";" }] : [];
  }
  if (node.name !== "returnStatement" || context.returns === null) return [];
  const expression = oneRule(node, "expression");
  if (expression === undefined) return [];
  const original = textOf(expression, text);
  const replacement = returnReplacement(context.returns, original);
  // A replacement the owner already spells mutates nothing: it would report a
  // survivor no matrix test could ever kill.
  return replacement === null || replacement === original.trim()
    ? []
    : [{ operator: "return-value-replacement", ...spanOf(expression), replacement }];
}

/** The rules that declare a method whose body a `return` sits in, class or interface. */
const METHOD_DECLARATIONS: ReadonlySet<string> = new Set(["methodDeclaration", "interfaceMethodDeclaration"]);

/** The rules whose body may hold a final field's one assignment. */
const INITIALIZING_DECLARATIONS: ReadonlySet<string> = new Set(["constructorDeclaration", "instanceInitializer", "staticInitializer"]);

/** The locals a body declares with no initializer (`int y;`), by name. */
const blankLocalsOf = (body: CstNode): ReadonlySet<string> =>
  new Set(rulesNamed(body, "localVariableDeclaration").flatMap((declaration) =>
    rulesNamed(declaration, "variableDeclarator")
      .filter((declarator) => tokensUnder(declarator, "Equals").length === 0)
      .flatMap((declarator) => {
        const id = rulesUnder(declarator, "variableDeclaratorId")[0];
        const name = id === undefined ? undefined : tokensOf(id).find(isIdentifier)?.image;
        return name === undefined ? [] : [name];
      })));

/** Whether a condition is the constant `true` (parens and negations aside), which a loop cannot flip. */
const isConstantTrue = (text: string): boolean => /^[()!\s]*true[()\s]*$/u.test(text);

/** Whether a loop's condition is absent (`for (;;)`) or the constant `true`, so only a `break` or an exit leaves it. */
function isEndlessLoop(node: CstNode, text: string): boolean {
  if (node.name !== "whileStatement" && node.name !== "doStatement" && node.name !== "basicForStatement") return false;
  const condition = oneRule(node, "expression");
  if (condition === undefined) return node.name === "basicForStatement";
  return isConstantTrue(textOf(condition, text));
}

const contextOf = (node: CstNode, parent: Context, text: string): Context => {
  if (METHOD_DECLARATIONS.has(node.name)) {
    return Object.freeze({ returns: returnKindOf(node), initializing: false, blankLocals: blankLocalsOf(node), endlessLoop: false });
  }
  if (INITIALIZING_DECLARATIONS.has(node.name)) {
    return Object.freeze({ returns: null, initializing: true, blankLocals: blankLocalsOf(node), endlessLoop: false });
  }
  if (node.name === "lambdaExpression") return Object.freeze({ ...parent, returns: null, endlessLoop: false });
  if (isEndlessLoop(node, text)) return Object.freeze({ ...parent, endlessLoop: true });
  return parent;
};

/** A span of the original text, `[start, end)`; a site must start outside the excluded ones. */
type Span = Readonly<{ start: number; end: number }>;

const withinSpans = (spans: readonly Span[], offset: number): boolean =>
  spans.some((span) => offset >= span.start && offset < span.end);

/**
 * The spans no site may start in, because its mutant would not compile: a
 * `while` or `for` condition that is the constant `true` (the negated or
 * flipped body is unreachable), and the whole `try` block of a `try` whose
 * handlers catch, nested statements included (a removed statement can make a
 * handler unreachable).
 */
function exclusionSpansOf(root: CstNode, text: string): readonly Span[] {
  const spans: Span[] = [];
  const visit = (node: CstNode): void => {
    if (node.name === "whileStatement" || node.name === "basicForStatement") {
      const condition = oneRule(node, "expression");
      if (condition !== undefined && isConstantTrue(textOf(condition, text))) spans.push(spanOf(condition));
    }
    const isTry = node.name === "tryStatement" || node.name === "tryWithResourcesStatement";
    if (isTry && childrenOf(node, "catches").length > 0) {
      const block = oneRule(node, "block");
      if (block !== undefined) spans.push(spanOf(block));
    }
    for (const child of ruleChildren(node)) visit(child);
  };
  visit(root);
  return spans;
}

/** Every mutation site of one file, in source order, that this reader does not know javac rejects. */
function sitesOf(root: CstNode, text: string): readonly Site[] {
  const excluded = exclusionSpansOf(root, text);
  const sites: Site[] = [];
  const visit = (node: CstNode, context: Context): void => {
    const inner = contextOf(node, context, text);
    const offered = [
      ...conditionSites(node, text),
      ...operatorSites(node),
      ...statementSites(node, inner, text),
      ...guardSites(node, inner),
    ];
    sites.push(...offered.filter((site) => !withinSpans(excluded, site.start)));
    for (const child of ruleChildren(node)) visit(child, inner);
  };
  visit(root, OUTSIDE_BODIES);
  return sites.sort((left, right) => left.start - right.start);
}

// ---------------------------------------------------------------------------
// The entry point
// ---------------------------------------------------------------------------

/** How much of the parser's own wording one gate diagnostic carries: a position and what failed, not a token dump. */
const DIAGNOSTIC_LIMIT = 300;

/** The parser's position, or the end of the input where the parser itself reports `NaN`. */
const positionText = (line: string | undefined, column: string | undefined): string =>
  line === undefined || column === undefined || line === "NaN" || column === "NaN"
    ? "at the end of the input"
    : `at line ${line}, column ${column}`;

/**
 * A parsing refusal as one bounded line: the position, the token found, and how
 * many alternatives the grammar offered — not the enumeration itself (a hundred
 * bracket tokens for one stray character) and not the rule stack behind it.
 */
const parsingDiagnosticOf = (flat: string): string => {
  const position = /line: (\d+|NaN), column: (\d+|NaN)/u.exec(flat);
  const found = /but found[^']*'([^']*)'/u.exec(flat);
  const alternatives = new Set(flat.match(/\b\d+\. [^\d][^[]*\[[^\]]*\]/gu) ?? []).size;
  const where = positionText(position?.[1], position?.[2]);
  const at = found === null ? "" : `: found '${found[1]}'`;
  const offered = alternatives === 0 ? "" : ` (${alternatives} alternative token sequences)`;
  return `Java parsing failed ${where}${at}${offered}`;
};

/**
 * The parser's refusal as one diagnostic: a lexing refusal keeps its own
 * wording (it names the character and the offset), a parsing refusal is
 * composed from its position and its found token, and either is bounded so a
 * gate message stays readable.
 */
const diagnosticOf = (message: string): string => {
  const flat = message.replace(/\s*\n\s*/gu, " ").trim();
  const text = LEXING_REFUSAL.test(flat) ? flat : parsingDiagnosticOf(flat);
  return text.length <= DIAGNOSTIC_LIMIT ? text : `${text.slice(0, DIAGNOSTIC_LIMIT - 1).trimEnd()}…`;
};

const messageOf = (cause: unknown): string => (cause instanceof Error ? cause.message : String(cause));

/**
 * The one Java read: the file's package, imports, used identifiers and
 * mutation sites, or the grammar's own refusal. A refused input is data; a
 * grammar that could not be loaded, and any other internal error, throws so the
 * shell names it `unexpected-error` (ADR-0102).
 */
export const parseJava = (text: string): DomainResult<JavaFile, JavaSyntaxError> => {
  const parser = parserModule();
  let root: CstNode;
  try {
    root = parser.parse(text);
  } catch (cause) {
    const message = messageOf(cause);
    if (!isGrammarRefusal(message)) throw cause;
    return failure(Object.freeze({ kind: "java-syntax-error", diagnostics: nonEmptyOf(diagnosticOf(message)) }));
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
