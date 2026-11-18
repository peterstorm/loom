/**
 * The comment lexer behind a comment-only Change Class (ADR-0093):
 * `commentStrippedSource` removes C-family comments from a TypeScript,
 * JavaScript or Java source and normalises the whitespace between tokens, so
 * two sources that differ only in comments and layout strip to the same text.
 *
 * Conservative: wherever it cannot read a source with certainty it returns no
 * stripped form, and the caller counts the file as code.
 *
 * Pure: no I/O, no clock, no randomness.
 */

/** Characters after which a `/` starts a regular expression rather than a division. */
const REGEX_PRECEDERS = new Set(["(", ",", "=", ":", "[", "!", "&", "|", "?", "{", "}", ";", "+", "-", "*", "%", "<", ">", "~", "^"]);

/** Words after which a `/` starts a regular expression rather than a division. */
const REGEX_KEYWORDS = new Set([
  "return", "typeof", "case", "do", "else", "in", "instanceof", "new", "delete", "void", "throw", "yield", "await", "of",
]);

/**
 * Line terminators the lexer does not read: a carriage return not followed by
 * a line feed, and U+2028 / U+2029. JavaScript ends a line comment at each of
 * them while Java ends one only at the first, so a source holding one is not
 * read at all. A CRLF pair is read as one line break.
 */
const UNREAD_LINE_TERMINATOR = new RegExp(`\\r(?!\\n)|[${String.fromCharCode(0x2028, 0x2029)}]`);

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

/** The separator the pending whitespace emits before the next token. */
function pendingSeparator(lexer: Lexer): string {
  if (lexer.out === "") return "";
  if (lexer.pendingBreak) return "\n";
  if (lexer.pendingSpace && !lexer.out.endsWith("\n")) return " ";
  return "";
}

/** Emit the pending separator; whether one was emitted. */
function flush(lexer: Lexer): boolean {
  const separator = pendingSeparator(lexer);
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
function tokenStep(lexer: Lexer, char: string): boolean {
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
  // A backslash outside a literal is at most an identifier escape, which no
  // comment rule reads alike in every language here: refuse the source.
  if (char === "\\") return false;
  emitCode(lexer, char);
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
 * Null for a source holding a line terminator the lexer does not read (a lone
 * carriage return, U+2028, U+2029); an unterminated string, template, regular
 * expression or block comment; a quote inside a regular expression; a
 * backslash outside a literal; and a comment on a line where an earlier `/`
 * was read as a division, since that `/` may have opened a regular expression
 * holding the comment's marker. Idempotent: a stripped source strips to
 * itself, and it keeps exactly the tokens the TypeScript parser reads.
 */
export function commentStrippedSource(source: string): string | null {
  if (UNREAD_LINE_TERMINATOR.test(source)) return null;
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
    if (trivia === "refuse" || (trivia === "token" && !tokenStep(lexer, char))) return null;
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
