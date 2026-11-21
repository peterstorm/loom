/**
 * The ONE scan of a simple-command segment's output redirects.
 *
 * Three scanners existed — `hasOutputRedirect` and `outputRedirectTargets` in
 * `core/shell-command-head` (the guards) and `collectRedirectTargets` in
 * `core/shell-write-targets` (the evidence reader) — and they had diverged:
 * `echo x >| out` named its target to the guard while the
 * evidence reader minted nothing. `redirectsOf` reads every redirect once, as
 * a typed union; the guard's two questions are projections of it here, and
 * the evidence reader mints from the same redirects.
 *
 * Pure module: no I/O, no clock, no randomness.
 */

import { CONTINUE, halt, scanUnquoted, skip } from "./shell-quoting";

/**
 * One output redirect of a segment. `at` is the index of its `>` (the `2` of
 * a stderr discard), `end` the index the scan resumes at, and `operandAt` the
 * index just past its `>` run (`>`, `>>`, `>|`; a `>&` operand starts at its
 * `&`), where the evidence reader reads the target from.
 *
 *  - `file-write` — `>`, `>>`, `>|`, `&>`, `&>>`, `n>`: writes the file `word`
 *    (as written, quotes kept);
 *  - `fd-dup` — `>&` with a whole fd or `-` (`2>&1`, `>&2`, `>&-`): no file;
 *  - `stderr-discard` — exactly `2>/dev/null`: no file;
 *  - the redirects whose file a guard cannot name, so a guard treats them
 *    as unknown: `file-dup` (`>&word`, `word` not a whole fd: writes the FILE
 *    `word`), `read-write` (`<>`), `process-substitution` (`>(…)`) and
 *    `missing-target` (no word follows the operator).
 */
export type OutputRedirect = Readonly<
  { at: number; end: number; operandAt: number } & (
    | { kind: "file-write"; word: string }
    | { kind: "fd-dup" | "stderr-discard" | "file-dup" | "read-write" | "process-substitution" | "missing-target" }
  )
>;

/** The kinds whose written file a guard cannot name from the text. */
const UNNAMEABLE: ReadonlySet<OutputRedirect["kind"]> = new Set([
  "file-dup", "read-write", "process-substitution", "missing-target",
]);

/** The kinds that write no file. */
const WRITES_NOTHING: ReadonlySet<OutputRedirect["kind"]> = new Set(["fd-dup", "stderr-discard"]);

/** Characters that end an unquoted redirect target word. */
const TARGET_END = /[\s;&|<>()]/;

/**
 * Every output redirect of `segment` read from `from`, in order. The scan
 * walks the one quote lexer, so a quoted `>` is argument text.
 *
 * The exact stderr discard is found first over the whole text and masked, so
 * the operators around it are read as if it were absent — `>&2>/dev/null`
 * reads the `2` as the discard, leaving a `>&` with no fd (a file-dup).
 */
export function redirectsOf(segment: string, from = 0): readonly OutputRedirect[] {
  const discards = stderrDiscards(segment, from);
  let masked = segment;
  for (const discard of discards) {
    masked = masked.slice(0, discard.at) + " ".repeat(discard.end - discard.at) + masked.slice(discard.end);
  }
  const found: OutputRedirect[] = [...discards];
  scanUnquoted<never>(masked, from, (c, i) => {
    if (c !== ">") return CONTINUE;
    const redirect = redirectAt(masked, i);
    found.push(redirect);
    return skip(redirect.end);
  });
  return Object.freeze(found.sort((a, b) => a.at - b.at));
}

/** The redirect whose `>` is at `i` (`text` has its stderr discards masked). */
function redirectAt(text: string, i: number): OutputRedirect {
  if (text[i - 1] === "<") {
    const operand = operandAfter(text, i + 1);
    return { kind: "read-write", at: i, end: operand.end, operandAt: i + 1 };
  }
  if (text[i + 1] === "&") {
    const dup = classifyFdDupWord(text, i + 2);
    if (dup.isFdDup) return { kind: "fd-dup", at: i, end: dup.end, operandAt: i + 1 };
    return { kind: "file-dup", at: i, end: i + 2 + targetWord(text, i + 2).length, operandAt: i + 1 };
  }
  const operandAt = text[i + 1] === ">" || text[i + 1] === "|" ? i + 2 : i + 1;
  const operand = operandAfter(text, operandAt);
  if (operand.word === null) {
    const kind = text[operand.end] === "(" ? "process-substitution" : "missing-target";
    return { kind, at: i, end: operand.end, operandAt };
  }
  return { kind: "file-write", word: operand.word, at: i, end: operand.end, operandAt };
}

/** The target word after an operator ending at `start`, past spaces and
 *  tabs: null (ending at the `(` of a process substitution, or where a word
 *  should start) when there is none. */
function operandAfter(text: string, start: number): Readonly<{ word: string | null; end: number }> {
  let cursor = start;
  while (text[cursor] === " " || text[cursor] === "\t") cursor += 1;
  if (text[cursor] === "(" || cursor >= text.length) return { word: null, end: cursor };
  const word = targetWord(text, cursor);
  return word === "" ? { word: null, end: cursor } : { word, end: cursor + word.length };
}

/** The redirect target word at `start`: up to the first unquoted space, separator or redirect. */
function targetWord(text: string, start: number): string {
  const end = scanUnquoted<number>(text, start, (c, i) => (TARGET_END.test(c) ? halt(i) : CONTINUE)) ?? text.length;
  return text.slice(start, end);
}

/**
 * The redirects that cannot mutate guarded authority: discarding stderr to the
 * literal `/dev/null`. This is intentionally narrow (`2>` only, no
 * append/clobber variants, expansions, or lookalike paths). Read-only probes
 * routinely use this form for optional guarded directories; treating it as a
 * state write made `ls .loom 2>/dev/null` impossible.
 */
function stderrDiscards(segment: string, from: number): readonly OutputRedirect[] {
  const discards: OutputRedirect[] = [];
  const isBoundary = (char: string | undefined): boolean =>
    char === undefined || /\s/.test(char) || ";&|(){}".includes(char);
  scanUnquoted<never>(segment, from, (char, index) => {
    if (char !== "2" || !isBoundary(segment[index - 1]) || segment[index + 1] !== ">") {
      return CONTINUE;
    }
    let cursor = index + 2;
    if (segment[cursor] === ">" || segment[cursor] === "&" || segment[cursor] === "|") {
      return CONTINUE;
    }
    while (segment[cursor] === " " || segment[cursor] === "\t") cursor += 1;
    const target = "/dev/null";
    if (!segment.startsWith(target, cursor) || !isBoundary(segment[cursor + target.length])) {
      return CONTINUE;
    }
    const end = cursor + target.length;
    discards.push({ kind: "stderr-discard", at: index, end, operandAt: index + 2 });
    return skip(end);
  });
  return discards;
}

/**
 * Does the segment write a file through a redirect? Every output redirect
 * counts except an fd dup — `>&` followed by a word that is ENTIRELY digits or
 * exactly `-` (`2>&1`, `>&2`, `>&-`), classified by classifyFdDupWord — and the
 * exact `2>/dev/null` discard. A `>&` whose word merely starts with a digit
 * but continues into a path (`>&2/../file` — the round-16 bypass) or is any
 * other word (`>&file`, the round-15 bypass) redirects to a file and counts.
 * Quoted `>` characters remain ordinary argument text.
 */
export function hasOutputRedirect(segment: string): boolean {
  return redirectsOf(segment).some(({ kind }) => !WRITES_NOTHING.has(kind));
}

/**
 * The word every output redirect of the segment writes to, as written
 * (quotes kept): `> out`, `>> out`, `>| out`, `&> out`, `2>out`. Null when an
 * output redirect has no target a guard can name: a read-write open (`<>`), a
 * `>&word` whose word is not a whole fd (it writes the file `word`), a
 * process substitution or a missing word. An fd dup (`2>&1`, `>&-`) and the
 * exact `2>/dev/null` discard write no file and are not listed.
 */
export function outputRedirectTargets(segment: string): readonly string[] | null {
  const redirects = redirectsOf(segment);
  if (redirects.some(({ kind }) => UNNAMEABLE.has(kind))) return null;
  return redirects.flatMap((redirect) => (redirect.kind === "file-write" ? [redirect.word] : []));
}

/**
 * Classify a complete Bash `>&word` target as fd duplication or file output.
 *
 * Bash's `>&word` (and `n>&word`) is an fd DUPLICATION only when the ENTIRE
 * word is digits (`2>&1`, `>&2`) or exactly `-` (the close form, `>&-`). A
 * word that merely STARTS with a digit but continues into a path
 * (`>&2/../r.json`) is a filename redirect: bash writes the FILE. The guard
 * (through `redirectsOf`) and the evidence scanner's `readRedirectTarget` both
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
