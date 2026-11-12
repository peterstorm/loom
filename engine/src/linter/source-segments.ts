/**
 * The source segmenter — one TypeScript/JavaScript text split into code,
 * quoted strings and comments.
 *
 * Three readers share it, so it lives beside none: `no-io-in-pure-modules`
 * reads the code with its strings emptied, the clone detector
 * (`clones/clone-detection.ts`) lexes the segments into tokens, and
 * `no-wire-cast` reads the finer `lexicalSpans`, where template text and regex
 * literals are not code either. What a clone
 * fingerprint means therefore depends on this module; the detector's
 * `fingerprintScheme` observes it through a probe, so a change here retires
 * every cached fingerprint without anyone remembering to.
 *
 * Pure: text in, spans out.
 */

/**
 * One lexical span of a source text: code a rule reads, or a quoted string
 * or a comment it does not. Template literals — their text and their `${…}`
 * alike — and regex literals are code, so a `//` inside one (a URL in a
 * template, an escaped slash in a regex) never hides the rest of the line.
 */
export type SourceSegment = Readonly<{ kind: "code" | "string" | "comment"; start: number; end: number }>;

/** The open delimiter the scanner is inside of: template text, or a `${…}` / `{…}` of code. */
type Nesting = "template" | "interpolation" | "brace";

/** Words after which a `/` begins a regex literal rather than a division. */
const REGEX_PRECEDING_KEYWORDS: ReadonlySet<string> = new Set([
  "return", "typeof", "instanceof", "in", "of", "new", "delete", "void", "throw", "case", "do", "else", "yield", "await",
]);

/**
 * Split a source text into code, string and comment spans. The scan carries
 * template nesting across lines (a multi-line template's continuation is still
 * template text) and fails closed: a quote with no closing partner on its line,
 * or a `/` with no closing regex delimiter, is read as code — when in doubt the
 * text is checked, never skipped.
 */
export function sourceSegments(content: string): readonly SourceSegment[] {
  const segments: SourceSegment[] = [];
  for (const { kind, start, end } of lexicalSpans(content)) {
    const last = segments.at(-1);
    if (kind === "string" || kind === "comment") segments.push({ kind, start, end });
    else if (last?.kind === "code") segments[segments.length - 1] = { kind: "code", start: last.start, end };
    else segments.push({ kind: "code", start, end });
  }
  return segments;
}

/**
 * One span of the finer split a syntax-shaped rule reads: the segments, with
 * the text of a template literal and each regex literal told apart from the
 * code around them. A `template` span runs from the backtick, or from the
 * character after an interpolation's `}`, to the closing backtick or the `$` of
 * the next `${`; the interpolation's braces and what they hold are `code`, so
 * the brackets of the code spans alone stay balanced.
 */
export type LexicalSpan = Readonly<{ kind: SourceSegment["kind"] | "template" | "regex"; start: number; end: number }>;

/**
 * Split a source text into code, string, comment, template-text and regex
 * spans. The scan is the one `sourceSegments` describes — that function is
 * this one with template text and regex literals read as code.
 */
export function lexicalSpans(content: string): readonly LexicalSpan[] {
  const nesting: Nesting[] = [];
  const { turn, literal, close } = spanRuns();
  let index = 0;
  /** A literal read whole from `index`. */
  const whole = (kind: "string" | "comment" | "regex", end: number): void => {
    literal(kind, index, end);
    index = end;
  };
  while (index < content.length) {
    const char = content[index];
    if (nesting.at(-1) === "template") {
      const depth = nesting.length;
      const stepped = templateStep(content, index, nesting);
      // Deeper is a `${`, whose `{` is code; shallower is the closing backtick.
      if (nesting.length !== depth) turn("code", nesting.length > depth ? stepped - 1 : stepped);
      index = stepped;
      continue;
    }
    const next = content[index + 1];
    if (char === "/" && next === "/") {
      whole("comment", lineEnd(content, index));
      continue;
    }
    if (char === "/" && next === "*") {
      whole("comment", blockCommentEnd(content, index));
      continue;
    }
    const stringClose = char === "\"" || char === "'" ? closingQuote(content, index) : -1;
    if (stringClose !== -1) {
      whole("string", stringClose + 1);
      continue;
    }
    const regexClose = char === "/" && regexMayStart(content, index) ? regexEnd(content, index) : -1;
    if (regexClose !== -1) {
      whole("regex", regexClose);
      continue;
    }
    if (char === "`") {
      turn("template", index);
      nesting.push("template");
    } else if (char === "{") nesting.push("brace");
    else if (char === "}") {
      nesting.pop(); // closes a brace, or an interpolation back into its template
      if (nesting.at(-1) === "template") turn("template", index + 1);
    }
    index += 1;
  }
  return close(content.length);
}

/**
 * The spans of one scan as they are written: code and template text accumulate
 * in a run that is open until its kind turns, and a string, comment or regex is
 * one span of its own.
 */
function spanRuns(): Readonly<{
  /** End the open run at `at` and open one of `kind` there; nothing when it is that kind already. */
  turn: (kind: "code" | "template", at: number) => void;
  /** A literal from `start` to `end`; only code is ever open around one, and code resumes after it. */
  literal: (kind: "string" | "comment" | "regex", start: number, end: number) => void;
  /** End the open run at the text's end, and hand back every span. */
  close: (length: number) => readonly LexicalSpan[];
}> {
  const spans: LexicalSpan[] = [];
  let runKind: "code" | "template" = "code";
  let runStart = 0;
  const endRun = (at: number): void => {
    if (at > runStart) spans.push({ kind: runKind, start: runStart, end: at });
  };
  return {
    turn: (kind, at) => {
      if (kind === runKind) return;
      endRun(at);
      runKind = kind;
      runStart = at;
    },
    literal: (kind, start, end) => {
      endRun(start);
      spans.push({ kind, start, end });
      runStart = end;
    },
    close: (length) => {
      endRun(length);
      return spans;
    },
  };
}

/** One step through template text: an escape, the closing backtick, a `${` into code, or a text character. */
function templateStep(content: string, index: number, nesting: Nesting[]): number {
  const char = content[index];
  if (char === "\\") return index + 2;
  if (char === "`") {
    nesting.pop();
    return index + 1;
  }
  if (char === "$" && content[index + 1] === "{") {
    nesting.push("interpolation");
    return index + 2;
  }
  return index + 1;
}

/** The end of the line holding `index` (its newline is not part of the line). */
function lineEnd(content: string, index: number): number {
  const newline = content.indexOf("\n", index);
  return newline === -1 ? content.length : newline;
}

/** The end of the block comment opened at `open`; an unterminated one runs to the end of the text. */
function blockCommentEnd(content: string, open: number): number {
  const close = content.indexOf("*/", open + 2);
  return close === -1 ? content.length : close + 2;
}

/** The index of the quote closing the string opened at `open` on the same line, or -1. */
function closingQuote(content: string, open: number): number {
  const quote = content[open];
  for (let index = open + 1; index < content.length && content[index] !== "\n"; index += 1) {
    if (content[index] === "\\") index += 1;
    else if (content[index] === quote) return index;
  }
  return -1;
}

/**
 * Can a `/` at `index` open a regex literal? Only an operand — a name, a
 * number, a closing bracket or a closed literal — makes it a division; after
 * an operator, punctuation, a keyword or the start of the text it is a regex.
 * Erring toward regex is the closed side: a misread division keeps the text up
 * to the next `/` as code, it never turns code into a comment.
 */
function regexMayStart(content: string, index: number): boolean {
  let before = index - 1;
  while (before >= 0 && /\s/.test(content.charAt(before))) before -= 1;
  if (before < 0) return true;
  const previous = content.charAt(before);
  if (/[)\]"'`]/.test(previous)) return false;
  if (!/[\w$]/.test(previous)) return true;
  const word = /[\w$]+$/.exec(content.slice(0, before + 1));
  return word !== null && REGEX_PRECEDING_KEYWORDS.has(word[0]);
}

/** The index just past the regex literal opened at `open`, or -1 when it does not close on its line. */
function regexEnd(content: string, open: number): number {
  let inClass = false;
  for (let index = open + 1; index < content.length; index += 1) {
    const char = content[index];
    if (char === "\n") return -1;
    if (char === "\\") index += 1;
    else if (char === "[") inClass = true;
    else if (char === "]") inClass = false;
    else if (char === "/" && !inClass) return index + 1;
  }
  return -1;
}
