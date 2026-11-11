/**
 * The source segmenter — one TypeScript/JavaScript text split into code,
 * quoted strings and comments.
 *
 * Two readers share it, so it lives beside neither: `no-io-in-pure-modules`
 * reads the code with its strings emptied, and the clone detector
 * (`clones/clone-detection.ts`) lexes the segments into tokens. What a clone
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
  const nesting: Nesting[] = [];
  let codeStart = 0;
  let index = 0;
  const skip = (kind: "string" | "comment", end: number): void => {
    if (index > codeStart) segments.push({ kind: "code", start: codeStart, end: index });
    segments.push({ kind, start: index, end });
    index = end;
    codeStart = end;
  };
  while (index < content.length) {
    const char = content[index];
    if (nesting.at(-1) === "template") {
      index = templateStep(content, index, nesting);
      continue;
    }
    const next = content[index + 1];
    if (char === "/" && next === "/") {
      skip("comment", lineEnd(content, index));
      continue;
    }
    if (char === "/" && next === "*") {
      skip("comment", blockCommentEnd(content, index));
      continue;
    }
    const stringClose = char === "\"" || char === "'" ? closingQuote(content, index) : -1;
    if (stringClose !== -1) {
      skip("string", stringClose + 1);
      continue;
    }
    const regexClose = char === "/" && regexMayStart(content, index) ? regexEnd(content, index) : -1;
    if (regexClose !== -1) {
      index = regexClose;
      continue;
    }
    if (char === "`") nesting.push("template");
    else if (char === "{") nesting.push("brace");
    else if (char === "}") nesting.pop(); // closes a brace, or an interpolation back into its template
    index += 1;
  }
  if (content.length > codeStart) segments.push({ kind: "code", start: codeStart, end: content.length });
  return segments;
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
