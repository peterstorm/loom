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
    const operator = shellOperatorAt(command, index);
    if (operator !== null) {
      if (operator.separator !== null) push(operator.separator);
      else current += command.slice(index, index + operator.width);
      index += operator.width - 1;
      continue;
    }
    current += char;
  }
  segments.push({ text: current, opBefore: pendingOp });
  return segments;
}

/**
 * An unquoted shell control-operator character run and how many characters it
 * spans. `separator` is the segment operator it ends a simple command with, or
 * null when the run BINDS to the redirect around it (the `&` of `&>`/`&>>` or
 * of a `>&` fd dup) and separates nothing.
 */
export type ShellOperator = Readonly<{ separator: SegmentOp | null; width: number }>;

/**
 * The ONE classification of the unquoted operators that cut a command line,
 * shared by every walker that cuts one — the segment splitter above and the
 * heredoc opener-line group walk (core/shell-heredoc). Null when the character
 * at `index` starts no operator.
 *
 *  - `&&` / `||` — two-character separators;
 *  - `&>` / `&>>` — a redirect: binds, spanning the `&>`;
 *  - `>&` — an fd dup: its `&` binds;
 *  - `&` — background: separates;
 *  - `|&` — pipes stderr too: separates as `|` spanning two characters;
 *  - `|` — a pipe: separates as `|` (a group walk keeps pipe members together);
 *  - `;` and newline — separate as `;`, one character each (`;;` is two).
 */
export function shellOperatorAt(text: string, index: number): ShellOperator | null {
  const char = text[index];
  const next = text[index + 1];
  if (char === "&") {
    if (next === "&") return { separator: "&&", width: 2 };
    if (next === ">") return { separator: null, width: 2 };
    if (text[index - 1] === ">") return { separator: null, width: 1 };
    return { separator: "&", width: 1 };
  }
  if (char === "|") {
    if (next === "|") return { separator: "||", width: 2 };
    return { separator: "|", width: next === "&" ? 2 : 1 };
  }
  if (char === ";" || char === "\n") return { separator: ";", width: 1 };
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
