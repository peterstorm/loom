import { CONTINUE, halt, isShellQuoteChar, openQuoteAfter, scanUnquoted, type ShellQuoteChar } from "./shell-quoting";

/** Shell separator between two simple-command segments. */
export type SegmentOp = "&&" | "||" | ";" | "|" | "&";

/** A simple-command segment and the operator that preceded it. */
export type CommandSegment = Readonly<{
  text: string;
  opBefore: SegmentOp | null;
}>;

/**
 * Split command text on shell separators while preserving quoted separators
 * and the operator that preceded each segment.
 */
export function splitCommandSegmentsWithOps(command: string): readonly CommandSegment[] {
  const segments: CommandSegment[] = [];
  let current = "";
  let pendingOp: SegmentOp | null = null;
  let quote: ShellQuoteChar | null = null;
  const push = (op: SegmentOp): void => {
    segments.push({ text: current, opBefore: pendingOp });
    current = "";
    pendingOp = op;
  };

  for (let index = 0; index < command.length; index++) {
    const char = command[index];
    if (quote !== null) {
      if (quote !== "'" && char === "\\") {
        current += char + (command[index + 1] ?? "");
        index++;
        continue;
      }
      if (char === quote) quote = null;
      current += char;
      continue;
    }
    if (char === "\\") {
      current += char + (command[index + 1] ?? "");
      index++;
      continue;
    }
    if (isShellQuoteChar(char)) {
      quote = char;
      current += char;
      continue;
    }
    const separator = separatorAt(command, index);
    if (separator !== null) {
      push(separator.op);
      index += separator.width - 1;
      continue;
    }
    current += char;
  }
  segments.push({ text: current, opBefore: pendingOp });
  return segments;
}

/** An unquoted separator and how many characters it spans. */
type Separator = Readonly<{ op: SegmentOp; width: number }>;

/**
 * The separator starting at `index` of unquoted command text, or null when the
 * character is ordinary — including an `&` that belongs to a `&>`/`>&` redirect.
 * `|&` pipes stderr too, so it separates as `|` spanning two characters.
 */
function separatorAt(command: string, index: number): Separator | null {
  const char = command[index];
  const next = command[index + 1];
  if (char === "&") {
    if (next === "&") return { op: "&&", width: 2 };
    if (next === ">" || command[index - 1] === ">") return null;
    return { op: "&", width: 1 };
  }
  if (char === "|") {
    if (next === "|") return { op: "||", width: 2 };
    return { op: "|", width: next === "&" ? 2 : 1 };
  }
  if (char === ";" || char === "\n") return { op: ";", width: 1 };
  return null;
}

/** Segment texts only, for callers that do not need exit-status ownership. */
export function splitCommandSegments(command: string): readonly string[] {
  return splitCommandSegmentsWithOps(command).map(({ text }) => text);
}

/**
 * Refuse command classification when quoting cannot be resolved.
 *
 * Mirrors the splitter's quote state rather than raw character parity: a
 * quote bash reads as closed (escaped, or nested inside another region —
 * `echo "a'b"`) classifies, while a region left open despite an even raw
 * count (`echo \" a"`) refuses. Parity got both directions wrong.
 */
export function hasUnbalancedQuotes(segment: string): boolean {
  return openQuoteAfter(segment, 0) !== null;
}

/** Strip a trailing unquoted shell comment. */
export function stripComment(segment: string): string {
  return scanUnquoted<string>(segment, 0, (char, index) =>
    char === "#" && (index === 0 || /\s/.test(segment[index - 1]!))
      ? halt(segment.slice(0, index))
      : CONTINUE) ?? segment;
}

/** Strip leading shell environment assignments from a simple command. */
export function stripEnvPrefix(segment: string): string {
  let rest = segment;
  for (;;) {
    const assignment = rest.match(/^[A-Za-z_][A-Za-z0-9_]*=/);
    if (!assignment) return rest;
    let index = assignment[0].length;
    let quote: ShellQuoteChar | null = null;
    while (index < rest.length) {
      const char = rest[index];
      if (quote !== null) {
        if (quote !== "'" && char === "\\") {
          index += 2;
          continue;
        }
        if (char === quote) quote = null;
        index++;
        continue;
      }
      if (char === "\\") {
        index += 2;
        continue;
      }
      if (isShellQuoteChar(char)) {
        quote = char;
        index++;
        continue;
      }
      if (/\s/.test(char)) break;
      index++;
    }
    rest = rest.slice(index).trimStart();
    if (rest === "") return "";
  }
}

/**
 * Classify a complete Bash `>&word` target as fd duplication or file output.
 *
 * Bash's `>&word` (and `n>&word`) is an fd DUPLICATION only when the ENTIRE
 * word is digits (`2>&1`, `>&2`) or exactly `-` (the close form, `>&-`). A
 * word that merely STARTS with a digit but continues into a path
 * (`>&2/../r.json`) is a filename redirect: bash writes the FILE. The guard's
 * `hasOutputRedirect` and the evidence scanner's `readRedirectTarget` both
 * classify through this one function so their verdicts cannot drift. Quote
 * and backslash characters do NOT terminate the word: `>&2"foo"` collapses to
 * the filename `2foo` in bash, and a word containing them is never pure
 * digits, so it classifies as a file write (fail-closed).
 * `start` points just past the `&`; `end` is the index just past the word.
 */
export function classifyFdDupWord(
  text: string,
  start: number,
): Readonly<{ isFdDup: boolean; end: number }> {
  let end = start;
  while (end < text.length && !/[\s><&|;()]/.test(text[end])) end++;
  const word = text.slice(start, end);
  return { isFdDup: word === "-" || /^[0-9]+$/.test(word), end };
}
