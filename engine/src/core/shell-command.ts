import { CONTINUE, halt, openQuoteAfter, scanUnquoted, skip } from "./shell-quoting";

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
  let start = 0;
  let pendingOp: SegmentOp | null = null;
  let walk = OPERATOR_WALK_START;
  scanUnquoted<never>(command, 0, (_char, index) => {
    const read = readShellOperator(command, index, walk);
    walk = read.walk;
    const { operator } = read;
    if (operator === null) return CONTINUE;
    if (operator.separator !== null) {
      segments.push({ text: command.slice(start, index), opBefore: pendingOp });
      pendingOp = operator.separator;
      start = index + operator.width;
    }
    return skip(index + operator.width);
  });
  segments.push({ text: command.slice(start), opBefore: pendingOp });
  return segments;
}

/**
 * An unquoted shell control-operator character run and how many characters it
 * spans. `separator` is the segment operator it ends a simple command with, or
 * null when the run BINDS to the redirect around it (the `&` of `&>`/`&>>` or
 * of a `>&` fd dup, the `|` of a `>|` clobber) and separates nothing.
 */
export type ShellOperator = Readonly<{ separator: SegmentOp | null; width: number }>;

declare const operatorWalkBrand: unique symbol;

/**
 * Where a walk over a command line stands, as far as operators care: the
 * index of the last character it read UNQUOTED (`-1` before the first).
 * Opaque: only `OPERATOR_WALK_START` and `readShellOperator` make one, so no
 * walker can claim a `>` it never read.
 */
export type OperatorWalk = Readonly<{ lastUnquoted: number }> & { readonly [operatorWalkBrand]: true };

const operatorWalk = (lastUnquoted: number): OperatorWalk => Object.freeze({ lastUnquoted }) as OperatorWalk;

/** A walk that has read nothing yet. */
export const OPERATOR_WALK_START: OperatorWalk = operatorWalk(-1);

/** The operator a walk reads at one unquoted character, and the walk past it. */
export type OperatorRead = Readonly<{ operator: ShellOperator | null; walk: OperatorWalk }>;

/**
 * Read the operator, if any, at `index` — a character the caller's walk reads
 * UNQUOTED — and advance the walk past it. Every walker that cuts a command
 * line (the segment splitter above and the heredoc opener-line group walk in
 * core/shell-heredoc) reads its operators here, handing back the walk each
 * call returned; the walkers differ only in which spans they skip unread.
 *
 * The walk owns the one rule its callers used to copy: a `&` or `|` binds to a
 * redirect only right after a `>` the walk itself read unquoted (never one
 * inside quotes or escaped as `\>`). Reading it off the raw text let an
 * escaped `\>` bind the `&` after it, so `echo \>& rm <state>` read as one
 * `echo` segment while bash ran the `rm`.
 */
export function readShellOperator(text: string, index: number, walk: OperatorWalk): OperatorRead {
  const afterRedirect = walk.lastUnquoted === index - 1 && text[walk.lastUnquoted] === ">";
  const operator = shellOperatorAt(text, index, afterRedirect);
  return { operator, walk: operatorWalk(operator === null ? index : index + operator.width - 1) };
}

/**
 * The ONE classification of the unquoted operators that cut a command line.
 * Null when the character at `index` starts no operator. `afterRedirect` is
 * the walk's verdict (`readShellOperator`): the character before `index` is a
 * `>` the walk read unquoted.
 *
 *  - `&&` / `||` — two-character separators;
 *  - `&>` / `&>>` — a redirect: binds, spanning the `&>`;
 *  - `>&` — an fd dup: its `&` binds;
 *  - `>|` — a clobbering output redirect: its `|` binds;
 *  - `&` — background: separates;
 *  - `|&` — pipes stderr too: separates as `|` spanning two characters;
 *  - `|` — a pipe: separates as `|` (a group walk keeps pipe members together);
 *  - `;` and newline — separate as `;`, one character each (`;;` is two).
 */
function shellOperatorAt(text: string, index: number, afterRedirect: boolean): ShellOperator | null {
  const char = text[index];
  const next = text[index + 1];
  if (char === "&") {
    if (next === "&") return { separator: "&&", width: 2 };
    if (next === ">") return { separator: null, width: 2 };
    if (afterRedirect) return { separator: null, width: 1 };
    return { separator: "&", width: 1 };
  }
  if (char === "|") {
    if (next === "|") return { separator: "||", width: 2 };
    // Only the `>` of a plain `>`/`n>` takes a `|`: `>>|`, `<>|` and `&>|` are
    // syntax errors bash runs nothing for, and keep their old (pipe) reading.
    if (afterRedirect && !/[<>&]/.test(text[index - 2] ?? "")) return { separator: null, width: 1 };
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
    char === "#" && (index === 0 || /\s/.test(segment[index - 1]))
      ? halt(segment.slice(0, index))
      : CONTINUE) ?? segment;
}

/** Strip leading shell environment assignments from a simple command. */
export function stripEnvPrefix(segment: string): string {
  let rest = segment;
  for (;;) {
    const assignment = rest.match(/^[A-Za-z_][A-Za-z0-9_]*=/);
    if (!assignment) return rest;
    const valueEnd = scanUnquoted<number>(rest, assignment[0].length, (char, index) =>
      /\s/.test(char) ? halt(index) : CONTINUE) ?? rest.length;
    rest = rest.slice(valueEnd).trimStart();
  }
}
