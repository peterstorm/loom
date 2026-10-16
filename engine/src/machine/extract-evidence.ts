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

import { match } from "ts-pattern";
import { editedFilePath, TEST_COMMAND_PATTERNS } from "../core/tool-vocabulary";
import { claudeBashOutcome, claudeToolCall, isClaudeToolFailure } from "../core/harness-tool-call";
import type { BashToolOutcome, HarnessToolCall } from "./harness-tool-call-types";
import { normalizeShellSpan } from "../core/shell-normalize";
import {
  classifyFdDupWord,
  hasUnbalancedQuotes,
  splitCommandSegments,
  splitCommandSegmentsWithOps,
  stripComment,
  stripEnvPrefix,
  type SegmentOp,
} from "../core/shell-command";
import { isShellQuoteChar, type ShellQuoteChar } from "../core/shell-quoting";
import { scanSubstitutions } from "../core/shell-substitution";
import type { Evidence, TestReportSummary } from "./types";

/** The runner pattern must end at a token boundary: `npm testify` is not `npm test`. */
function headMatchesRunner(lowerSegment: string): boolean {
  return (
    TEST_COMMAND_PATTERNS.some(
      (p) =>
        lowerSegment.startsWith(p) &&
        (lowerSegment.length === p.length || /\s/.test(lowerSegment.charAt(p.length))),
    ) || headMatchesPackageRunScript(lowerSegment)
  );
}

/** Package-manager script runners classify through their SCRIPT NAME, not the
 *  runner head — `npm run test:unit`, `yarn run e2e-tests`, `pnpm run
 *  verify:all` are test runs the plain patterns miss (the pattern boundary
 *  rule dies on the `:` of a scoped script name). The script token must be
 *  test-bearing with word boundaries (the Maven-goal guard's shape):
 *  `contest`, `pretestify`, `attestation` stay unclassified. */
const PACKAGE_RUN_HEADS = ["npm run ", "yarn run ", "pnpm run ", "bun run "] as const;
const TEST_BEARING_SCRIPT_TOKEN = /(?:^|[-_:.@])(?:test|tests|verify)(?:$|[-_:.@])/;

function headMatchesPackageRunScript(lowerSegment: string): boolean {
  const head = PACKAGE_RUN_HEADS.find((p) => lowerSegment.startsWith(p));
  if (head === undefined) return false;
  const scriptToken = lowerSegment.slice(head.length).split(/\s+/, 1)[0] ?? "";
  return scriptToken !== "" && TEST_BEARING_SCRIPT_TOKEN.test(scriptToken);
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
  /** The operator immediately FOLLOWING the matched segment (null when none). */
  readonly opAfter: SegmentOp | null;
  /** Whether the complete pipe chain containing the test is terminated by `&`.
   *  Unlike opAfter, this catches `npm test | tee report.json &`. */
  readonly isBackgrounded: boolean;
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
  // The splitter does not know substitutions: a separator inside `$(…)` or
  // `<(…)` splits the line into "segments" bash never runs at top level, so
  // `echo $(true; npm test >/dev/null) '5 passed'` looked like a test that
  // owned `echo`'s exit and output. When emptying every substitution body
  // changes the segmentation (or a substitution never closes), no segment's
  // position can be trusted, and nothing classifies.
  const blanked = scanSubstitutions(command, () => "");
  if (blanked.unclosed || splitCommandSegmentsWithOps(blanked.rebuilt).length !== raw.length) return null;
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
    const rawIndex = segments[i].rawIndex;
    let afterPipeChain = rawIndex + 1;
    while (raw[afterPipeChain]?.opBefore === "|") afterPipeChain++;
    return {
      segment,
      isSole: segments.length === 1,
      isLast: i === segments.length - 1,
      opBefore: segments[i].opBefore,
      opAfter: raw[rawIndex + 1]?.opBefore ?? null,
      isBackgrounded: raw[afterPipeChain]?.opBefore === "&",
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
  if (classified.isBackgrounded) return null;
  if (classified.isSole) return exit;
  if (!classified.isLast) return null;
  if (exit === 0) return classified.opBefore === "||" ? null : exit;
  return classified.opBefore === ";" || classified.opBefore === "&" ? exit : null;
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
  let quote: ShellQuoteChar | null = null;
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
    if (isShellQuoteChar(c)) {
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
  let quote: ShellQuoteChar | null = null;
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
    if (isShellQuoteChar(c)) {
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

/** The words after a literal `mv`, `cp` or `git mv` head, or null for any
 *  other command. A path-qualified head (`/bin/mv`) is the same command. */
function moveCopyArguments(words: readonly string[]): readonly string[] | null {
  const isHead = (word: string | undefined, name: string): boolean =>
    word !== undefined && (word === name || word.endsWith(`/${name}`));
  if (isHead(words[0], "mv") || isHead(words[0], "cp")) return words.slice(1);
  if (isHead(words[0], "git") && words[1] === "mv") return words.slice(2);
  return null;
}

/** Options of `mv`/`cp` that take a separate value: that value is never a
 *  path operand. `t` / `--target-directory` names the destination directory. */
const VALUE_SHORT_OPTIONS: ReadonlySet<string> = new Set(["t", "S"]);
const VALUE_LONG_OPTIONS: ReadonlySet<string> = new Set(["--target-directory", "--suffix"]);
const TARGET_DIRECTORY_PREFIX = "--target-directory=";

/** Where one source lands inside a destination directory. */
function insideDirectory(directory: string, source: string): string {
  const base = source.replace(/\/+$/, "").split("/").pop() ?? source;
  return `${directory.replace(/\/+$/, "")}/${base}`;
}

/** The operands and `-t` target directory of a `mv`/`cp` argument list. */
function moveCopyOperands(args: readonly string[]): Readonly<{ operands: readonly string[]; targetDirectory: string | null }> {
  const operands: string[] = [];
  let targetDirectory: string | null = null;
  let optionsDone = false;
  for (let i = 0; i < args.length; i++) {
    const word = args[i]!;
    if (optionsDone || word === "-" || !word.startsWith("-")) {
      operands.push(word);
    } else if (word === "--") {
      optionsDone = true;
    } else if (word.startsWith(TARGET_DIRECTORY_PREFIX)) {
      targetDirectory = word.slice(TARGET_DIRECTORY_PREFIX.length);
    } else if (VALUE_LONG_OPTIONS.has(word)) {
      const value = args[++i];
      if (word === "--target-directory" && value !== undefined) targetDirectory = value;
    } else if (!word.startsWith("--")) {
      // A short-option group (`-rt DIR`, `-tDIR`): a value-taking letter
      // consumes the rest of the group, or else the next word.
      const letters = word.slice(1);
      const at = [...letters].findIndex((letter) => VALUE_SHORT_OPTIONS.has(letter));
      if (at !== -1) {
        const rest = letters.slice(at + 1);
        const value = rest !== "" ? rest : args[++i];
        if (letters[at] === "t" && value !== undefined) targetDirectory = value;
      }
    }
  }
  return { operands, targetDirectory };
}

/**
 * Collect the destinations of a literal `mv`, `git mv` or `cp` in one segment
 * (FR-034): the paths the command creates, so a renamed or copied file
 * appears under its NEW path. Options are skipped (`--` ends them), and an
 * option's separate value is never read as a path.
 * - `-t DIR` / `--target-directory[=]DIR`: every operand lands in DIR.
 * - Several sources, or a destination spelled with a trailing `/`: the
 *   destination is a directory, and each source lands inside it.
 * - Otherwise the last operand is the destination path itself.
 * Purely textual: `mv a existing-dir` names `existing-dir` itself, not
 * `existing-dir/a`, which only over-mints. A source is not a write.
 */
function collectMoveCopyTargets(segment: string, out: string[]): void {
  const args = moveCopyArguments(wordsBeforeRedirect(stripEnvPrefix(segment.trim())));
  if (args === null) return;
  const { operands, targetDirectory } = moveCopyOperands(args);
  if (targetDirectory !== null) {
    for (const source of operands) out.push(insideDirectory(targetDirectory, source));
    return;
  }
  if (operands.length < 2) return;
  const destination = operands[operands.length - 1]!;
  const sources = operands.slice(0, -1);
  if (sources.length > 1 || destination.endsWith("/")) {
    for (const source of sources) out.push(insideDirectory(destination, source));
  } else {
    out.push(destination);
  }
}

/**
 * Every file path a Bash command line writes, as far as its text names it:
 * redirections (`>`, `>>`, `&>`, `n>`, `n>>`), `tee` targets, and the
 * destinations of a literal `mv`, `git mv` or `cp` — quote-aware and
 * unquoted, per segment, comments stripped. These mint FileWrite evidence so
 * a report artifact STAGED via Bash (`cat > /tmp/r.json <<EOF …`,
 * `cp staged.json r.json`) is visible to the agent-authored-artifact veto
 * exactly like an Edit/Write would be, and so a renamed file appears among
 * the changed files under its new path (FR-034).
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
    collectMoveCopyTargets(segment, targets);
  }
  return [...new Set(targets)];
}

/**
 * Report discovery for one classified test segment, supplied by the shell.
 * `currentCallWrites` are the write targets of THIS command line (raw,
 * unresolved): the lookup must veto them too, because a one-call
 * `printf '{…}' > r.json; npx vitest --outputFile=r.json` stages an artifact
 * the persisted ledger cannot know about yet.
 */
export type FindReportForSegment = (
  segment: string,
  stdout: string,
  currentCallWrites: readonly string[],
) => TestReportSummary | null;

/**
 * Evidence for one normalized tool call — facts only; judgments happen at
 * fold time. This is the ONE minting rule for both harnesses (INV-4): each
 * harness adapter (`core/harness-tool-call.ts`) normalizes its own event into
 * a `HarnessToolCall`, and the shared shell (`tool-evidence-recorder.ts`) is
 * its only production caller. `Other` tools mint nothing (the vocabulary is
 * closed on purpose).
 *
 * FileRead/FileWrite facts mean "the tool SUCCEEDED" — a `failed` file tool
 * mints nothing, so a machine guard can never be satisfied by an attempt.
 * The path is the input's `file_path` (Claude Code) or `path` (Pi). Bash
 * always mints: its exit status IS the ground truth (a failing test run is a
 * trusted failure, not a non-event), and an unknown exit yields `exit: null`,
 * which downstream never trusts as success.
 *
 * The four-argument form `(toolName, toolInput, toolResponse, find)` is a
 * compatibility adapter over Claude Code's raw hook shape, kept only for the
 * pre-AD-8 unit suite: it normalizes with `claudeToolCall` and applies the
 * same rule. Scheduled for deletion once that suite moves to `HarnessToolCall`.
 */
export function extractEvidence(call: HarnessToolCall, findReportForSegment: FindReportForSegment): Evidence[];
export function extractEvidence(
  toolName: string,
  toolInput: Record<string, unknown>,
  toolResponse: unknown,
  findReportForSegment: FindReportForSegment,
): Evidence[];
export function extractEvidence(
  callOrToolName: HarnessToolCall | string,
  ...rest: [FindReportForSegment] | [Record<string, unknown>, unknown, FindReportForSegment]
): Evidence[] {
  if (typeof callOrToolName !== "string") return mintEvidence(callOrToolName, rest[0] as FindReportForSegment);
  const [toolInput, toolResponse, find] = rest as [Record<string, unknown>, unknown, FindReportForSegment];
  return mintEvidence(
    claudeToolCall({ tool_name: callOrToolName, tool_input: toolInput, tool_response: toolResponse, cwd: "" }),
    find,
  );
}

function mintEvidence(call: HarnessToolCall, findReportForSegment: FindReportForSegment): Evidence[] {
  if (call.tool === "Other") return [];
  if (call.tool === "Bash") return bashEvidence(call.input, call.outcome, findReportForSegment);
  if (call.outcome.kind === "failed") return [];
  const path = editedFilePath(call.input);
  if (path === null) return [];
  return call.tool === "Read" ? [{ kind: "FileRead", path }] : [{ kind: "FileWrite", path, via: "tool" }];
}

/**
 * Outcome of a Bash call in the pre-AD-8 shape. Compatibility only: a thin
 * delegate over `claudeBashOutcome` for the pre-AD-8 unit suite, scheduled
 * for deletion with the four-argument `extractEvidence` form.
 */
export interface BashOutcome {
  readonly exit: number | null;
  readonly stdout: string;
  /** The harness killed this call (timeout/abort); the command never finished. */
  readonly interrupted: boolean;
}

/** The finished-or-not reading of a Bash outcome that minting needs. */
function bashRun(outcome: BashToolOutcome): BashOutcome {
  return match(outcome)
    .with({ kind: "exited" }, ({ exit, stdout }) => ({ exit, stdout, interrupted: false }))
    .with({ kind: "exit-unknown" }, ({ stdout }) => ({ exit: null, stdout, interrupted: false }))
    .with({ kind: "interrupted" }, () => ({ exit: null, stdout: "", interrupted: true }))
    .exhaustive();
}

/** Compatibility delegate over `claudeBashOutcome` (see `BashOutcome`). */
export function extractBashOutcome(toolResponse: unknown): BashOutcome {
  return bashRun(claudeBashOutcome(toolResponse));
}

/** Compatibility delegate over `isClaudeToolFailure` (see `BashOutcome`). */
export function isToolFailure(toolResponse: unknown): boolean {
  return isClaudeToolFailure(toolResponse);
}

function bashEvidence(
  input: Readonly<Record<string, unknown>>,
  bashOutcome: BashToolOutcome,
  findReportForSegment: FindReportForSegment,
): Evidence[] {
  const command = typeof input.command === "string" ? input.command : "";
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
    const outcome = bashRun(bashOutcome);
    const report = findReportForSegment(classified.segment, outcome.stdout, shellWrites);
    // The line's exit is attributed to the test segment only when the
    // composition proves ownership (attributeExit) — `false && npx vitest
    // …; true` exits 0 without vitest running, and must not classify as a
    // passing run.
    //
    // A BACKGROUNDED test segment (`mvn test &`) drops its report too, not
    // just its exit. `judgeTestRun` treats an unknown exit beside a green
    // report as trustworthy — deliberately, because some harnesses report no
    // exit code at all — but that reasoning assumes the report describes a
    // FINISHED run. The shell returns from `&` immediately, so the runner is
    // still writing: surefire has per-class XML for the suites that happen to
    // have completed, every mtime postdates the call, and the merged summary
    // reads `total > 0, failed = 0`. That minted `trusted-pass` on a suite
    // still running, and `applyUntrustedStopResolution` then refused to let
    // any later evidence correct it. `findReport`'s guards bound STALENESS;
    // nothing bounds completeness, so the only honest answer here is no
    // evidence at all.
    //
    // An INTERRUPTED call (harness timeout/abort) breaks the same
    // precondition by the same mechanism — the runner was killed mid-write,
    // so the classes that finished first left a partial-but-green report —
    // and it too arrives here as `exit: null`. Both unfinished cases drop the
    // report; only a run that actually ended may pair one with an exit.
    const unfinished = classified.isBackgrounded || outcome.interrupted;
    events.push({
      kind: "TestRun",
      command,
      exit: attributeExit(outcome.exit, classified),
      report: unfinished ? null : report,
    });
  }
  return events;
}
