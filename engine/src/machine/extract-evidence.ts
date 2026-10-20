/**
 * Map a completed tool call (PostToolUse) to evidence events.
 *
 * Pure given its inputs: the harness adapters (`core/harness-tool-call.ts`)
 * normalize the raw call before it arrives, and the shell supplies report
 * lookup, so this module stays testable without IO. The Bash write targets
 * it mints come from `core/shell-write-targets.ts`.
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
import type { BashToolOutcome, HarnessToolCall } from "./harness-tool-call-types";
import {
  hasUnbalancedQuotes,
  splitCommandSegmentsWithOps,
  stripComment,
  stripEnvPrefix,
  type SegmentOp,
} from "../core/shell-command";
import { scanSubstitutions } from "../core/shell-substitution";
import { extractShellWriteTargets } from "../core/shell-write-targets";
import type { Evidence, TestReportSummary } from "./types";

/** `npx --prefix <dir> vitest …` resolves the runner from `<dir>`'s own
 *  node_modules — the one npx form that runs a sub-project's pinned runner from
 *  outside it (a bare `npx vitest` where no runner is installed runs whatever
 *  the npx cache holds). The option says where the runner lives, not what runs,
 *  so the runner after it classifies. A quoted or substituted directory never
 *  matches (fail closed). */
const NPX_PREFIX_OPTION = /^npx\s+--prefix(?:=|\s+)[^\s'"`$\\]+\s+/;

/** The runner pattern must end at a token boundary: `npm testify` is not `npm test`. */
function headMatchesRunner(lowerSegment: string): boolean {
  const head = lowerSegment.replace(NPX_PREFIX_OPTION, "npx ");
  return (
    TEST_COMMAND_PATTERNS.some(
      (p) => head.startsWith(p) && (head.length === p.length || /\s/.test(head.charAt(p.length))),
    ) || headMatchesPackageRunScript(head)
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
 */
export function extractEvidence(call: HarnessToolCall, findReportForSegment: FindReportForSegment): Evidence[] {
  if (call.tool === "Other") return [];
  if (call.tool === "Bash") return bashEvidence(call.input, call.outcome, findReportForSegment);
  if (call.outcome.kind === "failed") return [];
  const path = editedFilePath(call.input);
  if (path === null) return [];
  return call.tool === "Read" ? [{ kind: "FileRead", path }] : [{ kind: "FileWrite", path, via: "tool" }];
}

/** The reading of a Bash outcome that minting needs: an exit (null when
 *  unknown or killed), the stdout, and whether the harness killed the call. */
type BashRun = Readonly<{ exit: number | null; stdout: string; interrupted: boolean }>;

function bashRun(outcome: BashToolOutcome): BashRun {
  return match(outcome)
    .with({ kind: "exited" }, ({ exit, stdout }) => ({ exit, stdout, interrupted: false }))
    .with({ kind: "exit-unknown" }, ({ stdout }) => ({ exit: null, stdout, interrupted: false }))
    .with({ kind: "interrupted" }, () => ({ exit: null, stdout: "", interrupted: true }))
    .exhaustive();
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
