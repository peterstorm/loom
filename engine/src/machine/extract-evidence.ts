/**
 * Map a completed tool call (PostToolUse) to evidence events.
 *
 * Pure given its inputs — the tool_response shape parsing and report lookup
 * are supplied/consumed here so this module stays testable without IO.
 *
 * Command classification parses, it does not substring-match: the command
 * is split into simple-command segments (QUOTE-AWARE — a separator inside
 * `"…"`, `'…'`, or backticks does not split, so a runner name embedded in a
 * quoted argument can never become a segment head), comments stripped, env
 * prefixes removed, and a runner pattern must match at the HEAD of a
 * segment followed by a token boundary. That kills the prose spoofs
 * (`echo '...' # npm test --json`, `git grep "npm test"`) AND the quoted
 * forgeries (`true "; npx vitest --reporter=json "; echo '{...}'`) that
 * naive splitting allowed to mint trusted verdicts.
 */

import { FILE_MODIFYING_TOOLS, TEST_COMMAND_PATTERNS } from "../core/tool-vocabulary";
import { normalizeShellSpan } from "../core/shell-normalize";
import type { Evidence, TestReportSummary } from "./types";

const QUOTE_CHARS = ['"', "'", "`"] as const;
type QuoteChar = (typeof QUOTE_CHARS)[number];

function isQuoteChar(c: string): c is QuoteChar {
  return (QUOTE_CHARS as readonly string[]).includes(c);
}

/** Shell separator between two simple-command segments. Newlines count as
 *  `;` — both sequence unconditionally with the same exit semantics. A single
 *  `&` backgrounds the segment BEFORE it: that segment's exit is never the
 *  line's exit (the shell reports 0 immediately), so exit attribution must
 *  know about it. */
export type SegmentOp = "&&" | "||" | ";" | "|" | "&";

/** A simple-command segment plus the operator that PRECEDED it (null for
 *  the first segment) — the fact exit attribution needs. */
export interface CommandSegment {
  readonly text: string;
  readonly opBefore: SegmentOp | null;
}

/**
 * Split a command line on shell separators (&&, ||, ;, |, newline) —
 * quote-aware: separators inside double quotes, single quotes, or backticks
 * do not split, and a backslash escapes the next character outside single
 * quotes (mirroring sh semantics closely enough that quoted runner text
 * stays inside the segment of the command that owns it). Each segment keeps
 * the operator that preceded it, so exit-status ownership can be decided
 * (see attributeExit): the shell reports ONE exit for the whole line, and
 * which segment owns it depends on these operators.
 */
export function splitCommandSegmentsWithOps(command: string): CommandSegment[] {
  const segments: CommandSegment[] = [];
  let current = "";
  let pendingOp: SegmentOp | null = null;
  let quote: QuoteChar | null = null;
  const push = (op: SegmentOp): void => {
    segments.push({ text: current, opBefore: pendingOp });
    current = "";
    pendingOp = op;
  };
  for (let i = 0; i < command.length; i++) {
    const c = command[i];
    if (quote !== null) {
      // Inside single quotes nothing is special but the closing quote.
      if (quote !== "'" && c === "\\") {
        current += c + (command[i + 1] ?? "");
        i++;
        continue;
      }
      if (c === quote) quote = null;
      current += c;
      continue;
    }
    if (c === "\\") {
      current += c + (command[i + 1] ?? "");
      i++;
      continue;
    }
    if (isQuoteChar(c)) {
      quote = c;
      current += c;
      continue;
    }
    if (c === "&") {
      if (command[i + 1] === "&") {
        push("&&");
        i++;
        continue;
      }
      // NOT a separator: `&>` / `&>>` redirects and `>&N` fd dups keep the
      // `&` inside the segment (it belongs to the redirect syntax).
      if (command[i + 1] === ">" || command[i - 1] === ">") {
        current += c;
        continue;
      }
      // A single unquoted `&` backgrounds the preceding segment.
      push("&");
      continue;
    }
    if (c === "|") {
      if (command[i + 1] === "|") {
        push("||");
        i++;
      } else if (command[i + 1] === "&") {
        // `|&` is bash shorthand for `2>&1 |` — ONE pipe operator. Parsing
        // the `&` separately would emit a spurious empty backgrounded
        // segment and start a new chain, fragmenting the pipe-chain trust
        // unit downstream (round-15 guard bypass) and mis-attributing
        // segments here.
        push("|");
        i++;
      } else {
        push("|");
      }
      continue;
    }
    if (c === ";" || c === "\n") {
      push(";");
      continue;
    }
    current += c;
  }
  segments.push({ text: current, opBefore: pendingOp });
  return segments;
}

/** Segment texts only — the operator-free view most callers need. */
export function splitCommandSegments(command: string): string[] {
  return splitCommandSegmentsWithOps(command).map((s) => s.text);
}

/**
 * A segment with an unbalanced quote can only come from a command whose
 * quoting our splitter (or the shell) could not resolve — classifying it
 * would trust a fragment of someone's string literal. Fail closed: refuse.
 */
export function hasUnbalancedQuotes(segment: string): boolean {
  return QUOTE_CHARS.some((q) => (segment.split(q).length - 1) % 2 === 1);
}

/** The runner pattern must end at a token boundary: `npm testify` is not `npm test`. */
function headMatchesRunner(lowerSegment: string): boolean {
  return TEST_COMMAND_PATTERNS.some(
    (p) =>
      lowerSegment.startsWith(p) &&
      (lowerSegment.length === p.length || /\s/.test(lowerSegment.charAt(p.length))),
  );
}

/**
 * Maven's runner patterns include the goal-less `mvn -pl <module> …` form —
 * only an actual test-executing goal makes the segment a test run
 * (`mvn -pl core install` compiles and installs; it proves nothing about
 * tests).
 */
const MVN_TEST_GOALS = new Set(["test", "verify", "integration-test"]);

function hasMavenTestGoal(lowerSegment: string): boolean {
  return lowerSegment
    .split(/\s+/)
    .some(
      (tok) =>
        MVN_TEST_GOALS.has(tok) ||
        tok.endsWith(":test") ||
        tok.endsWith(":verify") ||
        tok.endsWith(":integration-test"),
    );
}

function isMavenHead(lowerSegment: string): boolean {
  const head = lowerSegment.split(/\s+/, 1)[0] ?? "";
  return head === "mvn" || head === "mvnw" || head === "./mvnw";
}

/**
 * Strip an unquoted trailing comment — quote-aware, matching the splitter's
 * quote semantics: a `#` inside `"…"`, `'…'`, or backticks is argument text
 * (`npm test -- --grep "issue #123"`), never a comment. Only a `#` at the
 * segment start or preceded by whitespace, OUTSIDE quotes, truncates.
 */
export function stripComment(segment: string): string {
  let quote: QuoteChar | null = null;
  for (let i = 0; i < segment.length; i++) {
    const c = segment[i];
    if (quote !== null) {
      if (quote !== "'" && c === "\\") {
        i++;
        continue;
      }
      if (c === quote) quote = null;
      continue;
    }
    if (c === "\\") {
      i++;
      continue;
    }
    if (isQuoteChar(c)) {
      quote = c;
      continue;
    }
    if (c === "#" && (i === 0 || /\s/.test(segment[i - 1]))) return segment.slice(0, i);
  }
  return segment;
}

/**
 * Strip leading VAR=value assignments so `CI=1 npm test` matches — quote-
 * aware: the VALUE may contain quoted whitespace (`FOO="a b" npm test`), so
 * it is consumed with the same quote semantics as the splitter, not up to
 * the first raw space.
 */
export function stripEnvPrefix(segment: string): string {
  let rest = segment;
  for (;;) {
    const m = rest.match(/^[A-Za-z_][A-Za-z0-9_]*=/);
    if (!m) return rest;
    let i = m[0].length;
    let quote: QuoteChar | null = null;
    while (i < rest.length) {
      const c = rest[i];
      if (quote !== null) {
        if (quote !== "'" && c === "\\") {
          i += 2;
          continue;
        }
        if (c === quote) quote = null;
        i++;
        continue;
      }
      if (c === "\\") {
        i += 2;
        continue;
      }
      if (isQuoteChar(c)) {
        quote = c;
        i++;
        continue;
      }
      if (/\s/.test(c)) break;
      i++;
    }
    rest = rest.slice(i).trimStart();
    if (rest === "") return "";
  }
}

/**
 * A classified test invocation with the position facts exit attribution
 * needs: whether the matched segment is the only command on the line,
 * whether it is the LAST command, and the operator that preceded it.
 */
export interface ClassifiedTestCommand {
  /** The head-matched simple-command segment (comment/env stripped). */
  readonly segment: string;
  readonly isSole: boolean;
  readonly isLast: boolean;
  readonly opBefore: SegmentOp | null;
  /** The operator immediately FOLLOWING the matched segment (null when none):
   *  `&` here means the segment is backgrounded — its exit is never the
   *  line's exit. Computed over the RAW segment list, so a trailing blank
   *  fragment (`npx vitest &`) still reveals the `&`. */
  readonly opAfter: SegmentOp | null;
}

/**
 * Like classifyTestCommand, but keeps the segment's position among the
 * line's commands. Blank and comment-only fragments are not commands and
 * do not count toward positions (a trailing `;` or comment does not demote
 * the test to "not last"); an env-assignment-only segment (`FOO=1`) IS a
 * command — the shell's exit would be the assignment's, not the test's.
 */
export function classifyTestCommandDetailed(command: string): ClassifiedTestCommand | null {
  const raw = splitCommandSegmentsWithOps(command);
  const segments = raw
    .map((s, rawIndex) => ({ text: stripComment(s.text).trim(), opBefore: s.opBefore, rawIndex }))
    .filter((s) => s.text !== "");

  for (let i = 0; i < segments.length; i++) {
    const segment = stripEnvPrefix(segments[i].text);
    if (segment === "") continue; // env-assignment-only: a command, never a test run
    if (hasUnbalancedQuotes(segment)) continue; // fail closed: never classify
    const lower = segment.toLowerCase();
    if (!headMatchesRunner(lower)) continue;
    if (isMavenHead(lower) && !hasMavenTestGoal(lower)) continue;
    return {
      segment,
      isSole: segments.length === 1,
      isLast: i === segments.length - 1,
      opBefore: segments[i].opBefore,
      opAfter: raw[segments[i].rawIndex + 1]?.opBefore ?? null,
    };
  }
  return null;
}

/**
 * The simple-command segment that a test-runner pattern matches at head
 * position, or null when the command is not a test invocation.
 */
export function classifyTestCommand(command: string): string | null {
  return classifyTestCommandDetailed(command)?.segment ?? null;
}

/**
 * Exit-status OWNERSHIP: the harness reports one exit for the whole command
 * line, but only some compositions let the classified test segment claim
 * it. Fail closed to null (= untrusted downstream) whenever ownership is
 * unprovable:
 * - sole segment: the exit is the test's — attribute as-is
 * - not the last segment: the line's exit belongs to a LATER command
 *   (`false && npx vitest …; true` exits 0 without vitest ever running,
 *   `npm test || true` launders a red run) — never attribute
 * - last segment, exit 0: attributable after any operator except `||` —
 *   `&&`, `;`, `|`, and `&` all mean the test ran and the line's exit 0 is
 *   its own, but after `||` exit 0 can mean the guard succeeded and the
 *   test never ran
 * - last segment, nonzero exit: attributable only after `;` or `&` (both
 *   sequence unconditionally — the test definitely ran) — after `&&` the
 *   nonzero exit may be the guard's, with the test never executed
 *   (a wrongly-attributed nonzero would mint a false trusted-fail)
 * - BACKGROUNDED segment (`npx vitest &`): the shell reports exit 0 without
 *   waiting for the test — the line's exit is never the test's, whatever
 *   the position. Always null.
 */
export function attributeExit(exit: number | null, classified: ClassifiedTestCommand): number | null {
  if (exit === null) return null;
  if (classified.opAfter === "&") return null;
  if (classified.isSole) return exit;
  if (!classified.isLast) return null;
  if (exit === 0) return classified.opBefore === "||" ? null : exit;
  return classified.opBefore === ";" || classified.opBefore === "&" ? exit : null;
}

/** Backwards-compatible boolean view of classifyTestCommand. */
export function isTestCommand(command: string): boolean {
  return classifyTestCommand(command) !== null;
}

// --- Bash-authored file writes (redirects, tee) ---

/**
 * Bash's `>&word` (and `n>&word`) is an fd DUPLICATION only when the ENTIRE
 * word is digits (`2>&1`, `>&2`) or exactly `-` (the close form, `>&-`). A
 * word that merely STARTS with a digit but continues into a path
 * (`>&2/../r.json`) is a filename redirect — bash writes the FILE. The
 * round-15 fix checked a single character, misclassifying those writes as
 * dups in BOTH scanners (the guard's hasOutputRedirect and this module's
 * readRedirectTarget); both now share this classifier so their verdicts
 * cannot drift (the full shared-tokenizer refactor stays deferred). Quote
 * and backslash characters do NOT terminate the word: `>&2"foo"` collapses
 * to the filename `2foo` in bash, and a word containing them is never pure
 * digits, so it classifies as a file write (fail-closed).
 * `start` points just past the `&`; `end` is the index just past the word.
 */
export function classifyFdDupWord(
  text: string,
  start: number,
): { readonly isFdDup: boolean; readonly end: number } {
  let end = start;
  while (end < text.length && !/[\s><&|;()]/.test(text[end])) end++;
  const word = text.slice(start, end);
  return { isFdDup: word === "-" || /^[0-9]+$/.test(word), end };
}

/**
 * Read one redirect target starting at `start` (just past the `>`s):
 * skip whitespace, then collect the quote-aware, UNQUOTED word. Fd dups
 * (`2>&1`, `>&-`) and process substitution (`>(…)`) yield no file target;
 * a `>&word` whose word is NOT a whole fd (`>&2/../r.json`) redirects to
 * the FILE `word` and IS collected. Returns the scan position to resume from.
 */
function readRedirectTarget(segment: string, start: number, out: string[]): number {
  let i = start;
  while (i < segment.length && /\s/.test(segment[i])) i++;
  if (i >= segment.length) return i;
  if (segment[i] === "&") {
    const dup = classifyFdDupWord(segment, i + 1);
    // fd dup (2>&1, >&2, >&-): no file is written
    if (dup.isFdDup) return dup.end;
    // `>&word` with a non-fd word: bash redirects stdout+stderr TO THE FILE
    // `word` — fall through and collect it like any other target.
    i++;
  }
  if (segment[i] === "(") return i; // process substitution: no static target
  // The word's literal value comes from the SHARED normalizer, so a target
  // spelled with ANSI-C / a line continuation mints the SAME path the guard
  // sees (twin parity — one place owns the quote/escape/ANSI-C rules). Backtick
  // quotes here so `` >`cmd` `` does not split mid-substitution.
  const { value, end } = normalizeShellSpan(segment, i, { mode: "redirect-word" });
  if (value !== "") out.push(value);
  return end;
}

/** Collect `>`/`>>`/`&>`/`&>>`/`n>`/`n>>` targets in one segment — quote-aware. */
function collectRedirectTargets(segment: string, out: string[]): void {
  let quote: QuoteChar | null = null;
  let i = 0;
  while (i < segment.length) {
    const c = segment[i];
    if (quote !== null) {
      if (quote !== "'" && c === "\\") {
        i += 2;
        continue;
      }
      if (c === quote) quote = null;
      i++;
      continue;
    }
    if (c === "\\") {
      i += 2;
      continue;
    }
    if (isQuoteChar(c)) {
      quote = c;
      i++;
      continue;
    }
    if (c === "&" && segment[i + 1] === ">") {
      i += segment[i + 2] === ">" ? 3 : 2;
      i = readRedirectTarget(segment, i, out);
      continue;
    }
    if (c === ">") {
      i += segment[i + 1] === ">" ? 2 : 1;
      i = readRedirectTarget(segment, i, out);
      continue;
    }
    i++;
  }
}

/** Quote-aware unquoted words of a segment, stopping at the first unquoted
 *  redirect character (`>`, `<`, `&`) — those belong to the redirect scan. */
function wordsBeforeRedirect(segment: string): string[] {
  const words: string[] = [];
  let current = "";
  let quote: QuoteChar | null = null;
  for (let i = 0; i < segment.length; i++) {
    const c = segment[i];
    if (quote !== null) {
      if (quote !== "'" && c === "\\") {
        current += segment[i + 1] ?? "";
        i++;
        continue;
      }
      if (c === quote) {
        quote = null;
        continue;
      }
      current += c;
      continue;
    }
    if (c === "\\") {
      current += segment[i + 1] ?? "";
      i++;
      continue;
    }
    if (isQuoteChar(c)) {
      quote = c;
      continue;
    }
    if (/[><&]/.test(c)) break;
    if (/\s/.test(c)) {
      if (current !== "") {
        words.push(current);
        current = "";
      }
      continue;
    }
    current += c;
  }
  if (current !== "") words.push(current);
  return words;
}

/** Collect `tee [-a] file…` targets in one segment (flags skipped, `--` ends them). */
function collectTeeTargets(segment: string, out: string[]): void {
  const words = wordsBeforeRedirect(stripEnvPrefix(segment.trim()));
  if (words.length === 0) return;
  const head = words[0];
  if (head !== "tee" && !head.endsWith("/tee")) return;
  let flagsDone = false;
  for (const w of words.slice(1)) {
    if (!flagsDone && w === "--") {
      flagsDone = true;
      continue;
    }
    if (!flagsDone && w.startsWith("-")) continue;
    out.push(w);
  }
}

/**
 * Every file path a Bash command line's redirections (`>`, `>>`, `&>`,
 * `n>`, `n>>`) or `tee` invocations write — quote-aware and unquoted, per
 * segment, comments stripped. These mint FileWrite evidence so a report
 * artifact STAGED via Bash (`cat > /tmp/r.json <<EOF …`) is visible to the
 * agent-authored-artifact veto exactly like an Edit/Write would be.
 * Unexpandable targets (`$VAR/…`) are kept as-is: they resolve to paths
 * that match nothing, which only fails closed. Targets are NOT resolved
 * here — consumers normalize with their cwd like every other FileWrite.
 */
export function extractShellWriteTargets(command: string): string[] {
  const targets: string[] = [];
  for (const raw of splitCommandSegments(command)) {
    const segment = stripComment(raw);
    collectRedirectTargets(segment, targets);
    collectTeeTargets(segment, targets);
  }
  return [...new Set(targets)];
}

/** Outcome of a Bash call as reported by the harness at execution time. */
export interface BashOutcome {
  readonly exit: number | null;
  readonly stdout: string;
}

/**
 * Defensively extract exit status + stdout from the harness's tool_response.
 * Field names vary across harness versions; unknown shapes yield exit: null,
 * which downstream treats as untrusted (never as success).
 */
export function extractBashOutcome(toolResponse: unknown): BashOutcome {
  if (typeof toolResponse === "string") return { exit: null, stdout: toolResponse };
  if (typeof toolResponse !== "object" || toolResponse === null) return { exit: null, stdout: "" };

  const o = toolResponse as Record<string, unknown>;
  if (o.interrupted === true) return { exit: null, stdout: "" };

  const exitRaw = o.exit_code ?? o.exitCode ?? o.returnCode ?? o.code;
  const exit = typeof exitRaw === "number" && Number.isInteger(exitRaw) ? exitRaw : null;

  const stdoutRaw = o.stdout ?? o.output;
  const stdout = typeof stdoutRaw === "string" ? stdoutRaw : "";

  return { exit, stdout };
}

function filePathOf(toolInput: Record<string, unknown>): string | null {
  const p = toolInput.file_path ?? toolInput.path;
  return typeof p === "string" && p.trim() !== "" ? p : null;
}

/**
 * Did the harness report this tool call as FAILED? Field names vary across
 * harness versions (`is_error`, `success: false`, an `error` payload) —
 * recognize the known error shapes; unknown shapes count as success so the
 * recorder does not silently starve the ledger on a harness format change.
 */
export function isToolFailure(toolResponse: unknown): boolean {
  if (typeof toolResponse !== "object" || toolResponse === null) return false;
  const o = toolResponse as Record<string, unknown>;
  if (o.is_error === true || o.isError === true) return true;
  if (o.success === false) return true;
  if (typeof o.error === "string" && o.error.trim() !== "") return true;
  if (typeof o.error === "object" && o.error !== null) return true;
  return false;
}

/**
 * Evidence for one tool call — facts only; judgments happen at fold time.
 * Returns [] for tool calls that carry no ground-truth signal (the
 * vocabulary is closed on purpose).
 *
 * FileRead/FileWrite facts mean "the tool SUCCEEDED" — a failed Read/Edit
 * (error-shaped tool_response) mints nothing, so a machine guard can never
 * be satisfied by an attempt. Bash still mints TestRun on error responses:
 * the captured exit status IS the ground truth there (a failing test run is
 * a trusted failure, not a non-event), and a response with no usable exit
 * yields exit: null, which downstream never trusts as success.
 */
export function extractEvidence(
  toolName: string,
  toolInput: Record<string, unknown>,
  toolResponse: unknown,
  findReportForSegment: (
    segment: string,
    stdout: string,
    /** Write targets of THIS command line (raw, unresolved) — the report
     *  lookup must veto them too: a one-call `printf '{…}' > r.json; npx
     *  vitest --outputFile=r.json` stages an artifact the persisted ledger
     *  cannot know about yet. */
    currentCallWrites: readonly string[],
  ) => TestReportSummary | null,
): Evidence[] {
  if (toolName === "Read") {
    if (isToolFailure(toolResponse)) return [];
    const path = filePathOf(toolInput);
    return path ? [{ kind: "FileRead", path }] : [];
  }

  if (FILE_MODIFYING_TOOLS.has(toolName)) {
    if (isToolFailure(toolResponse)) return [];
    const path = filePathOf(toolInput);
    return path ? [{ kind: "FileWrite", path, via: "tool" }] : [];
  }

  if (toolName === "Bash") {
    const command = typeof toolInput.command === "string" ? toolInput.command : "";
    const events: Evidence[] = [];
    // Bash-authored writes (redirects, tee) mint FileWrite regardless of the
    // tool_response shape: the shell opens/truncates a redirect target BEFORE
    // the command runs, so even a failing call wrote the file — and
    // over-minting only ever vetoes or demotes downstream, never vouches.
    // Minted with via: "shell": the PreToolUse gate cannot enforce Bash, so
    // a shell write must never advance a guard the gate is supposed to own
    // (tokensFor skips them) — it still feeds the artifact veto and the
    // modified-after-pass demotion. Ordered BEFORE any TestRun from the same
    // call, so a test command's own `| tee log` / `> log` redirect does not
    // read as "files modified AFTER the pass" and self-demote a trusted
    // verdict.
    const shellWrites = extractShellWriteTargets(command);
    for (const path of shellWrites) {
      events.push({ kind: "FileWrite", path, via: "shell" });
    }
    const classified = classifyTestCommandDetailed(command);
    if (classified !== null) {
      const outcome = extractBashOutcome(toolResponse);
      const report = findReportForSegment(classified.segment, outcome.stdout, shellWrites);
      // The line's exit is attributed to the test segment only when the
      // composition proves ownership (attributeExit) — `false && npx vitest
      // …; true` exits 0 without vitest running, and must not classify as a
      // passing run.
      events.push({
        kind: "TestRun",
        command,
        exit: attributeExit(outcome.exit, classified),
        report,
      });
    }
    return events;
  }

  return [];
}
