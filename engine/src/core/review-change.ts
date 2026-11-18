/**
 * Change Class (ADR-0093): what changed in a reviewed Task since the review
 * its re-review is judged against (its Review Basis), and the reviewer roles
 * that change needs.
 *
 * - `classifyReviewChange` compares a before/after view the shell assembled:
 *   the reviewed files' bytes and the Task context a reviewer packet presents.
 * - `selectReviewRoles` maps the change to the roles of the derived roster it
 *   needs, by the operator's role table.
 *
 * Conservative throughout: anything this module cannot read with certainty is
 * a code change, and a code change is reviewed by the whole roster.
 *
 * Pure: no I/O, no clock, no randomness.
 */
import {
  issuedWaveReviewRoster,
  type IssuedWaveReviewRoster,
  type WaveReviewRole,
  type WaveReviewRoster,
} from "./agent-catalog-projections";
import { NARROWING_CHANGE_CLASSES, type NarrowingChangeClass } from "./findings-shape";
import { canonicalStructuralEquals, isNonEmpty, type NonEmpty } from "./orchestration-contract";
import { isTestFileBySuffixes } from "./test-file-classification";

/** The kinds of change one reviewed file can show, in report order. */
export const CHANGE_CLASSES = Object.freeze([...NARROWING_CHANGE_CLASSES, "code"] as const);

/** One kind of change: comment-only, doc-only, test-only or code. */
export type ChangeClass = NarrowingChangeClass | "code";

/** A reviewed file's content as the view holds it. */
export type ReviewFileContent =
  | Readonly<{ kind: "absent" }>
  | Readonly<{ kind: "text"; text: string }>
  | Readonly<{ kind: "binary"; base64: string }>;

/** One reviewed file. */
export type ReviewedFile = Readonly<{ path: string; content: ReviewFileContent }>;

/**
 * One packet section as a basis presents it: observed (its rendered text, or
 * null when the packet carried none), or not observable from the basis.
 */
export type SectionFact = Readonly<{ kind: "observed"; text: string | null }> | Readonly<{ kind: "unobserved" }>;

/** Everything a reviewer packet presents of a Task besides its bytes and Findings. */
export type ReviewContextFacts = Readonly<{
  description: string;
  agent: string;
  planContext: string | null;
  specAnchors: readonly string[];
  specContributions: readonly string[];
  declaredFiles: readonly string[];
  planFile: string | null;
  ownerMap: SectionFact;
  contractSurface: SectionFact;
}>;

/** One side of the comparison: the reviewed files and the presented context. */
export type ReviewChangeSide = Readonly<{ files: readonly ReviewedFile[]; context: ReviewContextFacts }>;

/**
 * What changed between the basis and now:
 * - `unchanged`: the same bytes and context, so nothing names the roles a
 *   re-review needs;
 * - `scope-changed`: a reviewed path was added or removed;
 * - `context-changed`: the presented context differs, or the basis cannot show it;
 * - `changed`: the classes of the changed files, distinct, in `CHANGE_CLASSES` order.
 */
export type ReviewChange =
  | Readonly<{ kind: "unchanged" }>
  | Readonly<{ kind: "scope-changed" }>
  | Readonly<{ kind: "context-changed" }>
  | Readonly<{ kind: "changed"; classes: NonEmpty<ChangeClass> }>;

/** Documentation files: a change to one is a doc change. */
const DOC_SUFFIXES = Object.freeze([".md", ".mdx", ".markdown", ".rst", ".adoc", ".txt"]);

/**
 * Sources whose comments `commentStrippedSource` reads: C-family comment
 * syntax with JavaScript's strings, templates and regular expressions, or
 * Java's strings. JSX and TSX are not here: `//` in JSX text is text.
 */
const COMMENT_LEXED_SUFFIXES = Object.freeze([".ts", ".mts", ".cts", ".js", ".mjs", ".cjs", ".java"]);

const endsWithAny = (path: string, suffixes: readonly string[]): boolean => {
  const lower = path.toLowerCase();
  return suffixes.some((suffix) => lower.endsWith(suffix));
};

/** The class of one file's change, or null when its content is unchanged. */
function fileChangeClass(
  path: string,
  before: ReviewFileContent,
  after: ReviewFileContent,
  testFileSuffixes: readonly string[],
): ChangeClass | null {
  if (canonicalStructuralEquals(before, after)) return null;
  if (isTestFileBySuffixes(path, testFileSuffixes)) return "test";
  if (endsWithAny(path, DOC_SUFFIXES)) return "doc";
  if (before.kind !== "text" || after.kind !== "text" || !endsWithAny(path, COMMENT_LEXED_SUFFIXES)) return "code";
  const stripped = commentStrippedSource(before.text);
  return stripped !== null && stripped === commentStrippedSource(after.text) ? "comment" : "code";
}

const sameContext = (before: ReviewContextFacts, after: ReviewContextFacts): boolean =>
  before.ownerMap.kind === "observed" && before.contractSurface.kind === "observed" &&
  after.ownerMap.kind === "observed" && after.contractSurface.kind === "observed" &&
  canonicalStructuralEquals(before, after);

/** The paths of `files`, sorted. */
const pathsOf = (files: readonly ReviewedFile[]): readonly string[] => files.map(({ path }) => path).sort();

/**
 * What changed from `before` to `after`. A path added or removed is a scope
 * change; a differing or unobservable context is a context change; otherwise
 * each changed file contributes its class.
 */
export function classifyReviewChange(
  before: ReviewChangeSide,
  after: ReviewChangeSide,
  testFileSuffixes: readonly string[],
): ReviewChange {
  const paths = pathsOf(after.files);
  if (!canonicalStructuralEquals(pathsOf(before.files), paths) || new Set(paths).size !== paths.length) {
    return Object.freeze({ kind: "scope-changed" });
  }
  if (!sameContext(before.context, after.context)) return Object.freeze({ kind: "context-changed" });
  const found = new Set<ChangeClass>();
  for (const { path, content } of after.files) {
    const previous = before.files.find((file) => file.path === path);
    const changed = previous === undefined ? "code" : fileChangeClass(path, previous.content, content, testFileSuffixes);
    if (changed !== null) found.add(changed);
  }
  const classes = CHANGE_CLASSES.filter((changeClass) => found.has(changeClass));
  return isNonEmpty(classes)
    ? Object.freeze({ kind: "changed", classes: Object.freeze(classes) })
    : Object.freeze({ kind: "unchanged" });
}

/** The roles each narrowing change class needs (the operator's role table). */
const ROLES_FOR: Readonly<Record<NarrowingChangeClass, readonly WaveReviewRole[]>> = Object.freeze({
  comment: ["comment-analyzer"],
  doc: ["comment-analyzer"],
  test: ["code-reviewer", "pr-test-analyzer"],
});

/**
 * The change classes of `change` that narrow a roster, or null when the
 * change needs the whole roster: unchanged, a scope or context change, or any
 * code.
 */
export function narrowingClassesOf(change: ReviewChange): NonEmpty<NarrowingChangeClass> | null {
  if (change.kind !== "changed") return null;
  const narrowing = change.classes.flatMap((changeClass) => (changeClass === "code" ? [] : [changeClass]));
  return narrowing.length === change.classes.length && isNonEmpty(narrowing) ? narrowing : null;
}

/**
 * The roster a re-review of `change` is issued from `derived`: the whole
 * roster for a change that needs it, otherwise the roles its classes need
 * together with every role of `derived` in `priorOwners` (the owners of the
 * prior Findings the run is issued), in roster order.
 */
export function selectReviewRoles(
  derived: WaveReviewRoster,
  change: ReviewChange,
  priorOwners: readonly string[],
): IssuedWaveReviewRoster {
  const classes = narrowingClassesOf(change);
  if (classes === null) return derived;
  return issuedWaveReviewRoster(derived, [...classes.flatMap((changeClass) => ROLES_FOR[changeClass]), ...priorOwners]);
}

// ---------------------------------------------------------------------------
// The comment lexer
// ---------------------------------------------------------------------------

/** Characters after which a `/` starts a regular expression rather than a division. */
const REGEX_PRECEDERS = new Set(["(", ",", "=", ":", "[", "!", "&", "|", "?", "{", "}", ";", "+", "-", "*", "%", "<", ">", "~", "^"]);

/** Words after which a `/` starts a regular expression rather than a division. */
const REGEX_KEYWORDS = new Set([
  "return", "typeof", "case", "do", "else", "in", "instanceof", "new", "delete", "void", "throw", "yield", "await", "of",
]);

const isWordChar = (char: string): boolean => /[A-Za-z0-9_$]/.test(char);

/**
 * The lexer's state while it reads one source. Local to one
 * `commentStrippedSource` call: each step reads and advances it.
 */
type Lexer = {
  readonly source: string;
  index: number;
  out: string;
  pendingSpace: boolean;
  pendingBreak: boolean;
  /** The last code character emitted, ignoring whitespace. */
  previous: string;
  /** The last word emitted, when `previous` ended one. */
  previousWord: string;
  divisionOnLine: boolean;
  /** One brace depth per open template substitution. */
  readonly substitutions: number[];
  /** Inside a template literal's text, or in code. */
  mode: "code" | "template";
};

/** Emit the pending separator; whether one was emitted. */
function flush(lexer: Lexer): boolean {
  const separator = lexer.out === "" ? "" : lexer.pendingBreak ? "\n" : lexer.pendingSpace && !lexer.out.endsWith("\n") ? " " : "";
  lexer.out += separator;
  lexer.pendingSpace = false;
  lexer.pendingBreak = false;
  return separator !== "";
}

/** Emit one code token, a single character or a whole literal, and advance past it. */
function emitCode(lexer: Lexer, text: string): void {
  const separated = flush(lexer);
  const continuesWord = text.length === 1 && isWordChar(text) && !separated && lexer.previousWord !== "";
  lexer.out += text;
  lexer.previous = text.at(-1) ?? "";
  lexer.previousWord = text.length === 1 && isWordChar(text) ? (continuesWord ? lexer.previousWord + text : text) : "";
  lexer.index += text.length;
}

/** One step inside a template literal's text; false when the source cannot be read. */
function templateStep(lexer: Lexer, char: string, next: string): boolean {
  if (char === "\\") {
    if (lexer.index + 1 >= lexer.source.length) return false;
    lexer.out += char + next;
    lexer.index += 2;
  } else if (char === "`" || (char === "$" && next === "{")) {
    const opens = char === "$";
    lexer.out += opens ? "${" : "`";
    if (opens) lexer.substitutions.push(0);
    lexer.previous = opens ? "{" : "`";
    lexer.previousWord = "";
    lexer.mode = "code";
    lexer.index += opens ? 2 : 1;
  } else {
    lexer.out += char;
    lexer.index += 1;
  }
  return true;
}

/**
 * One step over whitespace or a comment in code: "next" when it consumed one,
 * "refuse" when the source cannot be read, "token" when a token starts here.
 */
function triviaStep(lexer: Lexer, char: string, next: string): "next" | "refuse" | "token" {
  const { source, index } = lexer;
  if (char === "\n") {
    lexer.pendingBreak = true;
    lexer.divisionOnLine = false;
    lexer.index += 1;
    return "next";
  }
  if (char === " " || char === "\t" || char === "\r" || char === "\f" || char === "\v") {
    lexer.pendingSpace = true;
    lexer.index += 1;
    return "next";
  }
  if (char !== "/" || (next !== "/" && next !== "*")) return "token";
  if (lexer.divisionOnLine) return "refuse";
  const end = next === "/" ? source.indexOf("\n", index) : source.indexOf("*/", index + 2);
  if (next === "/") {
    lexer.index = end < 0 ? source.length : end;
    return "next";
  }
  if (end < 0) return "refuse";
  const spansLine = source.slice(index, end).includes("\n");
  lexer.pendingBreak ||= spansLine;
  lexer.pendingSpace ||= !spansLine;
  if (spansLine) lexer.divisionOnLine = false;
  lexer.index = end + 2;
  return "next";
}

/** One code token: a literal, a slash, a brace or one character; false when the source cannot be read. */
function tokenStep(lexer: Lexer, char: string, next: string): boolean {
  const { source, index, substitutions } = lexer;
  if (char === "'" || char === "\"") {
    const end = quotedEnd(source, index, char);
    if (end !== null) emitCode(lexer, source.slice(index, end));
    return end !== null;
  }
  if (char === "`") {
    emitCode(lexer, "`");
    lexer.mode = "template";
    return true;
  }
  if (char === "/") {
    const regex = startsRegex(lexer.previous, lexer.previousWord);
    const end = regex ? regexEnd(source, index) : null;
    if (regex && end === null) return false;
    lexer.divisionOnLine ||= end === null;
    emitCode(lexer, end === null ? "/" : source.slice(index, end));
    return true;
  }
  if (char === "}" && substitutions.at(-1) === 0) {
    substitutions.pop();
    flush(lexer);
    lexer.out += "}";
    lexer.mode = "template";
    lexer.index += 1;
    return true;
  }
  if (substitutions.length > 0 && (char === "{" || char === "}")) {
    substitutions[substitutions.length - 1] = (substitutions.at(-1) ?? 0) + (char === "{" ? 1 : -1);
  }
  if (char === "\\" && index + 1 >= source.length) return false;
  emitCode(lexer, char === "\\" ? char + next : char);
  return true;
}

/**
 * `source` with its comments removed and the whitespace between code tokens
 * normalised, or null when the source cannot be read with certainty.
 *
 * Strings, template literals and regular expressions are kept verbatim. A
 * removed block comment leaves a line break if it spanned one, otherwise a
 * space, so automatic semicolon insertion reads the result as it read the
 * source. Between code tokens a run of blanks becomes one space, a run of
 * line breaks one line break, and blanks at a line's start or end vanish.
 *
 * Null for an unterminated string, template, regular expression or block
 * comment; a quote inside a regular expression; and a comment on a line
 * where an earlier `/` was read as a division, since that `/` may have opened
 * a regular expression holding the comment's marker. Idempotent: a stripped
 * source strips to itself.
 */
export function commentStrippedSource(source: string): string | null {
  const lexer: Lexer = {
    source, index: 0, out: "", pendingSpace: false, pendingBreak: false, previous: "", previousWord: "",
    divisionOnLine: false, substitutions: [], mode: "code",
  };
  while (lexer.index < source.length) {
    const char = source[lexer.index] as string;
    const next = source[lexer.index + 1] ?? "";
    if (lexer.mode === "template") {
      if (!templateStep(lexer, char, next)) return null;
      continue;
    }
    const trivia = triviaStep(lexer, char, next);
    if (trivia === "refuse" || (trivia === "token" && !tokenStep(lexer, char, next))) return null;
  }
  return lexer.mode === "code" && lexer.substitutions.length === 0 ? lexer.out : null;
}

/** Whether a `/` after `previous` (and `previousWord`) opens a regular expression. */
function startsRegex(previous: string, previousWord: string): boolean {
  if (previous === "") return true;
  if (previousWord !== "") return REGEX_KEYWORDS.has(previousWord);
  return REGEX_PRECEDERS.has(previous);
}

/** The index after the string opened at `start` by `quote`, or null when it does not close on its line. */
function quotedEnd(source: string, start: number, quote: string): number | null {
  for (let index = start + 1; index < source.length; index += 1) {
    const char = source[index];
    if (char === "\\") {
      index += 1;
      continue;
    }
    if (char === "\n") return null;
    if (char === quote) return index + 1;
  }
  return null;
}

/**
 * The index after the regular expression opened at `start`, its flags
 * included; null when it does not close on its line or holds a quote.
 */
function regexEnd(source: string, start: number): number | null {
  let inClass = false;
  for (let index = start + 1; index < source.length; index += 1) {
    const char = source[index] as string;
    if (char === "\n" || char === "'" || char === "\"" || char === "`") return null;
    if (char === "\\") {
      index += 1;
      continue;
    }
    if (char === "[") inClass = true;
    else if (char === "]") inClass = false;
    else if (char === "/" && !inClass) {
      let end = index + 1;
      while (end < source.length && /[a-z]/.test(source[end] as string)) end += 1;
      return end;
    }
  }
  return null;
}
