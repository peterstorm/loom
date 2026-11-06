/**
 * The restricted pure Java lexer and declaration reader (AD-7), with the
 * frozen-holder shape check.
 *
 * Reading runs in three pure stages, each a `DomainResult`:
 *
 * 1. **Unicode escapes** are translated first, everywhere, as javac does.
 * 2. **The lexer** blanks comments, and turns string literals, char literals
 *    and text blocks into single tokens that keep their decoded values (text
 *    blocks with incidental whitespace stripped) for marker detection. Nothing
 *    inside a comment or a literal can therefore reach the declaration reader.
 * 3. **The declaration reader** reads `package` and `import` lines, and every
 *    type declaration (`class`, `interface`, `record`, `enum`, `@interface`)
 *    with its modifiers, `sealed`/`non-sealed`, supertypes and `permits`; its
 *    members: methods (parameter types, generic-ness, whether they have a
 *    body), fields (type token, initializer span) and nested types; and the
 *    local and anonymous-class types inside method bodies and initializers.
 *    It skips expressions and statements as balanced token groups.
 *
 * The reader reads text only and never classifies paths: whether a path is a
 * Java skeleton target is `language.ts`'s decision (AD-15). The only use of the
 * path here is the implementation file's basename, which names the top-level
 * class whose fields are its bound members.
 *
 * Restrictions, all deliberate refusals rather than guesses:
 * - A frozen types file is exactly one top-level `public interface` or
 *   `public final class` (the holder); any other shape is
 *   `unsupported-holder-shape`.
 * - A bindable alias is a holder-nested, non-sealed interface with exactly one
 *   abstract method, ignoring the public `Object` methods (JLS 9.8). Abstract
 *   methods inherited from interfaces the same file declares are counted; an
 *   interface extending a type the file does not declare is `not-a-function`,
 *   because its abstract methods cannot be read from this text.
 * - Abstract methods are told apart by override-equivalence (JLS 8.4.2): the
 *   name and the erased parameter types, after substituting a parent's type
 *   arguments for its type parameters. Erasure keeps a type's simple name, so
 *   two distinct types sharing one simple name read as the same type.
 */

import { match } from "ts-pattern";
import type { DomainResult } from "../orchestration-contract";
import type {
  AliasShape,
  DeclaredAlias,
  FrozenAdt,
  JavaField,
  JavaLocalType,
  ReadJavaImplementationSurfaceFn,
  ReadJavaTypesSurfaceFn,
  SurfaceProblem,
} from "./types";

// ---------------------------------------------------------------------------
// Results: a failed read carries a human-readable detail
// ---------------------------------------------------------------------------

type Read<T> = DomainResult<T, string>;

const ok = <T>(value: T): Read<T> => ({ ok: true, value });
const fail = (detail: string): Read<never> => ({ ok: false, error: detail });

/** A parse step: the value read and the index of the first token after it. */
type Step<T> = Read<Readonly<{ value: T; next: number }>>;

const step = <T>(value: T, next: number): Step<T> => ok({ value, next });

// ---------------------------------------------------------------------------
// Stage 1: unicode escapes (JLS 3.3)
// ---------------------------------------------------------------------------

const lineOf = (text: string, index: number): number => text.slice(0, index).split("\n").length;

/** Translate every `\uXXXX` escape whose backslash is preceded by an even
 *  number of backslashes; a malformed one is a compile error, as in javac. */
const translateUnicodeEscapes = (source: string): Read<string> => {
  const parts: string[] = [];
  let i = 0;
  while (i < source.length) {
    if (source[i] !== "\\") {
      parts.push(source[i] ?? "");
      i += 1;
      continue;
    }
    let run = 0;
    while (source[i + run] === "\\") run += 1;
    const literal = run - (run % 2);
    parts.push("\\".repeat(literal));
    i += literal;
    if (run % 2 === 0) continue;
    let u = i + 1;
    while (source[u] === "u") u += 1;
    if (u === i + 1) {
      parts.push("\\");
      i += 1;
      continue;
    }
    const hex = source.slice(u, u + 4);
    if (!/^[0-9A-Fa-f]{4}$/.test(hex)) return fail(`line ${lineOf(source, i)}: malformed unicode escape`);
    parts.push(String.fromCharCode(Number.parseInt(hex, 16)));
    i = u + 4;
  }
  return ok(parts.join(""));
};

// ---------------------------------------------------------------------------
// Stage 2: the lexer
// ---------------------------------------------------------------------------

/** `value` is a literal's decoded value, and the token's text otherwise. */
type Token = Readonly<{ kind: "word" | "symbol" | "string" | "char" | "number"; text: string; value: string; line: number }>;

const SIMPLE_ESCAPES: ReadonlyMap<string, string> = new Map([
  ["b", "\b"], ["t", "\t"], ["n", "\n"], ["f", "\f"], ["r", "\r"], ["s", " "], ['"', '"'], ["'", "'"], ["\\", "\\"],
]);

/** Decode the escape sequences of a literal's raw content (JLS 3.10.7);
 *  a text block also allows `\<line terminator>`, which joins lines. */
const decodeEscapes = (raw: string, textBlock: boolean): Read<string> => {
  const parts: string[] = [];
  let i = 0;
  while (i < raw.length) {
    const ch = raw[i] ?? "";
    if (ch !== "\\") {
      parts.push(ch);
      i += 1;
      continue;
    }
    const next = raw[i + 1] ?? "";
    const simple = SIMPLE_ESCAPES.get(next);
    if (simple !== undefined) {
      parts.push(simple);
      i += 2;
      continue;
    }
    const octal = /^(?:[0-3][0-7]{0,2}|[4-7][0-7]?)/.exec(raw.slice(i + 1));
    if (octal !== null) {
      parts.push(String.fromCharCode(Number.parseInt(octal[0], 8)));
      i += 1 + octal[0].length;
      continue;
    }
    if (textBlock && next === "\n") {
      i += 2;
      continue;
    }
    return fail(`invalid escape sequence \\${next}`);
  }
  return ok(parts.join(""));
};

const isBlankLine = (line: string): boolean => /^[ \t\f]*$/.test(line);

/** A text block's value (JLS 3.10.6): line terminators normalized, incidental
 *  indentation and trailing whitespace stripped, then escapes decoded. The
 *  closing delimiter's line always counts toward the indentation. */
const textBlockValue = (raw: string): Read<string> => {
  const lines = raw.replace(/\r\n?/g, "\n").split("\n");
  const last = lines.length - 1;
  const indent = Math.min(
    ...lines
      .filter((line, index) => index === last || !isBlankLine(line))
      .map((line) => /^[ \t\f]*/.exec(line)?.[0].length ?? 0),
  );
  const stripped = lines.map((line) => (isBlankLine(line) ? "" : line.slice(indent).replace(/[ \t\f]+$/, "")));
  return decodeEscapes(stripped.join("\n"), true);
};

const isIdentifierStart = (ch: string): boolean => /^[\p{ID_Start}$_]$/u.test(ch);
const isIdentifierPart = (ch: string): boolean => /^[\p{ID_Continue}$‌‍]$/u.test(ch);
const codePointAt = (text: string, index: number): string => String.fromCodePoint(text.codePointAt(index) ?? 0);
const countLines = (text: string): number => (text.match(/\r\n?|\n/g) ?? []).length;

const MULTI_CHARACTER_SYMBOLS: readonly string[] = ["...", "->", "::"];

/** Find the end of a quoted literal starting at `start`: the index after its
 *  closing quote, with the raw content between the quotes. */
const quotedLiteral = (text: string, start: number, quote: string): Read<Readonly<{ raw: string; end: number }>> => {
  let j = start + 1;
  while (j < text.length && text[j] !== "\n" && text[j] !== "\r") {
    if (text[j] === "\\") {
      j += 2;
      continue;
    }
    if (text[j] === quote) return ok({ raw: text.slice(start + 1, j), end: j + 1 });
    j += 1;
  }
  return fail(`line ${lineOf(text, start)}: unterminated ${quote === '"' ? "string" : "char"} literal`);
};

/** Find a text block starting at `start` (its opening `"""`). */
const textBlockLiteral = (text: string, start: number): Read<Readonly<{ raw: string; end: number }>> => {
  let j = start + 3;
  while (text[j] === " " || text[j] === "\t" || text[j] === "\f") j += 1;
  if (text[j] !== "\n" && text[j] !== "\r") {
    return fail(`line ${lineOf(text, start)}: a text block's opening delimiter must be followed by a line terminator`);
  }
  j += text.startsWith("\r\n", j) ? 2 : 1;
  const contentStart = j;
  while (j < text.length) {
    if (text[j] === "\\") {
      j += 2;
      continue;
    }
    if (text.startsWith('"""', j)) return ok({ raw: text.slice(contentStart, j), end: j + 3 });
    j += 1;
  }
  return fail(`line ${lineOf(text, start)}: unterminated text block`);
};

/** One scanned lexeme: the token it produces (none for whitespace and
 *  comments), the index after it, and the line the scan ends on. */
type Scan = Readonly<{ token: Token | null; end: number; line: number }>;

/** A scanner for one lexeme form at `i`; null when that form does not start there. */
type Scanner = (text: string, i: number, line: number) => Read<Scan> | null;

const scanned = (token: Token | null, end: number, line: number): Read<Scan> => ok({ token, end, line });

const scanLineTerminator: Scanner = (text, i, line) =>
  text[i] === "\n" || text[i] === "\r" ? scanned(null, i + (text.startsWith("\r\n", i) ? 2 : 1), line + 1) : null;

const scanWhitespace: Scanner = (text, i, line) =>
  text[i] === " " || text[i] === "\t" || text[i] === "\f" ? scanned(null, i + 1, line) : null;

const scanLineComment: Scanner = (text, i, line) => {
  if (!text.startsWith("//", i)) return null;
  const end = text.slice(i).search(/[\r\n]/);
  return scanned(null, end < 0 ? text.length : i + end, line);
};

const scanBlockComment: Scanner = (text, i, line) => {
  if (!text.startsWith("/*", i)) return null;
  const end = text.indexOf("*/", i + 2);
  if (end < 0) return fail(`line ${line}: unterminated comment`);
  return scanned(null, end + 2, line + countLines(text.slice(i, end)));
};

const scanTextBlock: Scanner = (text, i, line) => {
  if (!text.startsWith('"""', i)) return null;
  const block = textBlockLiteral(text, i);
  if (!block.ok) return block;
  const value = textBlockValue(block.value.raw);
  if (!value.ok) return fail(`line ${line}: ${value.error}`);
  const source = text.slice(i, block.value.end);
  return scanned({ kind: "string", text: source, value: value.value, line }, block.value.end, line + countLines(source));
};

const scanQuoted: Scanner = (text, i, line) => {
  const quote = text[i];
  if (quote !== '"' && quote !== "'") return null;
  const literal = quotedLiteral(text, i, quote);
  if (!literal.ok) return literal;
  const value = decodeEscapes(literal.value.raw, false);
  if (!value.ok) return fail(`line ${line}: ${value.error}`);
  const token: Token = { kind: quote === '"' ? "string" : "char", text: text.slice(i, literal.value.end), value: value.value, line };
  return scanned(token, literal.value.end, line);
};

/** An identifier or keyword; `non-sealed` is one word. */
const scanWord: Scanner = (text, i, line) => {
  const first = codePointAt(text, i);
  if (!isIdentifierStart(first)) return null;
  let j = i + first.length;
  while (j < text.length && isIdentifierPart(codePointAt(text, j))) j += codePointAt(text, j).length;
  const nonSealed = text.slice(i, j) === "non" && text.startsWith("-sealed", j) && !isIdentifierPart(codePointAt(text, j + 7));
  const end = nonSealed ? j + 7 : j;
  const word = text.slice(i, end);
  return scanned({ kind: "word", text: word, value: word, line }, end, line);
};

const scanNumber: Scanner = (text, i, line) => {
  const startsNumber = /[0-9]/.test(text[i] ?? "") || (text[i] === "." && /[0-9]/.test(text[i + 1] ?? ""));
  if (!startsNumber) return null;
  const length = /^.[0-9A-Za-z_.]*/.exec(text.slice(i))?.[0].length ?? 1;
  const number = text.slice(i, i + length);
  return scanned({ kind: "number", text: number, value: number, line }, i + length, line);
};

/** Any other character is a symbol; a few symbols span several characters. */
const scanSymbol = (text: string, i: number, line: number): Read<Scan> => {
  const symbol = MULTI_CHARACTER_SYMBOLS.find((candidate) => text.startsWith(candidate, i)) ?? codePointAt(text, i);
  return scanned({ kind: "symbol", text: symbol, value: symbol, line }, i + symbol.length, line);
};

/** Tried in order: comments before `/`, text blocks before strings. */
const SCANNERS: readonly Scanner[] = [
  scanLineTerminator, scanWhitespace, scanLineComment, scanBlockComment, scanTextBlock, scanQuoted, scanWord, scanNumber,
];

const scanAt = (text: string, i: number, line: number): Read<Scan> =>
  SCANNERS.reduce<Read<Scan> | null>((found, scanner) => found ?? scanner(text, i, line), null) ?? scanSymbol(text, i, line);

/** Tokenize translated source. Comments and whitespace produce no token. */
const lex = (text: string): Read<readonly Token[]> => {
  const tokens: Token[] = [];
  let cursor = { end: 0, line: 1 };
  while (cursor.end < text.length) {
    const next = scanAt(text, cursor.end, cursor.line);
    if (!next.ok) return next;
    if (next.value.token !== null) tokens.push(next.value.token);
    cursor = next.value;
  }
  return ok(tokens);
};

// ---------------------------------------------------------------------------
// Stage 3: the declaration reader
// ---------------------------------------------------------------------------

type TypeKind = "class" | "interface" | "record" | "enum" | "annotation";

/** A type as written, the simple name of its last segment, and that
 *  segment's type arguments as written (empty when raw or not generic). */
type TypeRef = Readonly<{ text: string; simpleName: string; typeArguments: readonly string[] }>;

/** A declared type parameter and its first bound as written (`Object` when unbounded). */
type TypeParameter = Readonly<{ name: string; bound: string }>;

type Method = Readonly<{
  kind: "method";
  name: string;
  modifiers: readonly string[];
  /** The method's own type parameters; it is generic when there are any. */
  typeParameters: readonly TypeParameter[];
  /** Formal parameter types as written, the receiver parameter excluded. */
  parameterTypes: readonly string[];
  hasBody: boolean;
}>;

type Member =
  | Method
  | Readonly<{ kind: "field"; field: JavaField }>
  | Readonly<{ kind: "member-type"; declaration: TypeDeclaration }>
  /** Types declared inside a body: a method, initializer, or anonymous class. */
  | Readonly<{ kind: "local-types"; declarations: readonly TypeDeclaration[] }>;

type TypeDeclaration = Readonly<{
  kind: TypeKind;
  name: string;
  modifiers: readonly string[];
  /** The type's own type parameters; it is generic when there are any. */
  typeParameters: readonly TypeParameter[];
  /** Direct supertypes: `extends` and `implements` lists. */
  supertypes: readonly TypeRef[];
  /** Simple names of an explicit `permits` clause; null when there is none. */
  permits: readonly string[] | null;
  members: readonly Member[];
}>;

type CompilationUnit = Readonly<{
  package: string | null;
  imports: readonly string[];
  types: readonly TypeDeclaration[];
}>;

/** Modifier keywords; `sealed` is contextual and handled apart. */
const MODIFIERS: ReadonlySet<string> = new Set([
  "public", "protected", "private", "static", "final", "abstract", "strictfp",
  "transient", "volatile", "synchronized", "native", "default", "non-sealed",
]);

const OPENERS: ReadonlyMap<string, string> = new Map([["(", ")"], ["[", "]"], ["{", "}"]]);
const CLOSERS: ReadonlySet<string> = new Set([")", "]", "}"]);

const NO_SPACE_BEFORE: ReadonlySet<string> = new Set([".", "<", ">", "[", "]", ",", "...", "(", ")"]);
const NO_SPACE_AFTER: ReadonlySet<string> = new Set([".", "<", "[", "(", "@"]);

/** Render a type's tokens as written, spaced canonically: `Map<String, Integer>`. */
const renderType = (texts: readonly string[]): string =>
  texts.reduce((rendered, text, index) => {
    const previous = texts[index - 1];
    if (previous === undefined) return text;
    const glued = NO_SPACE_BEFORE.has(text) || NO_SPACE_AFTER.has(previous);
    return `${rendered}${glued ? "" : " "}${text}`;
  }, "");

const localTypesMember = (declarations: readonly TypeDeclaration[]): readonly Member[] =>
  declarations.length === 0 ? [] : [{ kind: "local-types", declarations }];

// The reader's cursor is explicit: every reader takes the token stream and the
// index it starts at, and returns a `Step` carrying the index after what it read.

type Tokens = readonly Token[];

/** The type whose body is being read: records allow a compact constructor,
 *  enums open with constants. */
type Owner = Readonly<{ kind: TypeKind; name: string }>;

const isSymbol = (tokens: Tokens, i: number, text: string): boolean => tokens[i]?.kind === "symbol" && tokens[i]?.text === text;

const isWord = (tokens: Tokens, i: number, text?: string): boolean =>
  tokens[i]?.kind === "word" && (text === undefined || tokens[i]?.text === text);

const wordAt = (tokens: Tokens, i: number): string => tokens[i]?.text ?? "";

const where = (tokens: Tokens, i: number): string => {
  const token = tokens[i];
  return token === undefined ? "end of file" : `line ${token.line} at '${token.text}'`;
};

const unexpected = (tokens: Tokens, i: number, wanted: string): Read<never> => fail(`${where(tokens, i)}: expected ${wanted}`);

const stringsBetween = (tokens: Tokens, start: number, end: number): readonly string[] =>
  tokens.slice(start, end).filter((token) => token.kind === "string").map((token) => token.value);

const expectSymbol = (tokens: Tokens, i: number, text: string): Step<null> =>
  isSymbol(tokens, i, text) ? step(null, i + 1) : unexpected(tokens, i, `'${text}'`);

const expectWord = (tokens: Tokens, i: number): Step<string> =>
  isWord(tokens, i) ? step(wordAt(tokens, i), i + 1) : unexpected(tokens, i, "a name");

const isAnnotationAt = (tokens: Tokens, i: number): boolean => isSymbol(tokens, i, "@") && !isWord(tokens, i + 1, "interface");

const isOpenerAt = (tokens: Tokens, i: number): boolean => tokens[i]?.kind === "symbol" && OPENERS.has(tokens[i]?.text ?? "");

const isCloserAt = (tokens: Tokens, i: number): boolean => tokens[i]?.kind === "symbol" && CLOSERS.has(tokens[i]?.text ?? "");

/** Whether a type declaration starts at `i` (after its modifiers). */
const startsTypeDeclaration = (tokens: Tokens, i: number): boolean => {
  if (isSymbol(tokens, i, "@")) return isWord(tokens, i + 1, "interface");
  if (isWord(tokens, i, "class") || isWord(tokens, i, "interface") || isWord(tokens, i, "enum")) {
    return !isSymbol(tokens, i - 1, ".") && isWord(tokens, i + 1);
  }
  if (isWord(tokens, i, "record")) return isWord(tokens, i + 1) && (isSymbol(tokens, i + 2, "(") || isSymbol(tokens, i + 2, "<"));
  return false;
};

const KEYWORD_KINDS: ReadonlyMap<string, TypeKind> = new Map([["class", "class"], ["interface", "interface"], ["enum", "enum"]]);

/** The kind of the declaration `startsTypeDeclaration` found at `i`. */
const typeKindAt = (tokens: Tokens, i: number): TypeKind =>
  isSymbol(tokens, i, "@") ? "annotation" : (KEYWORD_KINDS.get(wordAt(tokens, i)) ?? "record");

/** `name(.name)*`, with a trailing `.*` when `wildcard` allows it. */
const qualifiedName = (tokens: Tokens, i: number, wildcard: boolean): Step<string> => {
  const first = expectWord(tokens, i);
  if (!first.ok) return first;
  const segments = [first.value.value];
  let j = first.value.next;
  while (isSymbol(tokens, j, ".") && (isWord(tokens, j + 1) || (wildcard && isSymbol(tokens, j + 1, "*")))) {
    segments.push(wordAt(tokens, j + 1));
    j += 2;
    if (isSymbol(tokens, j - 1, "*")) break;
  }
  return step(segments.join("."), j);
};

/** A type declaration at `i` inside a group, with its modifiers: `sealed`
 *  counts on the member types of anonymous class and enum constant bodies.
 *  Null when no declaration starts there (`default` of a `switch`, say). */
const declarationInGroup = (tokens: Tokens, i: number): Step<TypeDeclaration> | null => {
  const declared = modifiers(tokens, i);
  if (!declared.ok) return declared;
  return startsTypeDeclaration(tokens, declared.value.next) ? typeDeclaration(tokens, declared.value.next, declared.value.value) : null;
};

/** Skip a balanced group opened at `start`, reading the type declarations
 *  inside it (local classes, records, interfaces, enums). */
const skipGroup = (tokens: Tokens, start: number): Step<readonly TypeDeclaration[]> => {
  const declarations: TypeDeclaration[] = [];
  const expected: string[] = [];
  let i = start;
  while (i < tokens.length) {
    if (isOpenerAt(tokens, i)) {
      expected.push(OPENERS.get(wordAt(tokens, i)) ?? "");
      i += 1;
    } else if (isCloserAt(tokens, i)) {
      if (expected.pop() !== wordAt(tokens, i)) return fail(`${where(tokens, i)}: mismatched bracket`);
      i += 1;
      if (expected.length === 0) return step(declarations, i);
    } else {
      const declaration = declarationInGroup(tokens, i);
      if (declaration !== null && !declaration.ok) return declaration;
      if (declaration !== null) declarations.push(declaration.value.value);
      i = declaration === null ? i + 1 : declaration.value.next;
    }
  }
  return fail(`end of file: '${wordAt(tokens, start)}' opened at ${where(tokens, start)} is never closed`);
};

/** Skip type arguments or parameters `<…>` opened at `start`. */
const skipAngles = (tokens: Tokens, start: number): Step<null> => {
  let depth = 0;
  let i = start;
  while (i < tokens.length) {
    if (isSymbol(tokens, i, "<")) depth += 1;
    else if (isSymbol(tokens, i, ">")) depth -= 1;
    else if (isSymbol(tokens, i, ";") || isSymbol(tokens, i, "{") || isSymbol(tokens, i, "}")) break;
    i += 1;
    if (depth === 0) return step(null, i);
  }
  return fail(`${where(tokens, start)}: unclosed '<'`);
};

/** The start indices of the comma-separated entries between `start` and
 *  `end`, splitting only at bracket and angle depth zero. */
const topLevelEntries = (tokens: Tokens, start: number, end: number): readonly number[] => {
  const starts = [start];
  let depth = 0;
  for (let i = start; i < end; i += 1) {
    if (isOpenerAt(tokens, i) || isSymbol(tokens, i, "<")) depth += 1;
    else if (isCloserAt(tokens, i) || isSymbol(tokens, i, ">")) depth -= 1;
    else if (depth === 0 && isSymbol(tokens, i, ",")) starts.push(i + 1);
  }
  return starts;
};

/** Leading annotations from `i`, skipped. */
const skipAnnotations = (tokens: Tokens, i: number): Step<null> => {
  let j = i;
  while (isAnnotationAt(tokens, j)) {
    const skipped = annotation(tokens, j);
    if (!skipped.ok) return skipped;
    j = skipped.value.next;
  }
  return step(null, j);
};

/** One type parameter at `i`: annotations, its name and its first bound. */
const typeParameter = (tokens: Tokens, i: number): Read<TypeParameter> => {
  const annotated = skipAnnotations(tokens, i);
  if (!annotated.ok) return annotated;
  const name = expectWord(tokens, annotated.value.next);
  if (!name.ok) return name;
  if (!isWord(tokens, name.value.next, "extends")) return ok({ name: name.value.value, bound: "Object" });
  const bound = type(tokens, name.value.next + 1);
  return bound.ok ? ok({ name: name.value.value, bound: bound.value.value.text }) : bound;
};

/** Type parameters at `i` when there are any, and the index after them. */
const typeParameters = (tokens: Tokens, i: number): Step<readonly TypeParameter[]> => {
  if (!isSymbol(tokens, i, "<")) return step([], i);
  const skipped = skipAngles(tokens, i);
  if (!skipped.ok) return skipped;
  const read: TypeParameter[] = [];
  for (const start of topLevelEntries(tokens, i + 1, skipped.value.next - 1)) {
    const parameter = typeParameter(tokens, start);
    if (!parameter.ok) return parameter;
    read.push(parameter.value);
  }
  return step(read, skipped.value.next);
};

/** The type arguments of the `<…>` from `start` to `end` (exclusive), each
 *  rendered as written without its leading annotations. */
const typeArguments = (tokens: Tokens, start: number, end: number): Read<readonly string[]> => {
  const entries = topLevelEntries(tokens, start + 1, end - 1);
  const read: string[] = [];
  for (const [index, entry] of entries.entries()) {
    const annotated = skipAnnotations(tokens, entry);
    if (!annotated.ok) return annotated;
    const stop = (entries[index + 1] ?? end) - 1;
    read.push(renderType(tokens.slice(annotated.value.next, stop).map((token) => token.text)));
  }
  return ok(read);
};

const annotation = (tokens: Tokens, i: number): Step<null> => {
  const name = qualifiedName(tokens, i + 1, false);
  if (!name.ok) return name;
  if (!isSymbol(tokens, name.value.next, "(")) return step(null, name.value.next);
  const args = skipGroup(tokens, name.value.next);
  return args.ok ? step(null, args.value.next) : args;
};

/** Modifiers in order, annotations skipped. */
const modifiers = (tokens: Tokens, i: number): Step<readonly string[]> => {
  const read: string[] = [];
  let j = i;
  for (;;) {
    if (isAnnotationAt(tokens, j)) {
      const skipped = annotation(tokens, j);
      if (!skipped.ok) return skipped;
      j = skipped.value.next;
    } else if ((isWord(tokens, j) && MODIFIERS.has(wordAt(tokens, j))) || (isWord(tokens, j, "sealed") && isWord(tokens, j + 1))) {
      read.push(wordAt(tokens, j));
      j += 1;
    } else {
      return step(read, j);
    }
  }
};

type TypeName = Readonly<{ texts: readonly string[]; simpleName: string; typeArguments: readonly string[] }>;

/** A type's qualified name with its type arguments, as token texts, and the
 *  last segment's type arguments. */
const typeName = (tokens: Tokens, i: number): Step<TypeName> => {
  if (!isWord(tokens, i)) return unexpected(tokens, i, "a type");
  const texts = [wordAt(tokens, i)];
  let simpleName = wordAt(tokens, i);
  let lastArguments: readonly string[] = [];
  let j = i + 1;
  for (;;) {
    if (isSymbol(tokens, j, "<")) {
      const angles = skipAngles(tokens, j);
      if (!angles.ok) return angles;
      const args = typeArguments(tokens, j, angles.value.next);
      if (!args.ok) return args;
      texts.push(...tokens.slice(j, angles.value.next).map((token) => token.text));
      lastArguments = args.value;
      j = angles.value.next;
    } else if (isSymbol(tokens, j, ".") && isWord(tokens, j + 1)) {
      texts.push(".", wordAt(tokens, j + 1));
      simpleName = wordAt(tokens, j + 1);
      lastArguments = [];
      j += 2;
    } else {
      return step({ texts, simpleName, typeArguments: lastArguments }, j);
    }
  }
};

/** A type: annotations, a qualified name with type arguments, then array
 *  dimensions and varargs. */
const type = (tokens: Tokens, i: number): Step<TypeRef> => {
  const annotated = skipAnnotations(tokens, i);
  if (!annotated.ok) return annotated;
  const name = typeName(tokens, annotated.value.next);
  if (!name.ok) return name;
  const texts = [...name.value.value.texts];
  let j = name.value.next;
  while (isSymbol(tokens, j, "[") && isSymbol(tokens, j + 1, "]")) {
    texts.push("[", "]");
    j += 2;
  }
  if (isSymbol(tokens, j, "...")) {
    texts.push("...");
    j += 1;
  }
  const { simpleName, typeArguments: args } = name.value.value;
  return step({ text: renderType(texts), simpleName, typeArguments: args }, j);
};

const typeList = (tokens: Tokens, i: number): Step<readonly TypeRef[]> => {
  const read: TypeRef[] = [];
  let j = i;
  for (;;) {
    const next = type(tokens, j);
    if (!next.ok) return next;
    read.push(next.value.value);
    if (!isSymbol(tokens, next.value.next, ",")) return step(read, next.value.next);
    j = next.value.next + 1;
  }
};

/** `[]` pairs after a declarator name (the legacy array syntax). */
const dimensions = (tokens: Tokens, i: number): Readonly<{ suffix: string; next: number }> => {
  let j = i;
  while (isSymbol(tokens, j, "[") && isSymbol(tokens, j + 1, "]")) j += 2;
  return { suffix: "[]".repeat((j - i) / 2), next: j };
};

/** One formal parameter's type; null for a receiver parameter (`T this`, `T Outer.this`). */
const parameter = (tokens: Tokens, i: number): Step<string | null> => {
  const leading = modifiers(tokens, i);
  if (!leading.ok) return leading;
  const parameterType = type(tokens, leading.value.next);
  if (!parameterType.ok) return parameterType;
  const k = parameterType.value.next;
  const qualifiedReceiver = parameterType.value.value.simpleName === "this" && (isSymbol(tokens, k, ",") || isSymbol(tokens, k, ")"));
  if (qualifiedReceiver) return step(null, k);
  if (isWord(tokens, k, "this")) return step(null, k + 1);
  const name = expectWord(tokens, k);
  if (!name.ok) return name;
  const dims = dimensions(tokens, name.value.next);
  return step(`${parameterType.value.value.text}${dims.suffix}`, dims.next);
};

/** Formal parameter types of the list opened at `start`. */
const parameters = (tokens: Tokens, start: number): Step<readonly string[]> => {
  if (isSymbol(tokens, start + 1, ")")) return step([], start + 2);
  const read: string[] = [];
  let j = start + 1;
  for (;;) {
    const next = parameter(tokens, j);
    if (!next.ok) return next;
    if (next.value.value !== null) read.push(next.value.value);
    const k = next.value.next;
    if (isSymbol(tokens, k, ")")) return step(read, k + 1);
    if (!isSymbol(tokens, k, ",")) return unexpected(tokens, k, "',' or ')'");
    j = k + 1;
  }
};

/** Whether the `,` at `j` separates two declarators rather than expression operands. */
const endsDeclarator = (tokens: Tokens, j: number): boolean =>
  isSymbol(tokens, j, ",") && isWord(tokens, j + 1) && [";", ",", "=", "["].some((text) => isSymbol(tokens, j + 2, text));

/** Scan an expression up to the `;` or declarator-separating `,` that ends
 *  it, at bracket depth zero; `next` is that terminator's index. */
const expression = (tokens: Tokens, start: number): Step<readonly TypeDeclaration[]> => {
  const declarations: TypeDeclaration[] = [];
  let j = start;
  while (j < tokens.length) {
    if (isOpenerAt(tokens, j)) {
      const group = skipGroup(tokens, j);
      if (!group.ok) return group;
      declarations.push(...group.value.value);
      j = group.value.next;
      continue;
    }
    if (isCloserAt(tokens, j)) return fail(`${where(tokens, j)}: mismatched bracket`);
    if (isSymbol(tokens, j, ";") || endsDeclarator(tokens, j)) return step(declarations, j);
    j += 1;
  }
  return unexpected(tokens, j, "';'");
};

type MethodTail = Readonly<{ hasBody: boolean; locals: readonly TypeDeclaration[] }>;

/** An annotation element's `default` value at `i`, through its `;`. */
const defaultValue = (tokens: Tokens, i: number): Step<MethodTail> => {
  const value = expression(tokens, i + 1);
  if (!value.ok) return value;
  const end = expectSymbol(tokens, value.value.next, ";");
  return end.ok ? step({ hasBody: false, locals: value.value.value }, end.value.next) : end;
};

/** A method or constructor after its parameter list: `throws`, then a
 *  body, `;`, or an annotation element's `default` value. */
const methodTail = (tokens: Tokens, i: number): Step<MethodTail> => {
  let j = i;
  while (j < tokens.length) {
    if (isSymbol(tokens, j, ";")) return step({ hasBody: false, locals: [] }, j + 1);
    if (isSymbol(tokens, j, "{")) {
      const body = skipGroup(tokens, j);
      return body.ok ? step({ hasBody: true, locals: body.value.value }, body.value.next) : body;
    }
    if (isWord(tokens, j, "default")) return defaultValue(tokens, j);
    if (isSymbol(tokens, j, "}") || isSymbol(tokens, j, "=")) return unexpected(tokens, j, "a method body or ';'");
    j += 1;
  }
  return unexpected(tokens, j, "a method body or ';'");
};

/** One variable declarator at `i`: its name, dimensions and initializer, as
 *  a field and the types its initializer declares. */
const declarator = (tokens: Tokens, i: number, fieldModifiers: readonly string[], fieldType: TypeRef): Step<readonly Member[]> => {
  const name = expectWord(tokens, i);
  if (!name.ok) return name;
  const dims = dimensions(tokens, name.value.next);
  const typeToken = `${fieldType.text}${dims.suffix}`;
  const field = (initializerStrings: readonly string[]): Member => ({
    kind: "field",
    field: { name: name.value.value, modifiers: fieldModifiers, typeToken, initializerStrings },
  });
  if (!isSymbol(tokens, dims.next, "=")) return step([field([])], dims.next);
  const initializer = expression(tokens, dims.next + 1);
  if (!initializer.ok) return initializer;
  const initializerStrings = stringsBetween(tokens, dims.next + 1, initializer.value.next);
  return step([field(initializerStrings), ...localTypesMember(initializer.value.value)], initializer.value.next);
};

/** One declaration statement's fields, from its first declarator name at `i`. */
const fields = (tokens: Tokens, i: number, fieldModifiers: readonly string[], fieldType: TypeRef): Step<readonly Member[]> => {
  const read: Member[] = [];
  let j = i;
  for (;;) {
    const next = declarator(tokens, j, fieldModifiers, fieldType);
    if (!next.ok) return next;
    read.push(...next.value.value);
    const k = next.value.next;
    if (isSymbol(tokens, k, ";")) return step(read, k + 1);
    if (!isSymbol(tokens, k, ",")) return unexpected(tokens, k, "',' or ';'");
    j = k + 1;
  }
};

/** A constructor (or a record's compact constructor) at `j`; it contributes
 *  only the types its body declares. */
const constructorMember = (tokens: Tokens, j: number, compact: boolean): Step<readonly Member[]> => {
  const params = compact ? step([], j + 1) : parameters(tokens, j + 1);
  if (!params.ok) return params;
  const tail = methodTail(tokens, params.value.next);
  return tail.ok ? step(localTypesMember(tail.value.value.locals), tail.value.next) : tail;
};

/** A method, or a field declaration statement, whose type starts at `j`. */
const methodOrFields = (
  tokens: Tokens,
  j: number,
  declared: readonly string[],
  typeParameters: readonly TypeParameter[],
): Step<readonly Member[]> => {
  const memberType = type(tokens, j);
  if (!memberType.ok) return memberType;
  const name = expectWord(tokens, memberType.value.next);
  if (!name.ok) return name;
  if (!isSymbol(tokens, name.value.next, "(")) return fields(tokens, memberType.value.next, declared, memberType.value.value);
  const params = parameters(tokens, name.value.next);
  if (!params.ok) return params;
  const tail = methodTail(tokens, params.value.next);
  if (!tail.ok) return tail;
  const method: Method = {
    kind: "method",
    name: name.value.value,
    modifiers: declared,
    typeParameters,
    parameterTypes: params.value.value,
    hasBody: tail.value.value.hasBody,
  };
  return step([method, ...localTypesMember(tail.value.value.locals)], tail.value.next);
};

/** One class-body member at `i`. */
const member = (tokens: Tokens, i: number, owner: Owner): Step<readonly Member[]> => {
  if (isSymbol(tokens, i, ";")) return step([], i + 1);
  const memberModifiers = modifiers(tokens, i);
  if (!memberModifiers.ok) return memberModifiers;
  const declared = memberModifiers.value.value;
  const j = memberModifiers.value.next;
  if (isSymbol(tokens, j, "{")) {
    const block = skipGroup(tokens, j);
    return block.ok ? step(localTypesMember(block.value.value), block.value.next) : block;
  }
  if (startsTypeDeclaration(tokens, j)) {
    const nested = typeDeclaration(tokens, j, declared);
    return nested.ok ? step([{ kind: "member-type", declaration: nested.value.value }], nested.value.next) : nested;
  }
  const declaredTypeParameters = typeParameters(tokens, j);
  if (!declaredTypeParameters.ok) return declaredTypeParameters;
  const k = declaredTypeParameters.value.next;
  const compact = owner.kind === "record" && isWord(tokens, k, owner.name) && isSymbol(tokens, k + 1, "{");
  if (compact || (isWord(tokens, k) && isSymbol(tokens, k + 1, "("))) return constructorMember(tokens, k, compact);
  return methodOrFields(tokens, k, declared, declaredTypeParameters.value.value);
};

/** One enum constant at `i`: annotations, name, arguments and body, through
 *  its `,`; `next` stops at a `;` or `}` that ends the constants. */
const enumConstant = (tokens: Tokens, i: number): Step<readonly TypeDeclaration[]> => {
  const annotations = modifiers(tokens, i);
  if (!annotations.ok) return annotations;
  const constant = expectWord(tokens, annotations.value.next);
  if (!constant.ok) return constant;
  const locals: TypeDeclaration[] = [];
  let j = constant.value.next;
  for (const opener of ["(", "{"]) {
    if (!isSymbol(tokens, j, opener)) continue;
    const group = skipGroup(tokens, j);
    if (!group.ok) return group;
    locals.push(...group.value.value);
    j = group.value.next;
  }
  if (isSymbol(tokens, j, ",")) return step(locals, j + 1);
  if (isSymbol(tokens, j, ";") || isSymbol(tokens, j, "}")) return step(locals, j);
  return unexpected(tokens, j, "',', ';' or '}'");
};

/** An enum's constants, from just inside its body to just before its
 *  first member (after the `;`) or its closing brace. */
const enumConstants = (tokens: Tokens, i: number): Step<readonly Member[]> => {
  const locals: TypeDeclaration[] = [];
  let j = i;
  for (;;) {
    if (isSymbol(tokens, j, ";")) return step(localTypesMember(locals), j + 1);
    if (isSymbol(tokens, j, "}")) return step(localTypesMember(locals), j);
    const constant = enumConstant(tokens, j);
    if (!constant.ok) return constant;
    locals.push(...constant.value.value);
    j = constant.value.next;
  }
};

/** A class body opened at `start`. */
const body = (tokens: Tokens, start: number, owner: Owner): Step<readonly Member[]> => {
  const read: Member[] = [];
  let j = start + 1;
  if (owner.kind === "enum") {
    const constants = enumConstants(tokens, j);
    if (!constants.ok) return constants;
    read.push(...constants.value.value);
    j = constants.value.next;
  }
  while (!isSymbol(tokens, j, "}")) {
    if (j >= tokens.length) return fail(`end of file: the body of ${owner.name} opened at ${where(tokens, start)} is never closed`);
    const next = member(tokens, j, owner);
    if (!next.ok) return next;
    read.push(...next.value.value);
    j = next.value.next;
  }
  return step(read, j + 1);
};

type Supertypes = Readonly<{ supertypes: readonly TypeRef[]; permits: readonly string[] | null }>;

/** The `extends`, `implements` and `permits` clauses at `i`, in any order. */
const supertypeClauses = (tokens: Tokens, i: number): Step<Supertypes> => {
  const supertypes: TypeRef[] = [];
  let permits: readonly string[] | null = null;
  let j = i;
  while (isWord(tokens, j, "extends") || isWord(tokens, j, "implements") || isWord(tokens, j, "permits")) {
    const list = typeList(tokens, j + 1);
    if (!list.ok) return list;
    if (isWord(tokens, j, "permits")) permits = list.value.value.map((ref) => ref.simpleName);
    else supertypes.push(...list.value.value);
    j = list.value.next;
  }
  return step({ supertypes, permits }, j);
};

/** After a type's name: its type parameters and, for a record, its header. */
const typeHeader = (tokens: Tokens, i: number, kind: TypeKind): Step<readonly TypeParameter[]> => {
  const declared = typeParameters(tokens, i);
  if (!declared.ok || kind !== "record") return declared;
  const j = declared.value.next;
  const components = isSymbol(tokens, j, "(") ? skipGroup(tokens, j) : unexpected(tokens, j, "a record header");
  return components.ok ? step(declared.value.value, components.value.next) : components;
};

/** A type declaration whose keyword is at `i`, with its modifiers already read. */
const typeDeclaration = (tokens: Tokens, i: number, declaredModifiers: readonly string[]): Step<TypeDeclaration> => {
  const kind = typeKindAt(tokens, i);
  const name = expectWord(tokens, kind === "annotation" ? i + 2 : i + 1);
  if (!name.ok) return name;
  const header = typeHeader(tokens, name.value.next, kind);
  if (!header.ok) return header;
  const clauses = supertypeClauses(tokens, header.value.next);
  if (!clauses.ok) return clauses;
  const j = clauses.value.next;
  if (!isSymbol(tokens, j, "{")) return unexpected(tokens, j, `the body of ${name.value.value}`);
  const members = body(tokens, j, { kind, name: name.value.value });
  if (!members.ok) return members;
  const { supertypes, permits } = clauses.value.value;
  return step(
    { kind, name: name.value.value, modifiers: declaredModifiers, typeParameters: header.value.value, supertypes, permits, members: members.value.value },
    members.value.next,
  );
};

const packageDeclaration = (tokens: Tokens): Step<string | null> => {
  const leading = modifiers(tokens, 0);
  if (!leading.ok) return leading;
  if (!isWord(tokens, leading.value.next, "package")) return step(null, 0);
  const name = qualifiedName(tokens, leading.value.next + 1, false);
  if (!name.ok) return name;
  const end = expectSymbol(tokens, name.value.next, ";");
  return end.ok ? step(name.value.value, end.value.next) : end;
};

/** The `import` lines at `i`, static ones included, as the names they import. */
const importDeclarations = (tokens: Tokens, i: number): Step<readonly string[]> => {
  const imports: string[] = [];
  let j = i;
  while (isWord(tokens, j, "import")) {
    const name = qualifiedName(tokens, isWord(tokens, j + 1, "static") ? j + 2 : j + 1, true);
    if (!name.ok) return name;
    const end = expectSymbol(tokens, name.value.next, ";");
    if (!end.ok) return end;
    imports.push(name.value.value);
    j = end.value.next;
  }
  return step(imports, j);
};

/** The top-level type declarations from `i` to the end of the file. */
const topLevelTypes = (tokens: Tokens, i: number): Read<readonly TypeDeclaration[]> => {
  const types: TypeDeclaration[] = [];
  let j = i;
  while (j < tokens.length) {
    if (isSymbol(tokens, j, ";")) {
      j += 1;
      continue;
    }
    const declared = modifiers(tokens, j);
    if (!declared.ok) return declared;
    if (!startsTypeDeclaration(tokens, declared.value.next)) return unexpected(tokens, declared.value.next, "a type declaration");
    const declaration = typeDeclaration(tokens, declared.value.next, declared.value.value);
    if (!declaration.ok) return declaration;
    types.push(declaration.value.value);
    j = declaration.value.next;
  }
  return ok(types);
};

/** Read the declarations of a token stream. Total: every malformation is a
 *  failed `Read` naming where it is — a line, or the end of the file when
 *  the input ends inside a declaration. */
const readCompilationUnit = (tokens: Tokens): Read<CompilationUnit> => {
  const pkg = packageDeclaration(tokens);
  if (!pkg.ok) return pkg;
  const imports = importDeclarations(tokens, pkg.value.next);
  if (!imports.ok) return imports;
  const types = topLevelTypes(tokens, imports.value.next);
  return types.ok ? ok({ package: pkg.value.value, imports: imports.value.value, types: types.value }) : types;
};

const readSource = (text: string): Read<CompilationUnit> => {
  const translated = translateUnicodeEscapes(text);
  if (!translated.ok) return translated;
  const tokens = lex(translated.value);
  return tokens.ok ? readCompilationUnit(tokens.value) : tokens;
};

// ---------------------------------------------------------------------------
// Declaration queries (pure)
// ---------------------------------------------------------------------------

/** `declaration` and every type nested in it, pre-order; local types too when asked. */
const declarationsIn = (declaration: TypeDeclaration, withLocals: boolean): readonly TypeDeclaration[] => [
  declaration,
  ...declaration.members.flatMap((member) =>
    match(member)
      .with({ kind: "member-type" }, ({ declaration: nested }) => declarationsIn(nested, withLocals))
      .with({ kind: "local-types" }, ({ declarations }) => (withLocals ? declarations.flatMap((local) => declarationsIn(local, withLocals)) : []))
      .with({ kind: "method" }, { kind: "field" }, () => [])
      .exhaustive(),
  ),
];

const memberTypes = (declaration: TypeDeclaration): readonly TypeDeclaration[] =>
  declaration.members.flatMap((member) => (member.kind === "member-type" ? [member.declaration] : []));

const isSealed = (declaration: TypeDeclaration): boolean => declaration.modifiers.includes("sealed");

/** Explicit `permits`, or — for a sealed type without one — every type the
 *  file declares with it as a direct supertype (JLS 8.1.6, 9.1.4). */
const permittedNames = (declaration: TypeDeclaration, all: readonly TypeDeclaration[]): readonly string[] =>
  declaration.permits ??
  (isSealed(declaration)
    ? all
      .filter((other) => other !== declaration && other.supertypes.some((ref) => ref.simpleName === declaration.name))
      .map((other) => other.name)
    : []);

const isObjectMethod = (method: Method): boolean =>
  (method.name === "equals" && method.parameterTypes.length === 1 && ["Object", "java.lang.Object"].includes(method.parameterTypes[0] ?? "")) ||
  ((method.name === "hashCode" || method.name === "toString") && method.parameterTypes.length === 0);

const isAbstract = (method: Method): boolean =>
  !method.hasBody && !method.modifiers.some((modifier) => modifier === "default" || modifier === "static" || modifier === "private");

/** A method as seen from one interface: its parameter types with every
 *  ancestor's type parameters replaced by the type arguments that interface
 *  (transitively) supplies. */
type SeenMethod = Readonly<{ method: Method; parameterTypes: readonly string[] }>;

/** Type parameter name to the text that stands for it. */
type TypeBindings = ReadonlyMap<string, string>;

const boundsOf = (parameters: readonly TypeParameter[]): TypeBindings =>
  new Map(parameters.map((parameter) => [parameter.name, parameter.bound] as const));

/** `text` without its type arguments: every `<…>` group removed. */
const withoutTypeArguments = (text: string): string =>
  [...text].reduce(
    (acc, char) => {
      const depth = acc.depth + (char === "<" ? 1 : 0) - (char === ">" ? 1 : 0);
      const kept = acc.depth === 0 && depth === 0 ? acc.kept + char : acc.kept;
      return { depth, kept };
    },
    { depth: 0, kept: "" },
  ).kept;

/** The erasure of a type as written (JLS 4.6), keyed by simple name: type
 *  arguments dropped, varargs as an array dimension, and a type variable
 *  replaced by the erasure of its first bound. */
const erasure = (text: string, bounds: TypeBindings): string => {
  const bare = withoutTypeArguments(text).replace(/\s+/g, "");
  const dimensions = (bare.match(/\[\]|\.\.\./g) ?? []).length;
  const base = bare.replace(/\[\]|\.\.\./g, "");
  const simple = base.split(".").at(-1) ?? base;
  const bound = base.includes(".") ? undefined : bounds.get(simple);
  const erased = bound === undefined ? simple : erasure(bound, new Map([...bounds].filter(([name]) => name !== simple)));
  return `${erased}${"[]".repeat(dimensions)}`;
};

const IDENTIFIER = /(?<![\p{L}\p{N}_$.])[\p{L}_$][\p{L}\p{N}_$]*/gu;

/** `text` with every unqualified identifier bound in `bindings` replaced. */
const substitute = (text: string, bindings: TypeBindings): string =>
  bindings.size === 0 ? text : text.replace(IDENTIFIER, (name) => bindings.get(name) ?? name);

/** What a parent's type parameters stand for through `ref`: its type
 *  arguments, or — for a raw reference — their bounds. */
const parentBindings = (parent: TypeDeclaration, ref: TypeRef): TypeBindings => {
  const parameters = parent.typeParameters;
  const raw = ref.typeArguments.length !== parameters.length;
  return new Map(parameters.map((parameter, index) => [parameter.name, raw ? parameter.bound : (ref.typeArguments[index] ?? parameter.bound)] as const));
};

/** A parent's method seen from the child; the method's own type parameters shadow the parent's. */
const seenThrough = (seen: SeenMethod, bindings: TypeBindings): SeenMethod => {
  const shadowed = new Set(seen.method.typeParameters.map((parameter) => parameter.name));
  const visible: TypeBindings = new Map([...bindings].filter(([name]) => !shadowed.has(name)));
  return { method: seen.method, parameterTypes: seen.parameterTypes.map((text) => substitute(text, visible)) };
};

/** The override-equivalence key (JLS 8.4.2) of a method seen from `declaration`:
 *  its name and erased parameter types. */
const signature = (declaration: TypeDeclaration, seen: SeenMethod): string => {
  const bounds: TypeBindings = new Map([...boundsOf(declaration.typeParameters), ...boundsOf(seen.method.typeParameters)]);
  return `${seen.method.name}(${seen.parameterTypes.map((text) => erasure(text, bounds)).join(",")})`;
};

/** The abstract methods of an interface by override-equivalence key,
 *  inherited ones included; null when a parent is not an interface this file
 *  declares, or the hierarchy is cyclic. */
const abstractMethods = (
  declaration: TypeDeclaration,
  interfaces: ReadonlyMap<string, TypeDeclaration>,
  visiting: ReadonlySet<string>,
): ReadonlyMap<string, SeenMethod> | null => {
  if (visiting.has(declaration.name)) return null;
  const path = new Set([...visiting, declaration.name]);
  const inherited = declaration.supertypes.map((ref) => {
    const parent = interfaces.get(ref.simpleName);
    const methods = parent === undefined ? null : abstractMethods(parent, interfaces, path);
    return parent === undefined || methods === null ? null : [...methods.values()].map((seen) => seenThrough(seen, parentBindings(parent, ref)));
  });
  const resolved = inherited.filter((methods): methods is SeenMethod[] => methods !== null);
  if (resolved.length !== inherited.length) return null;
  const keyed = (seen: SeenMethod) => [signature(declaration, seen), seen] as const;
  const own = declaration.members.flatMap((member) => (member.kind === "method" && !isObjectMethod(member) ? [member] : []));
  return own.reduce<ReadonlyMap<string, SeenMethod>>((methods, method) => {
    const [key, seen] = keyed({ method, parameterTypes: method.parameterTypes });
    if (isAbstract(method)) return new Map([...methods, [key, seen]]);
    if (!method.modifiers.includes("default")) return methods;
    return new Map([...methods].filter(([other]) => other !== key));
  }, new Map(resolved.flat().map(keyed)));
};

const NOT_A_FUNCTION: AliasShape = { kind: "not-a-function" };

/** A functional interface (JLS 9.8): a non-sealed interface with exactly one
 *  abstract method. Generic when the interface or that method declares type
 *  parameters. */
const aliasShape = (declaration: TypeDeclaration, interfaces: ReadonlyMap<string, TypeDeclaration>): AliasShape => {
  if (declaration.kind !== "interface" || isSealed(declaration)) return NOT_A_FUNCTION;
  const methods = abstractMethods(declaration, interfaces, new Set());
  const [only, ...rest] = [...(methods?.values() ?? [])];
  if (only === undefined || rest.length > 0) return NOT_A_FUNCTION;
  const generic = declaration.typeParameters.length > 0 || only.method.typeParameters.length > 0;
  return { kind: "function", generic, parameterCount: only.parameterTypes.length };
};

const frozenAdt = (declaration: TypeDeclaration, all: readonly TypeDeclaration[]): readonly FrozenAdt[] => {
  if (declaration.kind === "interface" && isSealed(declaration)) {
    return [{ kind: "sealed-interface", name: declaration.name, variants: permittedNames(declaration, all) }];
  }
  return declaration.kind === "record" ? [{ kind: "record", name: declaration.name }] : [];
};

const HOLDER_RULE = "a frozen Java types file declares exactly one top-level public interface or public final class (the holder)";

const describeDeclaration = (declaration: TypeDeclaration): string =>
  [
    ...declaration.modifiers,
    match(declaration.kind)
      .with("annotation", () => "@interface")
      .with("class", "interface", "record", "enum", (kind) => kind)
      .exhaustive(),
    declaration.name,
  ].join(" ");

/** The holder, or why the file's top-level shape is none. */
const holderOf = (types: readonly TypeDeclaration[]): Read<TypeDeclaration> => {
  const [only, ...rest] = types;
  if (only === undefined) return fail(`declares no top-level type; ${HOLDER_RULE}`);
  if (rest.length > 0) return fail(`declares ${types.length} top-level types (${types.map((type) => type.name).join(", ")}); ${HOLDER_RULE}`);
  const isPublic = only.modifiers.includes("public");
  const isHolder = isPublic && (only.kind === "interface" || (only.kind === "class" && only.modifiers.includes("final")));
  return isHolder ? ok(only) : fail(`its top-level type is \`${describeDeclaration(only)}\`; ${HOLDER_RULE}`);
};

const INTERFACE_FIELD_MODIFIERS: readonly string[] = ["public", "static", "final"];

/** Fields with the implicit `public static final` of an interface's fields. */
const fieldsOf = (declaration: TypeDeclaration): readonly JavaField[] => {
  const implicit = declaration.kind === "interface" || declaration.kind === "annotation" ? INTERFACE_FIELD_MODIFIERS : [];
  return declaration.members.flatMap((member) =>
    member.kind !== "field"
      ? []
      : [{ ...member.field, modifiers: [...member.field.modifiers, ...implicit.filter((modifier) => !member.field.modifiers.includes(modifier))] }]);
};

const localType = (declaration: TypeDeclaration, all: readonly TypeDeclaration[]): JavaLocalType => ({
  name: declaration.name,
  kind: declaration.kind === "annotation" ? "interface" : declaration.kind,
  sealed: isSealed(declaration),
  permits: permittedNames(declaration, all),
});

/** The simple class name a `.java` path's basename gives. */
const classNameOf = (path: string): string => (path.split("/").at(-1) ?? "").replace(/\.java$/, "");

// ---------------------------------------------------------------------------
// Entry points
// ---------------------------------------------------------------------------

const unparseable = (path: string, detail: string): DomainResult<never, SurfaceProblem> => ({
  ok: false,
  error: { kind: "unparseable", path, detail },
});

/** Read a frozen Java types file; refuses any shape other than one top-level
 *  holder (`unsupported-holder-shape`). */
export const readJavaTypesSurface: ReadJavaTypesSurfaceFn = (path, text) => {
  const unit = readSource(text);
  if (!unit.ok) return unparseable(path, unit.error);
  const holder = holderOf(unit.value.types);
  if (!holder.ok) return { ok: false, error: { kind: "unsupported-holder-shape", path, detail: holder.error } };
  const nested = memberTypes(holder.value);
  const all = declarationsIn(holder.value, false);
  // Built from the reversed list, so the first declaration of a simple name wins.
  const interfaces = new Map(
    [...all].reverse().filter((declaration) => declaration.kind === "interface").map((declaration) => [declaration.name, declaration] as const),
  );
  const aliases: readonly DeclaredAlias[] = nested.map((declaration) => ({ name: declaration.name, shape: aliasShape(declaration, interfaces) }));
  const adts = nested.flatMap((declaration) => declarationsIn(declaration, false)).flatMap((declaration) => frozenAdt(declaration, all));
  return {
    ok: true,
    value: { language: "java", path, package: unit.value.package, holder: holder.value.name, aliases, adts },
  };
};

/** Read a Java implementation file: its package and imports, the fields of
 *  the top-level type named after the file, and every type it declares at
 *  any depth. */
export const readJavaImplementationSurface: ReadJavaImplementationSurfaceFn = (path, text) => {
  const unit = readSource(text);
  if (!unit.ok) return unparseable(path, unit.error);
  const all = unit.value.types.flatMap((declaration) => declarationsIn(declaration, true));
  const named = unit.value.types.find((declaration) => declaration.name === classNameOf(path));
  return {
    ok: true,
    value: {
      language: "java",
      path,
      package: unit.value.package,
      imports: unit.value.imports,
      fields: named === undefined ? [] : fieldsOf(named),
      localTypes: all.map((declaration) => localType(declaration, all)),
    },
  };
};
