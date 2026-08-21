import { CONTINUE, halt, isShellQuoteChar, scanUnquoted, SHELL_QUOTE_CHARS, type ShellQuoteChar } from "./shell-quoting";

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
    if (char === "&") {
      if (command[index + 1] === "&") {
        push("&&");
        index++;
        continue;
      }
      if (command[index + 1] === ">" || command[index - 1] === ">") {
        current += char;
        continue;
      }
      push("&");
      continue;
    }
    if (char === "|") {
      if (command[index + 1] === "|") {
        push("||");
        index++;
      } else if (command[index + 1] === "&") {
        push("|");
        index++;
      } else {
        push("|");
      }
      continue;
    }
    if (char === ";" || char === "\n") {
      push(";");
      continue;
    }
    current += char;
  }
  segments.push({ text: current, opBefore: pendingOp });
  return segments;
}

/** Segment texts only, for callers that do not need exit-status ownership. */
export function splitCommandSegments(command: string): readonly string[] {
  return splitCommandSegmentsWithOps(command).map(({ text }) => text);
}

/** Refuse command classification when quoting cannot be resolved. */
export function hasUnbalancedQuotes(segment: string): boolean {
  return SHELL_QUOTE_CHARS.some((quote) => (segment.split(quote).length - 1) % 2 === 1);
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

/** Classify a complete Bash `>&word` target as fd duplication or file output. */
export function classifyFdDupWord(
  text: string,
  start: number,
): Readonly<{ isFdDup: boolean; end: number }> {
  let end = start;
  while (end < text.length && !/[\s><&|;()]/.test(text[end])) end++;
  const word = text.slice(start, end);
  return { isFdDup: word === "-" || /^[0-9]+$/.test(word), end };
}
