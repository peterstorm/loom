/**
 * Programmatic rule: no-wire-cast
 *
 * `JSON.parse(text)` and `response.json()` return `any`: whatever arrived on
 * the wire, with a type that accepts every read. Naming a type for that value
 * by assertion or by annotation checks nothing — the compiler takes the name on
 * trust and every later read is believed. The value has to be bound as
 * `unknown` and passed through a parser or decoder, which either returns the
 * typed value or says what was wrong with the document.
 *
 * Refused, where `T` is any type but `unknown`:
 *
 *   JSON.parse(text) as T               — assertion on the call
 *   (await response.json()) as T        — the same through grouping parentheses
 *   JSON.parse(text) as unknown as T    — a chain that leaves `unknown` again
 *   const value: T = JSON.parse(text)   — annotated `const` / `let` / `var`,
 *                                         a destructuring pattern included
 *   value = JSON.parse(text)            — where the nearest visible declaration
 *                                         of `value` is annotated `T`
 *
 * Allowed: `as unknown`, a `: unknown` binding, an assignment to a name
 * declared `unknown`, and the call in argument position
 * (`parseOrder(JSON.parse(text))`) — the callee's parameter type is the
 * parser's business. `Promise<unknown>` is `unknown` for a `.json()` call that
 * has not been awaited.
 *
 * The rule reads TEXT, with no type information (ADR-0042/0053 keep the
 * compiler API out of the linter), so it sees only the shapes above:
 *   - an unannotated binding (`const value = JSON.parse(text)`), a `return`
 *     under a declared return type, a property or argument the `any` flows
 *     through are not sites — each needs the type checker to judge;
 *   - a class field, a parameter default and the second declarator of a
 *     `let a, b: T = …` list are not read as declarations;
 *   - "nearest visible declaration" is by enclosing block, and parameters are
 *     not declarations: a parameter shadowing an outer annotated `let` is
 *     judged by the outer one;
 *   - `<T>JSON.parse(text)` (the angle-bracket assertion) is not read.
 *
 * Strings, comments, template text and regex literals are not code: a refused
 * shape written inside one is no site.
 *
 * SCOPE: every non-test TypeScript file, in every project. Pre-existing sites
 * are grandfathered per project in `wireCastBaseline`, keyed `path::as T` or
 * `path::name: T` with multiplicity, like the totality baselines.
 */

import { match } from "ts-pattern";
import type { Violation } from "../types";
import { makeViolation } from "../types";
import { lexicalSpans } from "../source-segments";
import { isTestFile } from "./config";
import { baselineCounter, baselineKey, projectRelative, type Baseline, type BaselineKey } from "./baseline";

export const RULE_NAME = "no-wire-cast";

export const FIX_HINT =
  "Bind the parsed value as `unknown` (`const raw: unknown = JSON.parse(text)`) and pass it through a parser or " +
  "decoder that returns the typed value or an error — an assertion or an annotation names a type without checking " +
  "one. Pre-existing sites: `lint-project --write-baseline`.";

export type WireCastOptions = Readonly<{
  /** Grandfathered `path::as T` / `path::name: T` keys, one site each. */
  baseline: Baseline;
  /** The root of the project whose config supplied `baseline` — the frame its
   *  keys are written in. Null when no project config is in play. */
  projectRoot: string | null;
}>;

export const DEFAULT_WIRE_CAST_OPTIONS: WireCastOptions = Object.freeze({ baseline: Object.freeze([]), projectRoot: null });

/** The two calls whose result is whatever the wire held. */
type WireCall = "JSON.parse" | ".json()";

/** How a wire call's result was given a type without being parsed. */
type Typing =
  | Readonly<{ kind: "assertion"; type: string }>
  | Readonly<{ kind: "annotated-binding"; name: string; type: string }>
  | Readonly<{ kind: "typed-assignment"; name: string; type: string }>;

/** One site the rule flags absent a baseline. */
type WireCast = Readonly<{
  wire: WireCall;
  /** Offset of the call's own token (`JSON`, or the `.` of `.json`): the line reported. */
  at: number;
  typing: Typing;
}>;

/** One `const` / `let` / `var` declarator: its name and where it stands, its
 *  annotation as written (null when it has none) and the offset of its
 *  initializer's `=` (null when it has none). */
type Declaration = Readonly<{ name: string; at: number; type: string | null; initializer: number | null }>;

/** The file as the rule reads it. */
type Source = Readonly<{
  /** The raw text: what messages and keys quote. */
  content: string;
  /** The text with every string, comment, template text and regex literal
   *  blanked to spaces — newlines kept, so every offset and line is the raw one. */
  code: string;
  /** The matching bracket of each `(`, `[`, `{` and its closer; -1 elsewhere. */
  partner: Int32Array;
  /** The innermost `{` open at each offset; -1 at the top level. */
  block: Int32Array;
}>;

const WIRE_CALL = /(?<![\w$])JSON\s*\.\s*parse\s*\(|\??\.\s*json\s*\(\s*\)/g;
/** A declaration keyword and what it binds: a name, or the bracket opening a destructuring pattern. */
const DECLARATOR = /(?<![\w$.])((?:const|let|var)\s*)(?:(?<=\s)([A-Za-z_$][\w$]*)|([{[]))/g;
const OPENERS = "([{";
const CLOSERS = ")]}";
const BRACKET_UNITS: ReadonlySet<number> = new Set([...OPENERS, ...CLOSERS].map((bracket) => bracket.charCodeAt(0)));
/** Words a `(` after which is a grouping, never a call's argument list. */
const BEFORE_GROUPING: ReadonlySet<string> = new Set([
  "return", "await", "typeof", "void", "yield", "throw", "case", "in", "of", "else", "do", "delete",
]);
/** Operators that end the type of an assertion and never appear in one. */
const AFTER_ASSERTED_TYPE = "?:!+-*/%^";
/** What an assignment's target follows when it starts a statement or an expression. */
const BEFORE_ASSIGNMENT_TARGET = "{};(),=";
const MAX_QUOTED_TYPE = 80;

/** An identifier character (`[A-Za-z0-9_$]`), read by code unit: this is asked per character of every type the rule walks. */
const isWordChar = (char: string | undefined): boolean => {
  if (char === undefined) return false;
  const unit = char.charCodeAt(0);
  return (unit >= 97 && unit <= 122) || (unit >= 65 && unit <= 90) || (unit >= 48 && unit <= 57) || unit === 95 || unit === 36;
};

/** White space as the code holds it: a space, a tab or line break, or one of the Unicode separators a source may carry. */
const isSpaceAt = (code: string, at: number): boolean => {
  const unit = code.charCodeAt(at);
  return unit === 32 || (unit >= 9 && unit <= 13) || unit === 160 || unit === 0x2028 || unit === 0x2029 || unit === 0xfeff;
};

/** The offset of the last non-space character before `before`, or -1. */
function significantBefore(code: string, before: number): number {
  let at = before - 1;
  while (at >= 0 && isSpaceAt(code, at)) at -= 1;
  return at;
}

/** The offset of the first non-space character at or after `from`, or the text's length. */
function significantFrom(code: string, from: number): number {
  let at = from;
  while (at < code.length && isSpaceAt(code, at)) at += 1;
  return at;
}

/** The offset where the word whose last character is at `last` begins. */
function wordStart(code: string, last: number): number {
  let at = last;
  while (at > 0 && isWordChar(code[at - 1])) at -= 1;
  return at;
}

/** Is `word` written at `at`, as a whole word? */
const wordAt = (code: string, at: number, word: string): boolean =>
  at >= 0 && code.startsWith(word, at) && !isWordChar(code[at - 1]) && !isWordChar(code[at + word.length]);

/** The code of a text: every span that is not code blanked, offsets kept. */
function codeOf(content: string): string {
  return lexicalSpans(content)
    .map(({ kind, start, end }) => (kind === "code" ? content.slice(start, end) : content.slice(start, end).replace(/[^\n]/g, " ")))
    .join("");
}

/**
 * Pair every bracket of the code in one pass, and name the block each offset
 * sits in. A closer with no opener of its kind is left unpaired; one whose
 * opener lies under unclosed brackets pairs with it and leaves those unpaired,
 * so one stray bracket does not unpair the rest of the file.
 *
 * Typed arrays written in place: this runs once per linted file inside the
 * per-edit budget, and an offset-indexed lookup is what keeps every later
 * question about a site constant-time.
 */
function pairBrackets(code: string): Pick<Source, "partner" | "block"> {
  const partner = new Int32Array(code.length).fill(-1);
  const block = new Int32Array(code.length);
  const open: number[] = [];
  const braces: number[] = [];
  const unclosed = [0, 0, 0];
  for (let at = 0; at < code.length; at++) {
    if (!BRACKET_UNITS.has(code.charCodeAt(at))) {
      block[at] = braces.length === 0 ? -1 : braces[braces.length - 1];
      continue;
    }
    const char = code.charAt(at);
    const closes = CLOSERS.indexOf(char);
    if (closes !== -1 && unclosed[closes] > 0) {
      let depth = open.length - 1;
      while (code[open[depth]] !== OPENERS[closes]) depth -= 1;
      const opener = open[depth];
      for (const dropped of open.splice(depth)) unclosed[OPENERS.indexOf(code.charAt(dropped))] -= 1;
      while (braces.length > 0 && braces[braces.length - 1] >= opener) braces.pop();
      partner[at] = opener;
      partner[opener] = at;
    }
    block[at] = braces.at(-1) ?? -1;
    const opens = OPENERS.indexOf(char);
    if (opens !== -1) {
      open.push(at);
      unclosed[opens] += 1;
      if (char === "{") braces.push(at);
    }
  }
  return { partner, block };
}

function sourceOf(content: string): Source {
  const code = codeOf(content);
  return { content, code, ...pairBrackets(code) };
}

/** A type as a message and a baseline key quote it: on one line, and bounded. */
function quoted(source: Source, start: number, end: number): string {
  const text = source.content.slice(start, end).replace(/\s+/g, " ").trim();
  return text.length > MAX_QUOTED_TYPE ? `${text.slice(0, MAX_QUOTED_TYPE)}…` : text;
}

/** `unknown` is the one type a wire value may be given unparsed; a promise of it is the same value not yet awaited. */
const isUnknown = (type: string): boolean => {
  const compact = type.replace(/\s+/g, "");
  return compact === "unknown" || compact === "Promise<unknown>";
};

/**
 * Does a type go on past the newline at `newline`? It does while nothing of it
 * is written yet, after an operator that needs a right-hand side, and before a
 * line that opens with one — otherwise the line break ends it, which is how a
 * semicolon-free `let raw: unknown` is read as one declaration.
 */
function typeContinuesPast(code: string, newline: number, start: number): boolean {
  const before = significantBefore(code, newline);
  if (before < start) return true;
  const after = significantFrom(code, newline);
  return "|&<".includes(code.charAt(before))
    || (code[before] === ">" && code[before - 1] === "=")
    || "|&=".includes(code.charAt(after))
    || wordAt(code, after, "as")
    || wordAt(code, after, "extends");
}

/** Where a type is written: after a declarator's `:`, or after `as`. */
type TypeContext = "annotation" | "assertion";

/** Does the character at `at` end the type that began at `start`? */
function endsType(code: string, at: number, start: number, context: TypeContext, angles: number): boolean {
  const char = code.charAt(at);
  if (CLOSERS.includes(char) || char === ";") return true;
  if (angles > 0) return false;
  if (char === "," || char === "=" || char === ">" || (char === "a" && wordAt(code, at, "as"))) return true;
  if (char === "\n") return !typeContinuesPast(code, at, start);
  if (context !== "assertion") return false;
  return AFTER_ASSERTED_TYPE.includes(char) || ((char === "|" || char === "&") && code[at + 1] === char);
}

/**
 * The offset just past the type written from `start`. An annotation's type
 * ends at its initializer's `=`; an assertion's also at the operator that
 * continues the expression around it. Bracketed parts are stepped over whole,
 * and a function type's `=>` is not an `=`.
 */
function typeEnd({ code, partner }: Source, start: number, context: TypeContext): number {
  let angles = 0;
  let at = start;
  while (at < code.length) {
    const char = code.charAt(at);
    if (char === "=" && code[at + 1] === ">") {
      at += 2;
      continue;
    }
    if (endsType(code, at, start, context, angles)) return at;
    if (char === "<") angles += 1;
    else if (char === ">") angles -= 1;
    else if (OPENERS.includes(char)) {
      if (partner[at] === -1) return at;
      at = partner[at];
    }
    at += 1;
  }
  return code.length;
}

/** What follows an expression: no assertion, a chain of them that only ever says `unknown`, or a type asserted. */
type Assertion = Readonly<{ kind: "none" }> | Readonly<{ kind: "unknown" }> | Readonly<{ kind: "typed"; type: string }>;

/**
 * The assertion on the expression ending at `end`, read through a chain of
 * `as`: `as unknown as Order` asserts `Order`, `as unknown` alone asserts
 * nothing a parser has not checked.
 */
function assertionAfter(source: Source, end: number): Assertion {
  const as = significantFrom(source.code, end);
  if (!wordAt(source.code, as, "as")) return { kind: "none" };
  const start = significantFrom(source.code, as + 2);
  const stop = typeEnd(source, start, "assertion");
  const type = quoted(source, start, stop);
  if (!isUnknown(type)) return { kind: "typed", type };
  const chained = assertionAfter(source, stop);
  return chained.kind === "none" ? { kind: "unknown" } : chained;
}

/** Is the `(` at `open` a grouping — not the argument list of a call? */
function isGrouping(code: string, open: number): boolean {
  const before = significantBefore(code, open);
  if (before === -1) return true;
  const char = code.charAt(before);
  if (char === ">") return code[before - 1] === "=";
  if (isWordChar(char)) return BEFORE_GROUPING.has(code.slice(wordStart(code, before), before + 1));
  return !")].".includes(char);
}

/**
 * Where the receiver of the member access at `access` begins: back over a
 * chain of names, member dots, non-null `!` and bracketed parts. White space
 * is crossed only into a member dot, so the line above a semicolon-free
 * statement is never read as part of its receiver.
 */
function receiverStart({ code, partner }: Source, access: number): number {
  let at = access;
  for (;;) {
    const last = significantBefore(code, at);
    const joined = last === at - 1 || code[at] === "." || code[at] === "?";
    const char = code[last];
    if (last === -1 || !joined) return at;
    if (char === ")" || char === "]") {
      if (partner[last] === -1) return at;
      at = partner[last];
    } else if (isWordChar(char)) at = wordStart(code, last);
    else if (char === ".") at = code[last - 1] === "?" ? last - 1 : last;
    else if (char === "!" && code[at] === ".") at = last;
    else return at;
  }
}

/** An expression's extent in the code. */
type Extent = Readonly<{ start: number; end: number }>;

/** The expression with its `await` and every pair of grouping parentheses around it taken in. */
function widened(source: Source, { start, end }: Extent): Extent {
  const { code, partner } = source;
  const word = significantBefore(code, start);
  const from = word >= 4 && wordAt(code, word - 4, "await") ? word - 4 : start;
  const open = significantBefore(code, from);
  const close = significantFrom(code, end);
  if (open === -1 || code[open] !== "(" || partner[open] !== close || !isGrouping(code, open)) return { start: from, end };
  return widened(source, { start: open, end: close + 1 });
}

/**
 * Every first declarator of a `const` / `let` / `var` in the file, in source
 * order. A destructuring pattern is one declarator named by its own text
 * (`{ id, total }`), which no assignment target can spell.
 */
function declarationsOf(source: Source): readonly Declaration[] {
  const { code, partner } = source;
  return [...code.matchAll(DECLARATOR)].flatMap((found): readonly Declaration[] => {
    const at = found.index + found[1].length;
    const bindingEnd = found[2] === undefined ? partner[at] + 1 : at + found[2].length;
    if (bindingEnd === 0) return [];
    const name = found[2] ?? quoted(source, at, bindingEnd);
    const after = significantFrom(code, bindingEnd);
    const colon = code[after] === "!" ? significantFrom(code, after + 1) : after;
    if (code[colon] !== ":") {
      return [{ name, at, type: null, initializer: code[after] === "=" && code[after + 1] !== "=" ? after : null }];
    }
    const start = significantFrom(code, colon + 1);
    const stop = typeEnd(source, start, "annotation");
    return [{ name, at, type: quoted(source, start, stop), initializer: code[stop] === "=" ? stop : null }];
  });
}

/** The file's declarations as the two questions a site asks of them. */
type Declarations = Readonly<{
  /** The declaration whose initializer's `=` is at this offset. */
  initializedAt: (equals: number) => Declaration | undefined;
  /** The nearest declaration of `name` before `at` whose block still encloses `at`. */
  nearestVisible: (name: string, at: number) => Declaration | undefined;
}>;

function indexDeclarations(source: Source): Declarations {
  const all = declarationsOf(source);
  const byInitializer = new Map(all.flatMap((declaration) =>
    declaration.initializer === null ? [] : [[declaration.initializer, declaration] as const]));
  const byName = Map.groupBy(all, ({ name }) => name);
  const encloses = (declaration: Declaration, at: number): boolean => {
    const opened = source.block[declaration.at];
    return opened === -1 || source.partner[opened] === -1 || source.partner[opened] > at;
  };
  return {
    initializedAt: (equals) => byInitializer.get(equals),
    nearestVisible: (name, at) => {
      const named = byName.get(name) ?? [];
      for (let index = countBefore(named, at) - 1; index >= 0; index -= 1) {
        if (encloses(named[index], at)) return named[index];
      }
      return undefined;
    },
  };
}

/** How many of the declarations, in source order, stand before `at` — by bisection, so a name declared a thousand times costs no more to look up. */
function countBefore(declarations: readonly Declaration[], at: number): number {
  let low = 0;
  let high = declarations.length;
  while (low < high) {
    const middle = (low + high) >> 1;
    if (declarations[middle].at < at) low = middle + 1;
    else high = middle;
  }
  return low;
}

/** The offset where the assignment operator ending in the `=` at `equals` begins, or null when that `=` assigns nothing. */
function assignmentOperatorStart(code: string, equals: number): number | null {
  const before = code.charAt(equals - 1);
  if ("=!<>+-*/%^~".includes(before)) return null;
  if (!"?|&".includes(before)) return equals;
  // `??=`, `||=` and `&&=` assign; `|=` and `&=` compute.
  return code[equals - 2] === before ? equals - 2 : null;
}

/** The name assigned by the operator starting at `operator`, when a bare name in target position is. */
function assignmentTarget(code: string, operator: number): Readonly<{ name: string; at: number }> | null {
  const last = significantBefore(code, operator);
  if (!isWordChar(code[last])) return null;
  const at = wordStart(code, last);
  const lead = significantBefore(code, at);
  const startsLine = code.slice(lead + 1, at).includes("\n") && (isWordChar(code[lead]) || code[lead] === "]");
  const inTargetPosition = lead === -1
    || BEFORE_ASSIGNMENT_TARGET.includes(code.charAt(lead))
    || startsLine
    || (code[lead] === "e" && wordAt(code, lead - 3, "else"));
  return inTargetPosition ? { name: code.slice(at, last + 1), at } : null;
}

/**
 * Is the expression ending at `end` the whole of what it is part of — nothing
 * read from it, called on it or computed with it? `JSON.parse(text).id` binds
 * a property of the wire value, not the value.
 */
function endsItsExpression(code: string, end: number): boolean {
  const next = significantFrom(code, end);
  return next === code.length
    || ";,)]}".includes(code.charAt(next))
    || (code.slice(end, next).includes("\n") && isWordChar(code[next]));
}

/** How the expression is bound, when it is bound whole and what binds it carries a type other than `unknown`. */
function typedBinding(source: Source, declarations: Declarations, { start, end }: Extent): Typing | null {
  const equals = significantBefore(source.code, start);
  if (equals === -1 || source.code[equals] !== "=" || !endsItsExpression(source.code, end)) return null;
  const operator = assignmentOperatorStart(source.code, equals);
  if (operator === null) return null;
  const declared = declarations.initializedAt(equals);
  if (declared !== undefined) {
    return declared.type === null || isUnknown(declared.type)
      ? null
      : { kind: "annotated-binding", name: declared.name, type: declared.type };
  }
  const target = assignmentTarget(source.code, operator);
  const declaration = target === null ? undefined : declarations.nearestVisible(target.name, target.at);
  if (declaration === undefined || declaration.type === null || isUnknown(declaration.type)) return null;
  return { kind: "typed-assignment", name: declaration.name, type: declaration.type };
}

/** One wire call: which call, where its token is, and the call expression's extent. */
type WireCallSite = Pick<WireCast, "wire" | "at"> & Extent;

/** Every wire call of the file, in source order. */
function wireCalls(source: Source): readonly WireCallSite[] {
  return [...source.code.matchAll(WIRE_CALL)].flatMap((found): readonly WireCallSite[] => {
    const end = found.index + found[0].length;
    if (!found[0].startsWith("J")) return [{ wire: ".json()", at: found.index, start: receiverStart(source, found.index), end }];
    const close = source.partner[end - 1];
    return close === -1 ? [] : [{ wire: "JSON.parse", at: found.index, start: found.index, end: close + 1 }];
  });
}

/**
 * The rule's ONE analysis of a file: `handler` spends baseline entries against
 * these sites and reports the rest, and `detectedWireCastKeys` hands the same
 * sites to the staleness pass.
 *
 * A file that names neither call is answered before it is lexed.
 */
function wireCasts(content: string, filePath: string, options: WireCastOptions): readonly WireCast[] {
  if (isTestFile(projectRelative(filePath, options.projectRoot))) return [];
  if (!content.includes("JSON") && !content.includes("json")) return [];
  const source = sourceOf(content);
  const calls = wireCalls(source);
  if (calls.length === 0) return [];
  const declarations = indexDeclarations(source);
  return Object.freeze(calls.flatMap(({ wire, at, start, end }): readonly WireCast[] => {
    const expression = widened(source, { start, end });
    // An assertion decides the site alone: what `as unknown` is then bound to is the compiler's to refuse.
    const typing = match(assertionAfter(source, expression.end))
      .returnType<Typing | null>()
      .with({ kind: "typed" }, ({ type }) => ({ kind: "assertion", type }))
      .with({ kind: "unknown" }, () => null)
      .with({ kind: "none" }, () => typedBinding(source, declarations, expression))
      .exhaustive();
    return typing === null ? [] : [{ wire, at, typing }];
  }));
}

/** What a baseline entry names: the type the wire value was given, and the name it was bound to. */
const keyOf = (typing: Typing): string =>
  match(typing)
    .with({ kind: "assertion" }, ({ type }) => `as ${type}`)
    .with({ kind: "annotated-binding" }, { kind: "typed-assignment" }, ({ name, type }) => `${name}: ${type}`)
    .exhaustive();

const describe = ({ wire, typing }: WireCast): string =>
  match(typing)
    .with({ kind: "assertion" }, ({ type }) => `${wire} output is asserted \`as ${type}\` without being parsed`)
    .with({ kind: "annotated-binding" }, ({ name, type }) => `${wire} output is bound to \`${name}: ${type}\` without being parsed`)
    .with({ kind: "typed-assignment" }, ({ name, type }) => `${wire} output is assigned to \`${name}\`, declared \`${type}\`, without being parsed`)
    .exhaustive();

/** One site with the 1-based line it is reported on and that line's text. */
type LocatedWireCast = Readonly<{ site: WireCast; line: number; text: string }>;

/** Each site's line, counted once across the file: the sites arrive in source order. */
function located(content: string, sites: readonly WireCast[]): readonly LocatedWireCast[] {
  let line = 1;
  let counted = 0;
  return sites.map((site): LocatedWireCast => {
    line += content.slice(counted, site.at).split("\n").length - 1;
    counted = site.at;
    const lineEnd = content.indexOf("\n", site.at);
    const text = content.slice(content.lastIndexOf("\n", site.at) + 1, lineEnd === -1 ? content.length : lineEnd);
    return { site, line, text };
  });
}

export function handler(
  content: string,
  filePath: string,
  options: WireCastOptions = DEFAULT_WIRE_CAST_OPTIONS,
): readonly Violation[] {
  const relative = projectRelative(filePath, options.projectRoot);
  const baseline = baselineCounter(options.baseline);
  return Object.freeze(located(content, wireCasts(content, filePath, options))
    .filter(({ site }) => !baseline.consume(baselineKey(relative, keyOf(site.typing))))
    .map(({ site, line, text }) => makeViolation(RULE_NAME, filePath, line, text, `${describe(site)}. ${FIX_HINT}`)));
}

/** The baseline keys of every site the rule would flag absent its baseline —
 *  the input of the staleness pass and of `lint-project --write-baseline`. */
export function detectedWireCastKeys(
  content: string,
  filePath: string,
  options: WireCastOptions = DEFAULT_WIRE_CAST_OPTIONS,
): readonly BaselineKey[] {
  const relative = projectRelative(filePath, options.projectRoot);
  return wireCasts(content, filePath, options).map((site) => baselineKey(relative, keyOf(site.typing)));
}
